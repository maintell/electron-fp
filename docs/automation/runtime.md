# Automation Runtime 设计（Phase 1）

> 性质：Phase 1 设计文档，不含实现代码。目标形态见 `architecture.md`；现状证据见 `current-architecture.md`；缺口见 `automation-gap-analysis.md`；安全约束见 `security.md`（本文 CDP 白名单与其 §4 一致）。

---

## 1. BrowserSession 生命周期

### 1.1 状态机

```
created → starting → ready → attached → detaching → closed
                         ↘ crashed ↗（可恢复路径，见 §5）
```

| 状态 | 含义 | 进入条件 | 退出条件 |
|---|---|---|---|
| `created` | 实体已建，未启动 | Session Manager 分配 id + partition | 调用 `start()` |
| `starting` | 建窗口/view、装配四平面（H2→UA→TLS→Blink，沿用 mini-browser 顺序） | `start()` | view 就绪 + 指纹注入完成 |
| `ready` | 窗口存活，尚未挂 CDP | `starting` 成功 | 首次 `attach()` |
| `attached` | debugger 已 attach，命令可发 | attach 成功 | `detach()` / 崩溃 |
| `detaching` | 正在释放 CDP 连接 | `detach()` / `close()` 起点 | detach 完成 |
| `closed` | 终态，资源已释放 | `close()` 完成 | — |
| `crashed` | renderer 崩溃 / 断连 | `targetCrashed` / `disconnected` | §5 恢复成功回 `ready`，失败按 RetryPolicy 终态 |

非法迁移直接拒绝（如 `closed → attached`），拒绝记审计行。

### 1.2 partition = identity

- 一个 BrowserSession 绑定唯一 partition 名；partition 决定 cookie/storage/UA/TLS/H2 作用域，即"身份"。
- partition 一律 `persist:` 前缀（ADR-2）。现状 `fp-tab-*` / `fp-group-*` 无前缀为内存态，`runtime` 侧新建的 session 不复现该缺陷。
- **persist 前缀策略**：
  - automation session → `persist:auto-{profileId}`（按 ProfileContext 派生，重启可恢复）。
  - 临时/探针 session → 无 `persist:` 前缀，进程退出即丢，仅限测试。
  - 同一 ProfileContext 并发多个 session → 显式实例后缀，禁止隐式共享。
- partition 在 `starting` 首次 `fromPartition` 时冻结 H2（现状语义，current §15）；后续改 H2 请求如实拒绝（`h2Error`），不静默丢弃。

### 1.3 disconnect vs close

| 操作 | 语义 | 资源 | 可重连 |
|---|---|---|---|
| `disconnect` | 释放 CDP 连接，窗口/partition 保留（disconnect-not-close） | BrowserSession 保活，状态回 `ready` | 是，外部经 triple-return 的 `wsEndpoint` 可重连 |
| `close` | 终态：关窗口、detach、按策略清理 | session 释放；cookie/storage 按 partition persist 语义决定去留 | 否，需重建（`closed → created` 新实例） |

`close` 默认**保留** partition 数据（persist 语义）；显式 `close({ purge: true })` 才清 cookie/storage（复用缺失中的 clear API，P0 补）。

### 1.4 接入路径：外部 triple-return vs 默认进程内

| | 外部路径（triple-return） | 默认路径（进程内） |
|---|---|---|
| 产出 | `{ cdp, wsEndpoint, webdriver, debug_port }` | `webContents.debugger` 对象直用 |
| 触发 | 仅当外部客户端（Playwright/独立调试器）显式请求 | 所有 SDK → Adapter 调用 |
| 暴露面 | `wsEndpoint` 仅 localhost + token + Host 校验后下发（见 §4） | 不出进程，无网络暴露 |
| `debug_port` | 仅 external 模式存在；Phase 1 默认缺席（ADR-3：不开 `--remote-debugging-port`） | 无 |
| 生命周期 | 随 session 的 `disconnect` 失效，重连需重新取 triple | 随 webContents 销毁失效 |

**Phase 1 决策**：默认路径 = 进程内 `webContents.debugger`；triple-return 是可选外部接入，不是主路径。`debug_port` 字段在 Phase 1 恒为 `null`（保留字段位，启用前须过 §3 门控 + `security.md` §4）。

