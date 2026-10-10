# Automation 目标架构（Target Architecture）

> 性质：目标设计，不描述现状。现状证据见 `docs/automation/current-architecture.md`；缺口见 `docs/automation/automation-gap-analysis.md`。本文件只定目标形态、组件边界、数据流、生命周期与关键 ADR。

---

## 0. 目标总图（§38）

```
Script / RPA / AI Agent
        │  同一入口：代码资产（JS）或 RPA→AST，AI Agent 为第三类调用方
        ▼
Shared Automation Runtime（main 进程）
  ┌──────────────────────────────────────────────┐
  │ Managers: Automation / Script / Task /       │
  │           Profile / Session                  │
  │ FingerprintBroker（原子切换 + Bearer 门控）  │
  │ Scheduler → Queue → Worker → Runtime         │
  │ Service Layer（REST / WS / CLI 同一层）      │
  └──────────────────────────────────────────────┘
        │  SDK → Adapter → Playwright / CDP / Electron
        ▼
BrowserSession → ProfileContext → Fingerprint Browser → Chromium
```

文字链（规范表述）：

**Script / RPA / AI Agent → Shared Automation Runtime → SDK / AST → Playwright / CDP → BrowserSession → ProfileContext → Fingerprint Browser → Chromium**

- `Script`：可版本化 JS 代码资产（Monaco + `automation.d.ts` + typed params）。
- `RPA`：录制/编排产物，先转 AST，再进同一 Runtime（不另建执行引擎）。
- `AI Agent`：预留在同一 Runtime 的调用方（MClient `agent/engine.js` 只算雏形，不直接复用为执行器）。
- `Fingerprint Browser`：指纹四平面（Blink b64 / UA / TLS / H2）已编排好的 Electron Chromium。
- `Chromium`：底层渲染/网络栈，不直接暴露给脚本。

---

## 1. 分层与组件边界

| 层 | 组件 | 职责 | 不做的事 |
|---|---|---|---|
| 调用方层 | Script / RPA→AST / AI Agent | 表达意图（代码 / 流程图 / 模型决策） | 不直接碰 BrowserView、session、partition |
| 运行时层 | Shared Automation Runtime（main） | 唯一执行点：调度、状态机、注入 ProfileContext、门控指纹更新 | 不在 renderer 执行任何脚本逻辑 |
| 接口层 | SDK → Adapter | SDK 给脚本稳定 API（Browser/Page/Element/Cookie/Storage/Network/Download/Upload/Dialog）；Adapter 翻译到 Playwright / CDP / Electron 三后端 | SDK 不感知 partition 名、b64、H2 冻结等底层细节 |
| 会话层 | BrowserSession / ProfileContext | Session = 窗口/连接生命周期（持久化，disconnect-not-close）；ProfileContext = 身份（指纹+UA+TLS+H2+proxy+cookie/storage 作用域）自动注入脚本 | ProfileContext 不持久化执行状态；Session 不解释脚本语义 |
| 浏览器层 | Fingerprint Browser → Chromium | 承载渲染与指纹生效 | 不做任务排队、重试、审计 |

边界规则：

1. 脚本只能见 SDK；SDK 只能走 Adapter；Adapter 之下三选一（Playwright / CDP / Electron），由 Runtime 按能力选择，不由脚本指定。
2. 指纹变更只走 `FingerprintBroker`（§4），任何直调 `setFingerprintConfig` / `setSSLConfig` / `setUserAgent` / `fromPartition(http2Profile)` 的新代码一律禁止。
3. 外部（REST / WS / CLI / Playwright `connectOverCDP`）只走 Service Layer（§7），不直调 Manager。

---

## 2. 调用链展开

```
Script (JS, 绑定 ScriptVersion)
  │  params 快照（含 secret 引用，不含明文）
  ▼
SDK (Browser/Page/Element/...) + automation.d.ts 类型
  │  smart waits / error taxonomy / screenshot-trace 钩子
  ▼
Adapter（同一接口，三后端）
  ├─ Playwright：bulk / 跨语言兼容 / connectOverCDP 对外
  ├─ CDP：首选 webContents.debugger（见 ADR-3），Page/DOM/Input/Network-read/Runtime-limited
  └─ Electron：session / WebContents 原生能力（导航、UA、TLS、partition）
        ▼
BrowserSession（定位到哪个窗口/连接）
        ▼
ProfileContext（自动注入：fingerprint.update 门控后的身份）
        ▼
Fingerprint Browser（四平面已生效）→ Chromium
```

