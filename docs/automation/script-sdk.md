# Script SDK 面设计（Phase 2，仅设计不含实现）

> 性质：SDK 表面契约设计，对齐 `architecture.md` §1/§2/§5（Script → SDK → Adapter → Playwright/CDP/Electron）与 `security.md` §2/§6/§8（沙箱能力、profile 隔离、指纹门禁）。
> 本文不写实现代码；类型签名为 TS 风格伪代码，Phase 3 由 `automation.d.ts` 落地。

---

## 1. 分层

```
Script（JS 资产，绑定 ScriptVersion）
  │  只 import SDK 全局对象，永不 import Electron 内部 API
  ▼
Browser SDK（本文定义的稳定 API 面 + smart waits + 错误分类）
  ▼
Automation Adapter（main 进程内，单一翻译层）
  ▼
Playwright / CDP（webContents.debugger，allowlist）/ Electron 原生
  ▼
BrowserSession → ProfileContext → Fingerprint Browser → Chromium
```

边界铁律（承接 architecture §1）：

1. 脚本只能见 SDK；SDK 只能走 Adapter；后端三选一由 Runtime 决定，脚本不得指定。
2. 脚本禁止 `require`/`import` Electron、Node 内建（`fs`/`child_process`/`net`/`dgram`）、`process`、裸 CDP 句柄——沙箱强制（§7），不是约定。
3. 指纹变更唯一入口是 `fingerprint.update`（门禁见 §4），SDK 不暴露 `setFingerprintConfig` / `setSSLConfig` / `setUserAgent` / `fromPartition` 直调。

---

## 2. API 面（签名 + 语义）

以下为脚本内可直接使用的全局对象（注入形态见 §3）。所有方法返回 Promise；超时/选择器/网络错误类型见 §6。

### 2.1 browser — 窗口级导航与截图

```ts
interface Browser {
  goto(url: string, opts?: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<void>;
  back(opts?: NavOpts): Promise<void>;
  forward(opts?: NavOpts): Promise<void>;
  reload(opts?: NavOpts): Promise<void>;
  close(): Promise<void>;                         // 关当前 BrowserSession 持有的窗口（disconnect-not-close 由 Session 层决定）
  screenshot(opts?: { path?: string; fullPage?: boolean; format?: 'png' | 'jpeg' }): Promise<Buffer>;
  getCurrentUrl(): Promise<string>;
  getTitle(): Promise<string>;
}
```

语义：导航默认 `waitUntil:'load'`、默认超时继承 Adapter 配置（建议 30s）；`close` 只关当前会话窗口，不销毁 ProfileContext。

### 2.2 page — 元素定位与智能等待

```ts
interface Page {
  // 定位
  locator(selector: string): Locator;

  // 快捷操作（= page.locator(s).click() 等）
  click(selector: string, opts?: ActionOpts): Promise<void>;
  fill(selector: string, value: string, opts?: ActionOpts): Promise<void>;
  type(selector: string, text: string, opts?: ActionOpts & { delay?: number }): Promise<void>;
  press(selector: string, key: string, opts?: ActionOpts): Promise<void>;
  getText(selector: string, opts?: { timeout?: number }): Promise<string>;
  getAttribute(selector: string, name: string, opts?: { timeout?: number }): Promise<string | null>;
  waitForSelector(selector: string, opts?: { state?: 'attached' | 'visible' | 'hidden'; timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;      // 仅供调试，见下方禁令

  // 求值（受限 Runtime-limited：超时 + 返回值截断脱敏，security §4）
  evaluate<T = unknown>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>;

  // smart waits（全部统一到 page.wait）
  waitForVisible(selector: string, opts?: WaitOpts): Promise<void>;
  waitForHidden(selector: string, opts?: WaitOpts): Promise<void>;
  waitForText(selector: string, text: string | RegExp, opts?: WaitOpts): Promise<void>;
  waitForURL(url: string | RegExp, opts?: WaitOpts): Promise<void>;
  waitForNavigation(opts?: NavOpts): Promise<void>;
  waitForNetworkIdle(opts?: { idleMs?: number; timeout?: number }): Promise<void>;
  waitForResponse(urlPattern: string | RegExp, opts?: WaitOpts): Promise<Response>;
  waitForRequest(urlPattern: string | RegExp, opts?: WaitOpts): Promise<Request>;
  waitForFunction(fn: string | ((...args: unknown[]) => boolean), ...args: unknown[]): Promise<void>;

  // 统一入口：page.wait 是上述所有 waitFor* 的唯一实现，waitFor* 是具名糖
  wait(spec: WaitSpec): Promise<void>;
}
```