---

## 2. Adapter 层

### 2.1 后端选择

```
SDK ─→ Adapter ─┬─ webContents.debugger raw CDP   （默认，首选）
                ├─ Playwright connectOverCDP      （外部客户端 / bulk）
                ├─ Puppeteer connect              （兼容预留，Phase 1 不实现）
                └─ --remote-debugging-port        （兜底，Phase 1 默认缺席）
```

选择规则（与 architecture §5 一致）：

1. **默认**：`webContents.debugger` per-window。可审计、可 allowlist、与 session 生命周期同进退、零 TCP 暴露（ADR-3）。
2. 外部 Playwright 客户端接入 → `connectOverCDP` 走 §4 外部 endpoint，仅 localhost + token。
3. Puppeteer `connect`：接口预留，Phase 1 不接（YAGNI——无调用方）。
4. `--remote-debugging-port`：仅显式 opt-in 的调试构建；生产路径缺席。若启用，端口即全 CDP 无鉴权面（current §17），必须额外套 §3 网关。

### 2.2 连接机制（per-window 首选）

- **attach 粒度**：每个 webContents 一个 debugger attach；不共享、不跨窗口复用。
- **flatten 会话**：`Target.attachToTarget { flatten: true }` 取得 `sessionId`，后续命令带 `sessionId` 路由到目标 target。理由：单连接多 target、命令/响应可归因、避免为每个 target 建独立通道。
- **渲染帧重建**：`RenderFrameHostChanged` 触发重连流程——重新 `attachToTarget`、恢复 `sessionId`、重放 `enabledDomains`。导航/进程切换不断会话是硬需求（否则一次跨域导航即断自动化）。
- **命令队列**：每窗口独立队列（见 §6），attach 未完成时命令排队而非失败。
- **pending 表**：`Map<id, {resolve, reject}>`，按 CDP 响应 `id` 匹配；超时/断连时整表 reject（错误进 error taxonomy 的 retriable 判定）。
- **域状态**：`enabledDomains: Set<string>`，记录该窗口当前已 `Domain.enable` 的域；重连后按 Set 重放，不依赖调用方记忆。
- **超时**：`protocolTimeout` 单值可配（默认值 Phase 1 定为 30s），到时 reject pending 并记 system log；不杀窗口。
- **求值**：所有 `Runtime.evaluate` 默认 `awaitPromise: true`（脚本返回 Promise 的场景是主流）；超时按 `protocolTimeout` 截断。求值内容过 §3 scrub。

### 2.3 Adapter 职责边界

- Adapter 只做"SDK 语义 → 后端命令"翻译 + 队列 + 白名单门控；不解释脚本业务、不碰 profile、不改指纹（指纹只走 FingerprintBroker）。
- 后端能力差异如实上报：playwright 后端没有的 Electron 原生命令（partition/TLS/UA）由 Adapter 落到 Electron 后端，不伪造。

---

## 3. CDP 域白名单

### 3.1 白名单（默认拒绝未列出项）

> canonical 口径：以实现 `core.js:33-51` + 测试 `test-core.js` 为准。`security.md` §4 是同一集合的文字表述（含 Storage / Target 发现方法 / Browser.getVersion 只读发现），runtime.md 下表已同步对齐。

| 域 | 级别 | 说明 |
|---|---|---|
| `Page` | 允许 | 导航、快照、生命周期 |
| `DOM` | 允许 | 查询/框选，只读为主 |
| `Input` | 允许 | 交互模拟（点击/键入） |
| `Network` | **只读** | 仅取请求元数据（`getResponseBody`、事件监听）；禁 `setCookie`/`setCacheDisabled` 类改写（改写走 Electron session API） |
| `Runtime` | **受限** | 仅 `evaluate`/`callFunctionOn`，带 `awaitPromise:true` + 超时 + 返回值截断脱敏；禁 `runScript` 类无门控入口 |
| `Target` | **仅 attach+发现** | 只放行 `attachToTarget`/`detachFromTarget`/`setAutoAttach`/`setDiscoverTargets`/`getBrowserContexts`/`getTargets`（外部 CDP 握手所需发现面）；`createTarget`、`attachToBrowserTarget`、`closeTarget` 拒绝 |
| `Storage` | 允许 | Storage 域方法放行（`core.js ALLOW_PREFIX`） |
| `Browser` | **仅只读发现** | 只放行 `Browser.getVersion`（外部 CDP 握手；无控制能力）；`Browser.close` 及其他 `Browser.*` 拒绝 |