- `SDK→Adapter→Playwright/CDP/Electron`：SDK 方法签名稳定，Adapter 负责把一次 SDK 调用扇出到恰当后端。例如 `page.click` 首选 CDP Input，`storage.clear` 走 Electron session，bulk 跨会话操作走 Playwright。
- `RPA→AST`：RPA 节点编译为与手写 Script 相同的 AST，之后路径完全一致（同一 Runtime、同一 SDK、同一审计）。
- `AI Agent`：作为第三类调用方，输出同样落为 SDK 调用序列；`MAX_ROUNDS=15` 这类步数上限保留在 Agent 侧，不污染 Runtime 状态机。

---

## 3. Main 侧 Managers（Renderer 不执行）

五个 Manager 全部常驻 main 进程：

| Manager | 职责 | 现状对应 |
|---|---|---|
| Automation | Runtime 总控：加载 ScriptVersion、建 Execution、驱动状态机（附录 A）、接 Scheduler/Queue/Worker | 新建（现状无 Execution 实体） |
| Script | Script / ScriptVersion / Parameter / Template（含 marketplace metadata reserved 字段） | 新建（现状只有散落探针脚本） |
| Task | AutomationTask / Queue states（queued/running/done/failed/cancelled）、批量/并发、retry backoff、crash recovery 7 步 | 新建（现状无 task/queue/worker） |
| Profile | ProfileContext 组装：`fpSplitConfig` 分流、validate、proxy 装配、显式 `profiles.get(id)`、secret 引用解析 | 复用 `fpSplitConfig` + MClient proxy/login；重构 persist 化 |
| Session | BrowserSession 生命周期：创建/重建 view、partition 归属、disconnect-not-close 持久连接、bulk 操作 | 复用 Client/MClient 生命周期与 mini-browser 四步顺序 |

铁律：

- **Renderer 只做 UI**（现有 `preload.js` invoke-only 形态保留）。脚本执行、debugger attach、指纹切换永不进 renderer/preload。
- `debugger` 常驻 main-only（现状风险：`electron_api_debugger.cc` 无鉴权全字符串转发；目标用 allowlist 收敛，见 §10）。
- IPC 补 `sender-check + URL gate`（现状零校验，`Client/main.js:499-665` 全部忽略 `e`），这是多租户的前提（P0）。

---

## 4. FingerprintBroker（原子切换 + Bearer 门控）

问题来源：Blink b64（WC > Session，`electron_browser_client.cc:697-709`）+ UA（先于 view 构造）+ TLS（先于首 socket）+ H2（`fromPartition` 首调冻结）四平面各自独立，中途切换产生混合身份（gap B2）。

Broker 语义：

```
fingerprint.update(profileId | fullConfig, bearerToken)
  1. 鉴权：Bearer 必检，失败直接拒绝（审计记一行）。
  2. 门控：非白名单键拒绝（未知键 warn 并丢弃，沿用 tab:set-fingerprint 诚实上报风格）。
  3. 分流：fpSplitConfig → blink / tls / h2 三平面（复用 Client/fp-schema.js:979）。
  4. 编排（沿用 mini-browser 顺序 H2→UA→TLS→Blink）：
     - H2 可变？否 → 如请求改 H2 且 partition 已存在，返回 h2Error（诚实拒绝，不静默丢弃）。
     - UA + TLS 装配到 session（TLS 类型预检 fpTlsValidateTypes 保留）。
     - Blink 经 setFingerprintConfig（WC 优先，缺席继承 Session；electron_api_session.cc:1171-1209）。
     - 同一 partition 重建 renderer，使 --fingerprint-config 生效（复用 recreateTabView 同 partition 语义）。
  5. 原子性：任一平面失败 → 回滚到旧身份 + 返回 { ok:false, plane, error }；绝不留下半切换会话。
```

- `setFingerprintConfig` 的 dict→JSON→b64 编码（`electron_api_session.cc:1195-1203`）保留在 Broker 之下，上层只传对象。
- Env 通道（`FP_CONFIG*`）默认关闭（ADR-5）；Broker 是启用后的唯一可信入口。

---

## 5. SDK → Adapter → Playwright / CDP / Electron

```
                 ┌─ Playwright（bulk / 外部兼容 / connectOverCDP）
SDK ─── Adapter ─┼─ CDP over webContents.debugger（首选，见 ADR-3）
                 └─ Electron 原生（session / partition / UA / TLS / 导航）
```