```ts
type WaitSpec =
  | { selector: string; state: 'attached' | 'visible' | 'hidden' }
  | { text: string | RegExp; selector?: string }
  | { url: string | RegExp }
  | { navigation: true }
  | { networkIdle: { idleMs?: number } }
  | { response: string | RegExp }
  | { request: string | RegExp }
  | { function: string | ((...args: unknown[]) => boolean); args?: unknown[] };
```

**硬性规范（禁 sleep 默认路径）**：`waitForTimeout(ms)` 是显式逃逸口，**禁止作为默认等待策略**——`sleep(5000)` 类固定延时不得出现在发布版 ScriptVersion 中（草稿/Debug 可用）。正确等待一律用 smart waits（基于条件：DOM 态 / 文本 / URL / 网络空闲 / 响应 / 函数）。Runtime 在 lint/审核层对固定延时 > 1000ms 的调用打 warning，retriable 判定不豁免。

### 2.3 element — Locator 实例操作

```ts
interface Locator {
  click(opts?: ActionOpts): Promise<void>;
  fill(value: string, opts?: ActionOpts): Promise<void>;
  type(text: string, opts?: ActionOpts & { delay?: number }): Promise<void>;
  text(): Promise<string>;
  attribute(name: string): Promise<string | null>;
  visible(): Promise<boolean>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
}
```

语义：`locator` 惰性求值，每次操作时重新解析（auto-wait 到可见/可交互，超时抛 `SelectorError`/`TimeoutError`）；`boundingBox` 返回 CSS 像素，null = 未布局/不可见。

### 2.4 cookies / storage / network / download / upload / dialog

```ts
interface Cookies {
  get(filter?: { name?: string; url?: string }): Promise<Cookie[]>;
  set(cookies: Cookie[]): Promise<void>;
  delete(filter: { name?: string; url?: string }): Promise<void>;
  clear(): Promise<void>;                          // 仅当前 ProfileContext partition 作用域
}

interface Storage {
  local:  { get(key?: string): Promise<Record<string, unknown> | unknown>;
            set(items: Record<string, unknown>): Promise<void> };
  session: { get(key?: string): Promise<Record<string, unknown> | unknown>;
             set(items: Record<string, unknown>): Promise<void> };
}

interface Network {
  intercept(pattern: string | RegExp,
            handler: (route: Route) => Promise<void | { body?: Buffer | string; status?: number; headers?: Record<string, string> }>,
            opts?: { times?: number }): Promise<void>;
  waitForRequest(urlPattern: string | RegExp, opts?: WaitOpts): Promise<Request>;
  waitForResponse(urlPattern: string | RegExp, opts?: WaitOpts): Promise<Response>;
}

interface Download {
  wait(pattern: string | RegExp, opts?: WaitOpts): Promise<{ suggestedFilename: string; path: string }>;
  save(target: { suggestedFilename: string; path: string }, destPath: string): Promise<string>; // 围栏校验后落盘
}

interface Upload {
  setFiles(selector: string, files: string[]): Promise<void>;  // 文件路径须在授权目录内（trusted-script 围栏）
}

interface Dialog {
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}
```

语义：cookies/storage 作用域 = 当前 ProfileContext 的 partition（`persist:auto-{profileId}`，persist 化后不跨 profile）；`intercept` 经 CDP Network-read + 路由钩子，默认仅当前 page，改写能力按 capability 授权（§7）；`download.save`/`upload.setFiles` 涉及文件系统，路径必须过围栏，否则 `PermissionError`。