### 3.2 拒绝清单（示例，非穷举——不在白名单即拒）

| 方法 | 拒绝原因 |
|---|---|
| `Browser.close` / `Browser.*` | 跨 target 浏览器级控制；`close` 即整体退出（current §17 实测 `Browser.close → Quit`） |
| `Target.createTarget` / `newWindow` | 开新目标越权 |
| `SystemInfo.*` | 读主机信息（T-class 信息收集） |
| `FileSystem.*` | 任意文件读写（`security.md` T7） |
| 任意未列出域 | 默认拒绝 |

### 3.3 门控与审计

- **门控点**：所有 `sendCommand` 入口（Adapter 内唯一 choke point）先过 allowlist 判定，再入队。绕过门控的 debugger 直调禁止（code review 拦截项）。
- **判定规则**：`method` 按 `Domain.method` 解析 → 命中拒绝清单 → 拒；不在允许表 → 拒；Network/Runtime 的方法再过子规则（只读/受限）。拒绝返回结构化错误 `{ ok:false, reason:'allowlist', method }`，记 system log + audit log（`security.md` §9：拒绝动作 system 与 audit 双留痕）。
- **审计行字段**：`sessionId / windowId / method / allow|deny / reason / ts`；不记录 params 原文（可能含页面数据）。
- **scrub（FP 载体）**：`Runtime.evaluate` 的 `expression`、`Page.captureSnapshot`/`Runtime.evaluate` 返回值、以及任何 dump 类产物，落日志/回传前 scrub：
  - `--fingerprint-config=<b64>`
  - `FP_CONFIG_DATA`（原文 JSON）
  - `FP_CONFIG`（路径及其读出内容）
  - `FP_*` 环境变量值
  - 附带：cookie、Authorization、proxy 密码（对齐 `security.md` §4 快照脱敏）
  - scrub 策略：正则命中 → 替换为 `[SCRUBBED:fp-carrier]`；宁可多 scrub 不漏 scrub。

---

## 4. Playwright 兼容（connectOverCDP）

### 4.1 保真度声明（low-fidelity，如实告知）

| 点 | 行为 | 影响 |
|---|---|---|
| 单 BrowserContext | `connectOverCDP` 后通常只见 `contexts()[0]`；不产出多 context | 依赖多 context 隔离的 Playwright 模式不可用 |
| `browser.newContext()` | **禁止/不存在**（外部连接不新建 context） | 身份隔离由已有 partition 承担，不由 Playwright context 承担 |
| `context.close()` | 只断开 Playwright 侧绑定，**不关浏览器/窗口** | close ≠ 销毁 session；session 由本 runtime 的 `close` 管 |
| `browser.close()` | 同上，不断连底层；若底层走外部 endpoint，断开 WS | 防外部客户端误杀宿主（对齐 `security.md`：外部不得 `Browser.close`） |

文档与错误信息必须明示这些差异；不承诺 full-fidelity。版本适配：Playwright 各版本对 CDP 端点期望不同（`/json/version` 的 `webSocketDebuggerUrl` 格式），Phase 1 锁定一个实测版本，版本 notes 记录验证矩阵；其余版本标"未验证"。

### 4.2 外部 endpoint 三重门

外部 `connectOverCDP('http://127.0.0.1:{port}')` 仅在显式启用时存在，且**三个条件全满足**才接受连接：

1. **localhost**：监听 `127.0.0.1`（不绑 `0.0.0.0`）。
2. **token**：按 session/任务签发的短期 token，握手校验（query 或 header）；缺失/过期拒绝。
3. **Host check**：`Host` 头必须为 `127.0.0.1:{port}` / `localhost:{port}`，其余（DNS rebinding 面）拒绝。