- SDK API 面（目标全集）：Browser / Page / Element / Cookie / Storage / Network / Download / Upload / Dialog + smart waits + error taxonomy（retriable-vs-not 决定 backoff）+ screenshot / trace。
- Adapter 选择原则：能走 CDP 的走 CDP（可审计、可 allowlist）；只有 Electron 有的（partition、TLS、UA、proxy、session 级操作）走 Electron；bulk/跨会话/外部 Playwright 客户端走 Playwright。
- CDP 方法 allowlist（收敛现状无鉴权转发）：允许 Page / DOM / Input / Network-read / Runtime-limited；拒绝 Browser / Target.create / SystemInfo；不开 TCP 端口；MCP 只走 stdio。

---

## 6. Scheduler → Queue → Worker → Runtime

```
Scheduler（cron，时区感知，重叠策略 skip/queue/parallel）
  │  到期 → 按幂等键入队（手动触发/暂停同入口）
  ▼
Queue（queued / running / done / failed / cancelled）
  │  并发上限 + profile 隔离约束（同一身份不并行写）
  ▼
Worker（local 先行；remote 只留同一接口 + 心跳）
  │  心跳超时 → crash recovery 7 步（gap 附录 B）
  ▼
Runtime（Automation Manager 驱动 Execution 状态机，见附录 A）
```

- 状态机：`CREATED → QUEUED → RUNNING → (SUCCESS | FAILED | CANCELLED) → RETRYING → QUEUED`；仅 retriable 进 RETRYING（backoff），`CANCELLED` 为终态。`SUCCESS` 为 canonical（实现 `script-runner/task-queue/metrics` + `database.md` §5 CHECK 全用 `SUCCESS`）。
- DB 表（SQLite 先行，按 100k executions / 1M logs 预留索引与归档预案）：`scripts / script_versions / params / templates / executions / logs / tasks / task_items / schedules / workers / variables / audit`。
- Worker 本地缓冲沿用 jsonl 格式（复用 MClient agent 日志形态），落库前为缓冲，落库后以表为准。

---

## 7. 外部入口：REST / WS / CLI → 同一 Service Layer

```
REST (localhost) / WebSocket / CLI / Playwright connectOverCDP
                        │
                        ▼
              Service Layer（同一层）
        ┌─────────┬──────────┬──────────┐
        ▼         ▼          ▼          ▼
    Automation  Script    Task     Profile/Session
     Manager   Manager   Manager     Managers
```

- REST 网关只绑 `127.0.0.1` + Host/Origin 校验 + triple-return + 持久 sessions（disconnect-not-close）+ bulk + audit（gap §3.3）。
- WS 与 CLI 为同一 Service 的不同传输，不各建逻辑；CLI 为 WS/REST 的薄封装。
- Playwright `connectOverCDP` 兼容挂在 Service 之外、Adapter 之上：外部 Playwright 客户端经 CDP 接入已由 Session 持有的窗口，不绕过 ProfileContext 隔离。

---

## 8. 数据流（一次执行的端到端）

1. 用户在 Monaco 写 Script → 存草稿 → 发布 ScriptVersion（不可变快照，params schema 随版冻结）。
2. 调度（cron 到期 / 手动 / REST / CLI）→ Task + params 快照（secret 只存引用）→ Queue。
3. Worker 领 Task → Runtime 建 Execution（绑定 scriptVersion + params 快照 + worker id）。
4. Profile Manager 组装 ProfileContext（`profiles.get(id)` 显式获取，隔离检查通过）→ Session Manager 定位/创建 BrowserSession（`persist:` partition，见 ADR-2）。
5. FingerprintBroker 确保身份生效（新建或原子切换）→ ProfileContext 注入 SDK。
6. SDK 调用经 Adapter 执行；三级日志（系统/执行/审计）全程关联 execution id；secret 永不进日志（脱敏）。
7. 结束：状态机终态 → screenshot/trace 归档 → audit 行 → Queue 推进。

---

## 9. 生命周期

- 进程：`whenReady → setupIPC + Service listen + Scheduler 恢复（crash recovery 7 步）+ createMainWindow`；`window-all-closed → quit`（沿用 Client/MClient 现状语义）。
- Session：创建（首 `fromPartition` 冻结 H2）→ 存活（disconnect-not-close，可被 WS/REST 重连）→ 显式销毁（cookie/storage 清理 API，现状缺失，P0 补）。
- Profile：CRUD（沿用 `profile:*` IPC 语义）→ 版本无关（profile 改即生效新 Execution，运行中 Execution 绑定快照不受影响）。
- Script：草稿 → 发布（不可变）→ 执行必须绑定版本 → 回滚即指向上一个 Version。
- Execution：随状态机流转，终态后日志归档（100k/1M 预案），params 快照保留可复现。