### 2.5 context — ProfileContext（自动注入的当前身份）

```ts
interface ProfileContext {
  readonly profile: {
    id: string;
    name: string;
    groupId: string | null;
    proxy: string | null;
    platform: string;
    browserVersion: string;
    fingerprint: Readonly<FingerprintSnapshot>;   // 只读快照，改走 context.fingerprint.update（§4）
    session: { id: string };
  };

  get(): Promise<ProfileSnapshot>;                // 当前上下文快照（脱敏：无 proxy 密码、无 FP 载体原文）
  update(patch: ProfilePatch): Promise<Result>;   // 走 Profile Manager + 门禁，非直写
  cookies: Cookies;                               // = 全局 cookies（同作用域，别名）
  storage: Storage;
  screenshot(opts?: { fullPage?: boolean }): Promise<Buffer>;
}
```

语义：`context` 是脚本执行时 Runtime 注入的唯一身份句柄；`profile.fingerprint` 只读，任何变更必须 `fingerprint.update`（§4）；`update` 的非指纹字段（name/proxy 等）走 Profile Manager 校验。

### 2.6 params — typed 参数（ScriptParameter 元数据驱动）

```ts
type ParamType = 'string' | 'number' | 'boolean' | 'select' | 'multi-select'
               | 'secret' | 'file' | 'textarea' | 'JSON';   // 9 种，与 store PARAM_TYPES / d.ts 对齐（JSON 大写 canonical）

interface ScriptParameter {
  name: string;                 // 注入为 params[name]
  type: ParamType;
  required?: boolean;
  default?: unknown;
  options?: string[];           // select / multi-select
  secret?: boolean;             // true => 只存引用，日志脱敏，不回显
}

// 脚本内：
declare const params: Record<string, string | number | boolean | string[] | object>;
```

语义：params schema 随 ScriptVersion 冻结；Runtime 在执行前做类型校验（number 拒非数字、select 拒越界、secret 解析为值但永不进日志）；`file` 类型解析为围栏内路径。Monaco 表单据 `ScriptParameter[]` 自动生成（Phase 3）。

---

## 3. ProfileContext 注入

1. Runtime 建 Execution 后，Profile Manager 组装 ProfileContext（显式 `profiles.get(id)` + ACL 检查，security §6），Session Manager 定位/创建 BrowserSession，然后把 `context` 连同 `browser/page/cookies/storage/...` 作为全局注入脚本 Worker。
2. 脚本**自动接收**当前 Profile：`context.profile.*` 即本次执行身份，无需声明。
3. **跨 profile 唯一路径**：`profiles.get(id)`（显式 + 双向 ACL 授权，security §6）返回另一个上下文；禁止隐式跨 profile——脚本拿不到、也枚举不了其他 profile（无 `list()` 遍历敏感字段）。未授权目标一律 `PermissionError`，并写 audit。
4. 同一 Task 的多个 item 不共享 ProfileContext/Session；运行中 Execution 绑定注入时的快照，profile 后续变更不影响进行中的执行。

---

## 4. fingerprint.update 门禁

```ts
// 经 context（或 profiles.get 后的他上下文）暴露，唯一指纹变更入口：
context.fingerprint.update(config: FingerprintConfig, opts?: { bearerToken: string })
  : Promise<{ ok: true; planes: ('blink'|'ua'|'tls'|'h2')[]; restartRequired: boolean }
           | { ok: false; plane?: string; error: string }>;
```

Script API ≠ Browser Fingerprint Runtime：脚本只见 `fingerprint.update` 与只读快照；dict→JSON→b64、`setFingerprintConfig`、TLS/H2/UA 装配、renderer 重建全部在 FingerprintBroker（main）内，脚本不可达。

五道门（security §8，顺序执行，任一失败即拒）：