三门任一失败 → 拒 + audit 行。endpoint 输出走 triple-return 的 `wsEndpoint`，不进日志明文（token 部分 scrub）。

---

## 5. 崩溃恢复

### 5.1 触发信号

- `disconnected`（debugger 断开）
- `detached`（target 主动脱离）
- `targetCrashed`（renderer 崩溃）
- 看门狗：队列内命令 pending 超时且无响应 → 判定疑似假死，走同一流程。

### 5.2 恢复流程

```
1. save state      持久化当前窗口/导航状态（url、viewport、enabledDomains、队列快照）
2. kill residual   杀残留 renderer/view（防僵尸占用 partition）
3. relaunch        按 partition + ProfileContext 重建窗口（persist: 身份自动恢复）
4. re-attach       重新 debugger attach + Target.attachToTarget flatten
5. re-enable       按 enabledDomains Set 重放 enable
6. re-navigate     恢复 save state 中的 url（不恢复页面内存态）
7. RetryPolicy     失败则按退避重试；超限 → session 置 crashed/终态 + 告警
```

- 步骤 3 重建必须走 mini-browser 四步顺序（H2→UA→TLS→Blink），否则混合身份（B2）。
- 恢复期间入队命令**保留**（队列不清），re-navigate 完成后冲刷；超 `protocolTimeout` 累计上限的命令 reject。
- 每步失败记 audit 行（对齐 crash recovery 7 步的可观测要求，gap 附录 B）；重试次数进 RetryPolicy，不无限重试。

### 5.3 RetryPolicy（Phase 1 占位语义）

- retriable：崩溃、断连、超时、网络类 CDP 错误 → 走恢复流程，指数退避。
- non-retriable：allowlist 拒绝、参数校验失败、partition 冻结冲突（H2）→ 直接失败，不重试（与 error taxonomy 的 retriable-vs-not 对齐）。
- 具体退避数值与上限归 Phase 4 Queue/Worker 定；Phase 1 只保证"分类正确、不静默吞错"。

---

## 6. 状态机 + 队列

### 6.1 Session 状态机与命令队列的关系

- 每个 partition / 每个窗口一条独立命令队列（不跨窗口共享——跨窗口排序无语义且拖慢）。
- 状态机非 `attached` 时入队的命令等待状态推进；到 `closed` / `crashed(终态)` 时整队 reject（`session closed` 错误）。
- 队列单调：同窗口内命令按入队序发出（CDP 本身并发，但 automation 语义要求 click→assert 有序）；跨窗口无序。

### 6.2 并发信号量（Phase 4 占位）

```
Semaphore { limit }   // 占位：Phase 1 不实现，接口预留
acquire() → release()
```

- 目的：Phase 4 Queue/Worker 引入"同一身份不并行写"与全局并发上限时，队列层只需接 semaphore，不改 Adapter 接口。
- Phase 1：`limit = ∞`（等效无限制），仅留接口点。**不写配置项**（值当前不变，YAGNI——真需要上限时再补配置）。

---

## 7. 接口边界（Script Runtime Phase 2）

### 7.1 Phase 2 Script Runtime **可以**调用

| 能力 | 经由 | 约束 |
|---|---|---|
| Browser / Page 导航、快照、点击、输入 | SDK → Adapter → CDP（白名单内） | allowlist 全程生效 |
| Cookie / Storage 读写（scoped） | SDK → Electron session 后端 | 仅本 ProfileContext 作用域 |
| Network 只读观测 | SDK → CDP Network-read | 不改请求 |
| 有限 `Runtime.evaluate` | SDK → CDP Runtime-limited | awaitPromise + 超时 + scrub |
| 下载/上传/对话框（Phase 3 起） | SDK → 适配后端 | 各自能力门控 |
| `profiles.get(id)` 显式取 profile | Profile Manager | 禁止枚举遍历敏感字段 |

### 7.2 Phase 2 Script Runtime **禁止**触碰