---

## 10. 横切关注点

- **authN / Z**：REST/WS Bearer；FingerprintBroker 独立 Bearer；CDP allowlist + main-only；IPC sender-check + URL gate；RBAC（P9）+ secret vault（secret 落库加密、日志脱敏，复用 MClient safeStorage 思路上移到 vault 接口）。
- **Partition 隔离**：目标语义 = 每 ProfileContext 一隔离域。Client per-tab（`fp-tab-*`）与 MClient per-group（`fp-group-*`）在 shared core 之前保持两套 Session 实现（ADR-4），P0 只统一加 `persist:` + data-dir 可配置，不碰合并。
- **可观测性**（附录 C 必答题为验收标准）：任一 execution 3 跳定位 version + params 快照 + worker；P99 排队/执行时长/重试率面板；secret 不可 grep；crash 7 步每步有审计行；100k/1M 下列表 <500ms。

---

## 11. 关键 ADR

| 编号 | 决策 | 理由 |
|---|---|---|
| ADR-1 | 复用 Browser/Profile/Fingerprint 生命周期 + `fpSplitConfig` 分流 | 三份 `fp-schema.js` 已验证行为；raw profile 直传丢 TLS/H2 是实测教训（current §24），绕过即回归 |
| ADR-2 | partitions 一律 `persist:` + data-dir 可配置 | 现状 `fp-tab-*` / `fp-group-*` 无前缀 = 内存态，重启丢会话（current §12）；mini-browser `persist:sdk-mini` 是唯一正确生产样板 |
| ADR-3 | CDP 首选 `webContents.debugger`，不开 TCP `--remote-debugging-port` | TCP 端口即全 CDP 无鉴权面（`devtools_manager_delegate.cc:63-80`）；debugger 可收敛到 allowlist 且与 Session 生命周期同进退 |
| ADR-4 | Client / MClient抽 shared core，但禁止 naive merge | per-tab 与 per-group partition 语义互斥（gap B1）；P0 只抽纯函数（`fpSplitConfig`/validate、proxy/login），会话合并放到 P4 之后 |
| ADR-5 | Env 通道（`FP_CONFIG*`）默认关闭；启用须 HMAC 签名信封 | 任意进程可写 env 即注入（gap §4）；且 `FP_<key>` 仅 27 Int 有效、36 String 无效，`FP_CONFIG` 有前导空白陷阱——默认关闭消掉整个风险面 |
| ADR-6 | 租户隔离是架构属性，不是配置项（见 §12） | IPC 零校验 + 权限默认放行 + 无导航守卫三开口不堵，任何上层 RBAC 都是摆设；P0 先修三开口 |

---

## 12. 租户隔离（架构级）

- 隔离单位 = ProfileContext（身份 + partition + proxy + storage 作用域），不是窗口、不是 tab。
- 强制点：`profiles.get(id)` 显式获取 + 越权拒绝；同一 Task 的 items 不跨 ProfileContext 共享 Session；secret 按 ProfileContext 作用域解析。
- 底层依赖（P0 必修，否则隔离无意义）：IPC sender-check + URL gate；permission deny-list（替代默认 allow-all，`electron_permission_manager.cc` 无 handler 即 GRANTED）；`setWindowOpenHandler` / `will-navigate` 导航守卫（现状双缺失）。
- 审计：跨租户拒绝、指纹切换、secret 访问、session 接管（crash recovery 第 2/6 步）全部进 audit 表。

---

## 附录：现状证据索引（只读，不重复论证）

- IPC 20 handler 与零校验：`Client/main.js:499-665`。
- Group view 与组共享 partition：`MClient/main.js:482-513`。
- 指纹注入 WC > Session：`shell/browser/electron_browser_client.cc:697-709`。
- `setFingerprintConfig` dict→JSON→b64：`shell/browser/api/electron_api_session.cc:1171-1209`。
- `fpSplitConfig` 唯一分流点：`Client/fp-schema.js:979` 起；TLS 9 键 / H2 3 键。
- 生命周期与持久化缺口、权限默认放行、无导航守卫：见 `current-architecture.md` §11–§13、§16、§18。