| 门 | 内容 |
|---|---|
| 1 validate | `fpSplitConfig` 分流 + **schema 校验**：仅接受 `fp-schema.js` 的 63 个 Blink 键（`FP_KEYS`，权威计数以 `check.py EXPECTED_KEYS` 为准）+ TLS 9 键 + H2 3 键；kind 编码严格（`int/int64` 必须 JSON number 且 >0，`str/bool/csv/dims/sp/json` 按 schema），类型错配直接失败不静默 fallback；未知键拒绝或显式丢弃告警 |
| 2 permission | 调用方具 `Profile.Run`+ + 目标 profile ACL 写授权；跨 profile 需双向授权 |
| 3 lifecycle | 目标 tab/group 可重建；H2 构造期冻结、TLS live——能改才改，不能改如实返回 `h2Error`/对应 plane 失败，不谎称成功 |
| 4 restart | `restartRequired: true` 时（Blink 平面变更，需同 partition 重建 renderer 使 `--fingerprint-config` 生效）由 Runtime 统一重建，cookie/storage 按 partition 语义保留或显式清空；API 返回该标志，脚本不得自行重启窗口 |
| 5 log | audit 行：谁、何时、profile id、键集合哈希、五门结果；载体原文（b64/JSON/env）不进日志 |

原子性：任一平面失败 → Broker 回滚旧身份 → 返回 `{ ok:false, plane, error }`，绝不留半切换会话（architecture §4）。

---

## 5. automation.d.ts（Phase 3，Monaco 自动补全）

Phase 3 向 Monaco 提供 `automation.d.ts`，**只声明、不实现**：

```ts
// automation.d.ts — ambient 声明，Monaco addExtraLib 注入
declare const browser: Browser;
declare const page: Page;
declare const context: ProfileContext;
declare const cookies: Cookies;
declare const storage: Storage;
declare const network: Network;
declare const download: Download;
declare const upload: Upload;
declare const dialog: Dialog;
declare const params: Record<string, string | number | boolean | string[] | object>;
// profiles 仅在显式跨 profile 声明的脚本里可用（见 §3）
declare const profiles: { get(id: string): Promise<ForeignProfileContext> };

// 接口全量：Browser / Page / Locator / Cookies / Storage / Network /
// Download / Upload / Dialog / ProfileContext / ScriptParameter / WaitSpec / Error*（§6）
```

约束：`d.ts` 中**不得**出现 Electron/Node 内建类型（`Electron.Renderer`、`NodeJS.Process`、`fs` 等）——补全面即权限面，出现即等于诱导脚本越层。

---

## 6. 错误模型

### 6.1 错误类型

```ts
class ScriptError   extends Error { retriable: boolean; code: string }   // 基类
class TimeoutError  extends ScriptError { retriable: true  }             // 等待/操作超时
class SelectorError extends ScriptError { retriable: boolean }           // 选择器不存在/不匹配/多义
class BrowserError  extends ScriptError { retriable: boolean }           // 窗口/session/导航层故障
class NetworkError  extends ScriptError { retriable: true  }             // 请求失败/断连（经 Adapter 上报）
class PermissionError extends ScriptError { retriable: false }           // RBAC/ACL/沙箱能力/文件围栏拒绝
class ProfileError  extends ScriptError { retriable: false }             // profiles.get 失败/隔离违规/身份组装失败
class DownloadError extends ScriptError { retriable: boolean }           // 下载超时/取消/落盘失败
class UploadError   extends ScriptError { retriable: false }            // setFiles 路径越界/文件不存在
```

- `retriable` 决定状态机：仅 retriable 可进 `RETRYING`（backoff），非 retriable 直接 `FAILED`（gap 附录 A）。
- 每个错误携带 `code`（机器可判）+ `message`（人读）+ `stack`；`PermissionError`/`ProfileError` 必须同时触发 audit 行。
- **retriable 判定口径**：`err.retriable` 显式值优先；无显式值时 Task 层分类基线是 `NetworkError / TimeoutError / DownloadError / UploadError = true`，`BrowserError = false`（与 `task-queue.js RETRIABLE_NAMES` 一致——该集合含 `BrowserError` 是历史宽口，RETRYING→QUEUED 的调度语义不受影响；**`task.md` §5.1 分类表以本条为准，已与实现对齐**）。runner 类构造的默认 `retriable` 以实例为准。