| 项 | 原因 |
|---|---|
| 原生 Electron API（`require('electron')`、`app`、`session.*` 直调、`BrowserWindow` 构造） | 越过 Adapter/门控 = 绕过 allowlist 与审计（T8） |
| `webContents.debugger` 原始对象直用 | 同上；debugger 常驻 main-only（architecture §3 铁律），永不桥接 renderer/preload |
| `setFingerprintConfig` / `setSSLConfig` / `setUserAgent` / `fromPartition(http2Profile)` 直调 | 指纹只走 FingerprintBroker（ADR 边界规则 2） |
| `child_process` / `fs` / `net` / `dgram` / `shell` / 裸 `process` | sandbox 默认 deny（`security.md` §2） |
| `eval` / `new Function` 动态代码 | 默认 deny |
| 开 `--remote-debugging-port`、绑非 localhost 端口 | 暴露无鉴权 CDP 面（ADR-3） |
| 跨 ProfileContext 访问 partition/cookie | T10；必须显式 get + 双向 ACL |
| 直接写 env（`FP_CONFIG*`） | env 通道默认关闭（ADR-5），指纹只走 Broker |

**边界原则**：Runtime 只能说 SDK 语言；Adapter 之下三后端由 Runtime 选，不由脚本指定（architecture §1 边界规则 1）。脚本要 Electron 独有能力（partition/TLS/UA）→ 提为 SDK 面方法，由 Adapter 落 Electron 后端，不把原生对象递给脚本。

---

## Phase 1 验收清单

| # | 验收项 | 通过标准 |
|---|---|---|
| 1 | BrowserSession start/stop | `created→starting→ready→close→closed` 全迁移可走通；非法迁移（如 `closed→ready`）被拒绝并记审计行 |
| 2 | debugger attach | `ready→attach→attached` 成功；`Target.attachToTarget { flatten:true }` 取得 `sessionId`；断开后 pending 表整表 reject、队列保留 |
| 3 | Playwright `connectOverCDP` smoke | 单测试：外部客户端经 localhost + token + Host 三门接入，`contexts()[0]` 可见、`page.goto` 成功、`close()` 不关底层窗口 |
| 4 | allowlist deny 测试 | 对 `Browser.close`、`Target.createTarget`、`SystemInfo`、`FileSystem` 各发一次 → 全部拒绝、返回 `reason:'allowlist'`、system+audit 双留痕；同时对 `Page.navigate` 发一次 → 放行（防"全拒"假通过） |
| 5 | FP scrub（附加） | `Runtime.evaluate` expression 含 `FP_CONFIG_DATA` 片段 → 日志中该片段被替换为 `[SCRUBBED:fp-carrier]` |

前置依赖（不在本文实现，验收时需具备）：IPC sender-check、`persist:` partition、白名单门控的单一 choke point。缺任一项，验收 1/4 不算过。

### Phase 1 执行记录（2026-09-24）

| # | 结果 | 证据 |
|---|---|---|
| 1 状态机 start/stop | ✅ 纯逻辑级通过 | `automation/test-core.js` 16 PASS（合法/非法迁移含 `closed` 终态），Idle 优先级复跑 exit=0 |
| 2 debugger attach | ✅ mock 级通过 | `automation/test-browser-session.js` 20 PASS（attach 失败留 `ready`、detach 后拒发、崩溃→`recover()`），真实 Electron attach 未跑（见缺口） |
| 3 Playwright `connectOverCDP` smoke | ⛔ 未跑 | 仓库无 `playwright` 依赖（node_modules 无、各 package.json 无）；且前置三门（token/Host/端口）未建。缺口记入 gap-analysis P1 |
| 4 allowlist deny | ✅ mock 级通过 | Browser.close / SystemInfo / FileSystem / Target.createTarget 全拒 + `Page.navigate` 放行（防全拒假通过）+ audit 断言；`reason` 字段当前为 Error message 而非结构化 `{reason:'allowlist'}`，P1 对齐 |
| 5 FP scrub | ✅ mock 级通过 | expression 含 `FP_CONFIG_DATA` → 拒 `fp carrier scrub`；其余串参数 redact `[scrubbed]`（实现取了更严的拒绝语义，比日志替换强一档） |

代码：`automation/runtime/core.js`(87) + `browser-session.js`(114) + 两测试。前置三项（IPC sender-check / persist partition / 单一 choke point）仍未建 → 验收 1/4 按清单口径记“部分”，完整通过挪到 choke point 落地后。
