# Script Sandbox（用户脚本沙箱）

> 范围：用户脚本的威胁定位、能力模型、执行位置与边界诚实声明。对齐 `security.md` §2（能力模型）、`script-sdk.md` §7（能力映射）、`automation-gap-analysis.md`（现状与缺口）。本文只定边界与约束，不写实现代码。

---

## 1. 威胁定位

用户脚本 = **用户提供代码**，不是内部代码。Sandbox 是核心边界，不是辅助加固。

| 攻击面 | 来源 | 说明 |
|---|---|---|
| 用户脚本本身 | 用户提交的 Script 资产 | 半信任（团队内），仍可能含恶意逻辑或被污染的第三方片段 |
| 普通网页 XSS | 被测页面 | 与脚本无关，但脚本经 `page.evaluate` 触达页面时，页面内容可反向影响脚本数据流 |
| 恶意 Script import | 被篡改的依赖/导入片段 | Script 是可版本化资产，导入内容同样按用户提供代码处理 |
| Agent 注入 prompt→code | AI Agent 生成的调用序列 | Agent 是第三类调用方（`architecture.md` §0/§2），其输出落为同一 SDK 调用序列，不豁免任何门禁 |

对立面不是"防自己人"，是：即便脚本完全恶意，也只能落在能力模型允许的格子里。

---

## 2. Capability 模型

| capability | 控制对象 | 默认 | 备注 |
|---|---|---|---|
| browser | 导航/截图/受限 evaluate | 开（`true`） | 经 SDK → Adapter → CDP 白名单（`security.md` §4） |
| cookies | 当前 partition cookie | 开（`scoped`） | 仅当前 ProfileContext partition，不跨 profile |
| storage | 当前 partition local/session | 开（`scoped`） | 同上 |
| network | 出站请求 | 开（`allowlist`） | https/wss + 域名 allowlist；内网/元数据/非标端口拒；执行侧强制，不依赖脚本自觉 |
| profile | 身份访问 | 开（`self`） | 仅当前 profile；跨 profile 需 `profiles.get(id)` + 双向 ACL |
| screenshot | 截图落盘/回传 | 开（`true`） | 落盘路径过围栏；产物脱敏（`security.md` §4） |
| upload | `setFiles` 文件路径 | 开（`fence`） | 围栏内路径可用，越界 `PermissionError` |
| clipboard | 剪贴板 | 关（`false`） | 默认 deny（`script-sdk.md` §7） |
| filesystem | 文件读写 | 关（`false`） | **仅 `trusted===true` 才解闸**；哈希签名 + 显式授权 + 围栏 + 审计，缺一不可 |
| process | 子进程/shell | 关（`false`） | **仅 `trusted===true` 才解闸**；同上四项缺一不可 |
| eval / new Function | 动态代码执行 | **永关** | 不以 trusted、参数开关、debug 模式绕过 |
| env `FP_*` 通道 | 指纹 env 注入 | **永关（ADR-5）** | 任意进程可写 env 即注入面；指纹只走 FingerprintBroker + `fingerprint.update` 五道门 |

规则（承接 `security.md` §2）：

- 默认 deny 一切未列出项。
- trusted-script 只放宽 `filesystem`/`process` 到声明的最小目录与只读/只写位；**不放开** `env`/`eval`/CDP 直通（见 §7）。
- `require`/`import` Electron、Node 内建（`fs`/`child_process`/`net`/`dgram`/`shell`）、裸 `process`：沙箱强制不可达，不是约定。

---

## 3. 执行位置

```
用户脚本 (JS 资产，绑定 ScriptVersion)
  ▼
Automation Runtime（main 进程）
  │  node:vm 上下文（显式 allowlist 全局，见 §5）
  │  capability 由 host 按任务逐项注入、用完收回
  ▼
SDK → Adapter → CDP / Electron
```

- **main 进程 Automation Runtime → `node:vm` 上下文**：脚本执行点唯一在 main 侧 Runtime（`architecture.md` §3 铁律）。
- **Renderer 永不执行脚本**：renderer 只做 IDE 编辑/展示/触发；脚本源码执行权、Worker/vm 句柄均不进 renderer/preload。
- **Script Runtime 与 Web Page Runtime 隔离**：脚本跑在 vm 上下文，被测页面跑在 renderer 进程。二者双向隔离——脚本只能经受控 `browser/*` SDK 操作页面，不能直连页面 CDP、不能 `executeJavaScript` 任意串、不能读页面进程内存；页面内容也不能拿到 vm 上下文句柄。

---

## 4. vm 边界诚实声明（ponytail ceiling）

`node:vm` **不是硬安全边界**。