### 6.2 Execution 记录字段

```ts
interface ExecutionRecord {
  id: string;
  scriptVersion: string;      // 不可变版本绑定
  profileId: string;
  startTime: number;          // epoch ms
  endTime: number | null;
  duration: number | null;    // ms
  status: 'CREATED'|'QUEUED'|'RUNNING'|'SUCCESS'|'FAILED'|'CANCELLED'|'RETRYING';   // SUCCESS canonical（实现/DB/指标全集一致）
  error: { type: string; code: string; message: string; retriable: boolean } | null;
  stack: string | null;       // 截断 + 脱敏
  currentUrl: string | null;  // 失败时最后 URL（scrub query 中的 token）
  currentStep: number;        // SDK 调用序号（screenshot/trace 对齐）
}
```

字段随状态机更新；`error/stack/currentUrl` 仅失败终态必填；secret 永不入 `error.message`。

---

## 7. 能力沙箱映射（Capability Map）

```js
// 默认能力集（security §2，最小权限）
{
  browser:    true,      // §2.1 navigation/screenshot/evaluate
  cookies:    'scoped',  // 仅当前 ProfileContext partition
  storage:    'scoped',  // 仅当前 partition local/session
  network:    'allowlist', // https/wss + 域名 allowlist；内网/元数据/非标端口拒
  filesystem: false,     // 默认 deny
  process:    false,     // 默认 deny
  profile:    'self',    // 仅当前 profile；跨 profile 需 profiles.get + ACL
  screenshot: true,      // page/context screenshot
  upload:     'fence',   // 围栏内路径可用，越界 PermissionError
  clipboard:  false      // 默认 deny（未列出的其余能力一律 deny）
}
```

规则：

1. **默认拒绝一切未列出项**；deny 集硬性不可达：`require('child_process'|'fs'|'os'|'net'|'dgram'|'shell')`、裸 `process`、`eval`/`new Function` 动态代码、shell 拼串。
2. **trusted-script opt-in**：`filesystem`/`process` 放宽仅对签名脚本（哈希签名 + 显式授权 + 授权目录围栏 + 审计，缺一不可）；围栏拒绝 `../`、绝对路径逃逸、symlink 跳出。
3. 能力由 host 按任务逐项注入、用完收回（security §3）；Worker 无 DOM、无 Node 全量、无 `window`。
4. `network` 出站策略执行侧强制，不依赖脚本自觉（SSRF 防护）。

---

## 8. AI Agent 预留

- AI Agent 是第三类调用方（architecture §0/§2），**输出同样落为本 SDK 调用序列**：Agent 生成/选择 `browser.*` / `page.*` / `context.*` 调用，经同一 Runtime、同一 Adapter、同一审计执行。
- **不新建控制面**：无 Agent 专属 IPC、无 Agent 专属执行器、无绕过门禁的指纹/代理通道；Agent 侧的步数上限（如 `MAX_ROUNDS=15`）留在 Agent 自身，不进 Runtime 状态机。
- 能力面 = §7 同一 capability map；权限 = 同一 RBAC + profile ACL；Agent 调用方身份在 audit 中单独标识（caller type = `agent`）。

---

## 附：与既有文档的对照

| 本文小节 | 对齐点 |
|---|---|
| §1 分层 | architecture §1 边界规则 1–3、§5 三后端 |
| §2 API 面 | architecture §5 API 全集；gap §1.4（P2/P3 阶段） |
| §3 注入 | architecture §8 步骤 4–5；security §6 |
| §4 门禁 | security §8 五道门；architecture §4 FingerprintBroker；fp-schema 63 键 |
| §5 d.ts | gap §1.1/§2（Monaco + automation.d.ts，P8） |
| §6 错误 | gap 附录 A 状态机；architecture §2 error taxonomy |
| §7 沙箱 | security §2/§3/§4 |
| §8 Agent | architecture §0/§2（同入口、不另建引擎） |