- 同进程：vm 上下文与宿主共享进程内存，存在已知逃逸路径（经构造器链、原型逃逸等拿到宿主引用）。vm 提供的是**能力裁剪 + 减少误用面**，不是对抗完全恶意代码的隔离。
- 当前威胁模型 = **团队内 / 半信任脚本**：假定脚本作者不会主动写逃逸 exploit，但即使写了恶意逻辑，也只能落在 §2 能力格子内（无 fs/process/env/eval）。
- 升级路径：Electron `utilityProcess` 或 `worker_threads` + 消息传递 + 结构化克隆（数据经 structured clone，不共享对象引用，宿主原型不可达）。
- 触发条件：**对外发布脚本市场 / 运行陌生人脚本**。届时当前 vm 方案不足，必须切进程/线程级隔离，不能靠加固 vm 继续撑。

---

## 5. 注入面

vm 上下文**显式 allowlist 全局**，不继承宿主：

| 类别 | 注入项 |
|---|---|
| 语言内置 | `JSON` `Math` `Date` `URL` `Promise` `structuredClone` |
| SDK 全局 | `browser` `page` `context` `cookies` `storage` `network` `download` `upload` `dialog` `params`（`script-sdk.md` §5；`profiles` 仅显式跨 profile 声明时可用） |
| 错误类 | `ScriptError` `TimeoutError` `SelectorError` `BrowserError` `NetworkError` `PermissionError` `ProfileError` `DownloadError` `UploadError` |

约束：

- **无继承宿主**：`require`、`process`、`module`、`globalThis` 宿主引用、Electron API 一律不在注入清单。
- `codeGeneration: { strings: false, wasm: false }`：`eval`/`new Function`/动态 wasm 编译关死（与 §2 永关一致）。
- `params` / `context` **冻结**（`Object.freeze`，深冻结敏感快照）：运行中不可被脚本改写以影响门控判定或日志记录。

---

## 6. 防护清单勾选

| # | 威胁（`security.md` T 类） | 防护 | 状态 |
|---|---|---|---|
| 1 | XSS → main 接管（T1） | renderer 永不执行脚本；IPC sender-check + URL gate | ☑ 已落地：Client 20+ 通道 + MClient 37 通道 `checked()` 外层门 + automation 桥 allowlist 内层门 + 双导航守卫 + permission deny-list |
| 2 | RCE（T2） | `process`/`child_process` 默认 deny；仅 trusted 解闸白名单 API | ☑ 默认关 + trust 真签名门（store trust()/untrust()，版本钉选） |
| 3 | 原型污染（T3） | 入沙箱前清洗 `__proto__/constructor/prototype`；冻结合并目标。**vm 内污染不影响宿主**：`node:vm` 每个 context 有独立的 `Object.prototype`（新 V8 context，不共享宿主原型），脚本内 `Object.prototype.x=1` 污染的是 vm 自己的原型，宿主与 SDK 注入对象不受影响；跨 boundary 传参仍走结构化数据 + 清洗 | ☑ 已落地：`cleanInput`（runner）+ store `validateParameters` 边界清洗 + 参数名保留字拒绝（`test-script-runner.js` T3） |
| 4 | 路径遍历（T4） | `filesystem` 默认 deny；trusted 围栏拒绝 `../`、绝对路径、symlink 跳出 | ☑ 已落地：upload/download fence（`browser-api.js checkPath`，fail-closed；`test-browser-api.js` 围栏块） |
| 5 | 命令注入（T5） | `process` 默认 deny；无 shell 拼串入口 | ☑ 默认关（模型层） |
| 6 | SSRF（T6） | `network` allowlist，执行侧强制（内网段/元数据/非标端口拒），不依赖脚本自觉 | ☐ 设计已定，执行侧强制待 P3（network 仍只读观测 + intercept 改写未接） |
| 7 | 任意文件读写（T7） | `filesystem:false` + upload/download 围栏 | ☑ 已落地（围栏见 #4） |
| 8 | IPC 升级（T8） | **renderer 永不持有**脚本执行权与 debugger 句柄；vm 在 main，无 renderer 提权路径 | ☑ 架构铁律 + 双层 sender 门已落地 |
| 9 | token 泄漏（T9） | 日志 redact：secret 不入 `error.message`/日志；FP 载体 scrub（`[SCRUBBED:fp-carrier]`）；执行日志三元组分离 | ☑ 已落地：secret 名+值双 scrub（console/instrument/error.stack；`test-script-runner.js` secret 块）+ 收集器门口二次脱敏（`test-audit-log.js`） |
| 10 | Cookie 泄漏（T9/T10） | cookies/storage 作用域 = 当前 partition（scoped），不跨 profile | ☑ 模型层已定 |
| 11 | 跨 Profile（T10） | 显式 `profiles.get(id)` + 双向 ACL；无 `list()` 枚举敏感字段 | ☐ 设计已定，ACL 待 P0/P6 |

---

## 7. trusted-script 模式

- **显式标记**：`trusted === true`，按脚本哈希签名 + 显式授权（Admin 才能改 trusted 名单，`security.md` §7），**不是**参数开关。
- **仍留审计**：解闸动作、围栏拒绝、每次 fs/process 调用记 system + audit 双留痕（`security.md` §9）。
- **放开的白名单 API**：`filesystem`（声明目录 + 只读/只写位围栏）、`process`（参数化调用，禁 shell 拼串）——仅此两类，且按签名声明的最小集。
- **不放开**：`env`（`FP_*` 永关，ADR-5）、`eval`/`new Function`（永关）、CDP 直通（仍走 Adapter allowlist，trusted 不加宽域集合）。

---

## 8. 测试锚点

目标文件：`automation/test-script-runner.js`（**已落地**，实现 `automation/runtime/script-runner.js`，实跑 **31 PASS**；输出遵循 `PASS`/`FAIL`/`SKIP` 前缀约定，同 `automation/test-core.js` 风格）。

| # | 用例 | 预期断言 |
|---|---|---|
| 1 | allowlist 全局可用 | 注入上下文内 `JSON.parse`/`Math.max`/`new Date()`/`structuredClone`/`Promise` 正常执行 |
| 2 | 宿主全局不可达 | `typeof require === 'undefined'`、`typeof process === 'undefined'`、`typeof module === 'undefined'` |
| 3 | codeGeneration 关 | `eval('1')` 与 `new Function('return 1')` 均抛 `EvalError`/`SyntaxError`（codeGeneration.strings=false） |
| 4 | fs/process deny | 脚本内引用 `fs`/`child_process`/`net` → `ReferenceError` 或 `PermissionError`；默认能力集 `filesystem===false && process===false` |
| 5 | env FP_* 永关 | 上下文无 `FP_CONFIG*` 读写面；`process.env` 不可达（ADR-5） |
| 6 | params/context 冻结 | `Object.isFrozen(params)===true`；脚本尝试 `params.x=1` 失败（严格模式）或不生效，`context.profile` 不可改写 |
| 7 | vm 内原型污染不影响宿主 | 脚本执行 `({}).polluted === undefined` 于 vm 内为 false（污染 vm 自身原型），宿主 `({}).polluted === undefined` 保持 true |
| 8 | 入沙箱清洗 | 恶意 params 含 `__proto__` 键 → 清洗后丢弃，宿主合并目标原型未被改写 |
| 9 | codeGeneration wasm 关 | 脚本内动态 `WebAssembly.compile` 不可用或抛错（codeGeneration.wasm=false） |
| 10 | 错误类注入 | 脚本内 `new TimeoutError('x') instanceof ScriptError === true`；`PermissionError` 带 `retriable===false` |

---

## 附：与既有文档的对照

| 本文小节 | 对齐点 |
|---|---|
| §1 威胁定位 | `security.md` §1 T1–T10；`architecture.md` §0（Agent 第三类调用方） |
| §2 能力模型 | `security.md` §2；`script-sdk.md` §7 capability map；ADR-5（`architecture.md` §10） |
| §3 执行位置 | `architecture.md` §3 铁律（Renderer 不执行）；`script-sdk.md` §1 分层 |
| §4 vm 诚实声明 | `security.md` §3（Worker 隔离目标）；升级路径对齐 gap-analysis 阶段规划 |
| §5 注入面 | `script-sdk.md` §5 `automation.d.ts` 全集；§6 错误类型 |
| §6 防护清单 | `security.md` §1 T1–T10 逐项；§4 scrub；§9 日志 |
| §7 trusted-script | `security.md` §2 规则 2–3、§7 RBAC（Admin 管名单） |
| §8 测试锚点 | `automation/test-core.js` 输出约定；gap-analysis §1.1/§1.4（Script/Runtime 缺口） |

---

## Phase 2/3 执行记录（2026-09-24，Idle 复跑）

| 产物 | 结果 | 证据 |
|---|---|---|
| `automation/runtime/script-store.js` | ✅ 11 PASS | `test-script-store.js` exit=0：9 参数类型、export/import、软删、JSON 持久化 |
| `automation/runtime/script-runner.js` | ✅ 31 PASS | `test-script-runner.js` exit=0：含 §8 全表断言 + vm 逃逸（process deny-proxy / require 未定义 / Function codegen 关） |
| `automation/runtime/automation-manager.js` | ✅ 7 PASS | `test-automation-manager.js` exit=0：并发上限 fail-fast、cancel、版本钉选、分页 newest-first |
| `automation/automation.d.ts` | ✅ 380 行 | §2 方法面 spot-check 5/5；`ParamType='JSON'` 对齐 store（文档小写处以 store 为准） |
| `Client/renderer/automation-panel/` | ✅ 语法过 + 已嵌入 | `node --check panel.js` exit=0；bridge 契约见 panel.js 头注释；**Wave16 起以右侧列加法接入真 Client**（`Client/renderer/{index.html,app.js,style.css}`，见 acceptance §2；`Client/test-automation-panel.js` 19 PASS） |

§8 上表 10 条为设计期预期，实现期实际断言以 31 PASS 清单为准（多出 vm 逃逸与 trusted 闸细化）。
