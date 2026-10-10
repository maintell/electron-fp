# 06 · Script SDK 规格（Script SDK Specification）

> 性质：研究交付件。**整合/改写**既有已核验设计（`docs/automation/script-sdk.md` + `automation/automation.d.ts`），非另立新 API。
> 权威口径：类型签名以 `automation/automation.d.ts`（453 行 ambient 声明）为准；语义以 [../automation/script-sdk.md](../automation/script-sdk.md) 为准。**本文不新增方法**。
> 上游：[00-executive-summary.md](./00-executive-summary.md)；架构：[05-system-architecture.md](./05-system-architecture.md)；待决项：[11-open-questions.md](./11-open-questions.md)。

---

## 1. SDK 设计目标

| 目标 | 说明 |
|---|---|
| 稳定面 | 脚本只 import 注入的全局对象，永不 import Electron/Node 内建；SDK 方法签名稳定，后端由 Runtime 选（Playwright/CDP/Electron）。 |
| 权限面 | `automation.d.ts` **即权限面**：`d.ts` 中不得出现 Electron/Node 内建类型（`Electron.Renderer`、`NodeJS.Process`、`fs` 等），出现即诱导越层（`script-sdk.md` §5）。 |
| 可等待 | 所有方法返回 Promise；默认拒绝固定 sleep，smart waits 为唯一默认等待策略。 |
| 可分类 | 9 类错误 + `CancelledError`，`retriable` 决定是否进 `RETRYING`。 |
| 可审计 | 参数 secret 脱敏、指纹载体 scrub、每次调用入 execution 日志。 |

---

## 2. 命名空间清单（与 `automation.d.ts` 一致）

`automation.d.ts` 声明的注入全局（15 个）：

| 全局 | 类型 | 权限键（`PermissionKey`） | 注入条件 | as-built 注入 |
|---|---|---|---|---|
| `browser` | `Browser` | `browser` | `permissions.browser` | ✅（子集） |
| `page` | `Page` | `browser` | 同 browser | ✅（子集） |
| `context` | `AutomationContext` | —（自动注入） | 恒注入（身份句柄） | ⚠️ 仅 `{ profile }` 冻结对象 |
| `cookies` | `CookieManager` | `cookies` | `permissions.cookies` | ✅ |
| `storage` | `StorageManager` | `storage` | `permissions.storage` | ✅ |
| `network` | `NetworkManager` | `network` | `permissions.network` | ✅（子集） |
| `download` | `DownloadManager` | —（未列 `CAP_KEYS`） | 目标：download 能力 | ⚠️ 未注入 vm |
| `upload` | `UploadManager` | `upload` | `permissions.upload` | ✅ |
| `dialog` | `DialogManager` | —（未列 `CAP_KEYS`） | 目标：dialog 能力 | ⚠️ 未注入 vm |
| `params` | `Readonly<Record<string, unknown>>` | — | 恒注入 | ✅（`cleanInput` 冻结） |
| `profiles` | `ProfilesApi` | `profile` | 显式跨 profile 脚本 | ⚠️ 未注入 vm |
| `console` | `ScriptConsole` | — | 恒注入 | ✅（`makeConsole`） |
| `step` | `(name: string) => void` | — | 恒注入 | ✅ |
| `filesystem` | `unknown` | `filesystem` | bit=true **且** `trusted` | ⚠️ 默认 `denyProxy` |
| `process` | `unknown` | `process` | bit=true **且** `trusted` | ⚠️ 默认 `denyProxy` |

> as-built 注入点：`runtime/script-runner.js`（`sandbox` 构造，行 384–435）。`CAP_KEYS = ['browser','cookies','storage','network','filesystem','process','profile','screenshot','upload','clipboard']`。`context`/`profiles`/`download`/`dialog` 的完整 d.ts 语义为目标面，见 §7 delta。

---

## 3. 各命名空间详表

> 通用约定：**超时** 默认 `timeoutMs=30000`（`script-runner.js`/`executor.js` 默认值）；协议层 `protocolTimeout=30s`（`runtime.md` §2.2）。各 `opts.timeout` 覆盖默认。**并发**：所有调用返回 Promise；同 `ProfileContext`（partition=identity）天然串行；CDP 每窗口独立有序队列。**适用上下文**：`browser`/`page`/`network`/`download`/`upload`/`dialog` 绑定当前 `BrowserSession`；`context`/`cookies`/`storage`/`screenshot` 亦存在于跨 profile 的 `ForeignProfileContext`。

### 3.1 `browser` — 窗口级导航与截图

| 方法 | 参数 | 返回 | 超时 | 异常 | 说明 |
|---|---|---|---|---|---|
| `goto(url, opts?)` | `url: string`；`opts?: NavOpts{timeout?, waitUntil?}` | `Promise<void>` | 默认 30s，`waitUntil` 默认 `'load'` | `BrowserError` / `TimeoutError` / `NetworkError` | 主导航 |
| `back(opts?)` / `forward(opts?)` / `reload(opts?)` | `opts?: NavOpts` | `Promise<void>` | 同上 | 同上 | 历史/重载 |
| `close()` | — | `Promise<void>` | — | `BrowserError` | 关当前会话窗口；**不销毁 ProfileContext** |
| `screenshot(opts?)` | `ScreenshotOpts{path?, fullPage?, format?:'png'\|'jpeg'}` | `Promise<Uint8Array>` | 默认 30s | `BrowserError` / `PermissionError` | 返回 Buffer；as-built 经 `page.screenshot` base64→Buffer |
| `getCurrentUrl()` | — | `Promise<string>` | 默认 30s | `BrowserError` | |
| `getTitle()` | — | `Promise<string>` | 默认 30s | `BrowserError` | |

`type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle'`；`interface NavOpts { timeout?: number; waitUntil?: WaitUntil }`。

### 3.2 `page` — 元素定位与智能等待

| 方法 | 参数 | 返回 | 超时 | 异常 | 说明 |
|---|---|---|---|---|---|
| `locator(selector)` | `selector: string` | `Locator` | — | — | 惰性求值 |
| `click(selector, opts?)` | `ActionOpts{timeout?}` | `Promise<void>` | `opts.timeout` | `SelectorError` / `TimeoutError` | auto-wait 可见/可交互 |
| `fill(selector, value, opts?)` | `value: string` | `Promise<void>` | 同上 | 同上 | |
| `type(selector, text, opts?)` | `opts?: ActionOpts & {delay?}` | `Promise<void>` | 同上 | 同上 | 逐字 |
| `press(selector, key, opts?)` | `key: string` | `Promise<void>` | 同上 | 同上 | |
| `getText(selector, opts?)` | `opts?: {timeout?}` | `Promise<string>` | 同上 | `SelectorError` / `TimeoutError` | |
| `getAttribute(selector, name, opts?)` | `name: string` | `Promise<string \| null>` | 同上 | 同上 | |
| `waitForSelector(selector, opts?)` | `opts?: {state?:'attached'\|'visible'\|'hidden'; timeout?}` | `Promise<void>` | `opts.timeout` | `SelectorError` / `TimeoutError` | |
| `waitForTimeout(ms)` | `ms: number` | `Promise<void>` | — | — | **调试专用逃逸口**；禁止作默认等待（`script-sdk.md` §2.2 硬规则） |
| `evaluate<T>(fn, ...args)` | `fn: string \| ((...args)=>T)` | `Promise<T>` | 默认 30s | `ScriptError` / `TimeoutError` | Runtime-limited：超时 + 返回值截断脱敏 |
| `waitForVisible(selector, opts?)` | `WaitOpts{timeout?}` | `Promise<void>` | `opts.timeout` | `SelectorError` / `TimeoutError` | smart wait 糖 |
| `waitForHidden(selector, opts?)` | 同上 | `Promise<void>` | 同上 | 同上 | |
| `waitForText(selector, text, opts?)` | `text: string \| RegExp` | `Promise<void>` | 同上 | 同上 | |
| `waitForURL(url, opts?)` | `url: string \| RegExp` | `Promise<void>` | 同上 | `TimeoutError` | |
| `waitForNavigation(opts?)` | `opts?: NavOpts` | `Promise<void>` | 同上 | `TimeoutError` | |
| `waitForNetworkIdle(opts?)` | `opts?: {idleMs?; timeout?}` | `Promise<void>` | 同上 | `TimeoutError` | |
| `waitForResponse(urlPattern, opts?)` | `urlPattern: string \| RegExp` | `Promise<Response>` | 同上 | `NetworkError` / `TimeoutError` | |
| `waitForRequest(urlPattern, opts?)` | 同上 | `Promise<Request>` | 同上 | 同上 | |
| `waitForFunction(fn, ...args)` | `fn: string \| ((...args)=>boolean)` | `Promise<void>` | 默认 30s | `TimeoutError` | |
| `wait(spec)` | `WaitSpec` | `Promise<void>` | `spec.timeout` | `TimeoutError` | **统一入口**，所有 `waitFor*` 是其具名糖 |

`WaitSpec` 联合（`automation.d.ts:24-32`）：`selector+state` / `text` / `url` / `navigation:true` / `networkIdle` / `response` / `request` / `function`，各自可带 `timeout`。

### 3.3 `context` — ProfileContext（当前身份句柄）

| 成员 | 类型/签名 | 返回 | 超时 | 异常 | 说明 |
|---|---|---|---|---|---|
| `profile` | `ProfileInfo`（readonly） | — | — | — | `id/name/groupId/proxy/platform/browserVersion/fingerprint/sessionId` |
| `get()` | `() => Promise<ProfileSnapshot>` | 脱敏快照（无 proxy 密码/无 FP 载体原文） | 默认 30s | `ProfileError` | |
| `update(patch)` | `(patch: ProfilePatch) => Promise<ProfileUpdateResult>` | `{ok:true,...}` \| `{ok:false,error,...}` | 默认 30s | `ProfileError` / `PermissionError` | 走 Profile Manager + 门禁，**非直写** |
| `cookies` | `CookieManager` | — | — | — | 当前 profile 作用域（= 全局 `cookies` 别名） |
| `storage` | `StorageManager` | — | — | — | 当前 partition local/session |
| `screenshot(opts?)` | `(opts?: {fullPage?}) => Promise<Uint8Array>` | Buffer | 默认 30s | `BrowserError` | |

**指纹变更唯一入口**：`context.profile.fingerprint.update(config, opts?)` → `Promise<FingerprintUpdateResult>`（`{ok:true, planes, restartRequired}` | `{ok:false, plane?, error}`）。门禁五道门见 [05-system-architecture.md](./05-system-architecture.md) §8.4；脚本不可达 `setFingerprintConfig` / TLS/H2/UA 装配 / renderer 重建。

### 3.4 `cookies` — Cookie 管理

| 方法 | 参数 | 返回 | 超时 | 异常 | 并发/上下文 |
|---|---|---|---|---|---|
| `get(filter?)` | `CookieFilter{name?, url?}` | `Promise<Cookie[]>` | 默认 30s | `BrowserError` | 当前 partition |
| `set(cookies)` | `Cookie[]` | `Promise<void>` | 默认 30s | `BrowserError` / `PermissionError` | |
| `delete(filter)` | `CookieFilter` | `Promise<void>` | 默认 30s | `BrowserError` | |
| `clear()` | — | `Promise<void>` | 默认 30s | `BrowserError` / `PermissionError` | **仅当前 ProfileContext partition**；as-built 需 `electronSession.clearStorageData` |

`interface Cookie { name; value; url?; domain?; path?; secure?; httpOnly?; expires? }`。

### 3.5 `storage` — 分区存储

| 成员 | 方法 | 参数 | 返回 | 超时 | 异常 |
|---|---|---|---|---|---|
| `local` | `get(key?)` | `key?: string` | `Promise<Record<string,unknown> \| unknown>` | 默认 30s | `BrowserError` |
| `local` | `set(items)` | `Record<string,unknown>` | `Promise<void>` | 默认 30s | `BrowserError` / `PermissionError` |
| `session` | `get(key?)` / `set(items)` | 同上 | 同上 | 同上 | 同上 |

作用域 = 当前 ProfileContext partition；不跨 profile。

### 3.6 `network` — 只读观测与路由钩子

| 方法 | 参数 | 返回 | 超时 | 异常 | 说明 |
|---|---|---|---|---|---|
| `intercept(pattern, handler, opts?)` | `pattern: string \| RegExp`；`handler: (route: Route) => Promise<void \| RouteFulfill>`；`opts?: {times?}` | `Promise<void>` | 默认 30s | `NetworkError` / `PermissionError` | 默认仅当前 page；改写能力按 capability 授权 |
| `waitForRequest(urlPattern, opts?)` | `urlPattern: string \| RegExp` | `Promise<Request>` | `opts.timeout` | `NetworkError` / `TimeoutError` | |
| `waitForResponse(urlPattern, opts?)` | 同上 | `Promise<Response>` | 同上 | 同上 | |

`Route{abort(); continue(); fulfill(response?)}`；`RouteFulfill{body?; status?; headers?}`。CDP Network 为**只读**域（`core.js:gateCdpMethod`），改写走 Electron session API。

### 3.7 `download`

| 方法 | 参数 | 返回 | 超时 | 异常 | 说明 |
|---|---|---|---|---|---|
| `wait(pattern, opts?)` | `pattern: string \| RegExp` | `Promise<DownloadItem{suggestedFilename, path}>` | `opts.timeout` | `DownloadError` / `TimeoutError` | |
| `save(target, destPath)` | `target: DownloadItem`；`destPath: string` | `Promise<string>` | 默认 30s | `DownloadError` / `PermissionError` | 路径须过围栏，否则 `PermissionError` |

### 3.8 `upload`

| 方法 | 参数 | 返回 | 超时 | 异常 | 说明 |
|---|---|---|---|---|---|
| `setFiles(selector, files)` | `selector: string`；`files: string[]` | `Promise<void>` | 默认 30s | `UploadError` / `PermissionError` | 路径须在授权目录（trusted-script 围栏）；越界 `PermissionError` |

as-built 围栏：`electron/browser-api.js:checkPath`（无授权目录即 fail-closed；拒 `\0`/越界）。

### 3.9 `dialog`

| 方法 | 参数 | 返回 | 超时 | 异常 |
|---|---|---|---|---|
| `accept(promptText?)` | `promptText?: string` | `Promise<void>` | 默认 30s | `BrowserError` / `TimeoutError` |
| `dismiss()` | — | `Promise<void>` | 默认 30s | `BrowserError` / `TimeoutError` |

### 3.10 `params` — typed 参数（ScriptParameter 驱动）

`declare const params: Readonly<Record<string, unknown>>`。`ScriptParameter`：

| 字段 | 类型 | 约束 |
|---|---|---|
| `name` | `string` | 注入为 `params[name]`；保留名 `__proto__`/`constructor`/`prototype` 拒（`script-store.js:38`） |
| `type` | `ParamType` | 9 型：`'string'\|'number'\|'boolean'\|'select'\|'multi-select'\|'secret'\|'file'\|'textarea'\|'JSON'`（`JSON` 大写 canonical） |
| `required` | `boolean` | 必填 |
| `default?` | `unknown` | 缺省值 |
| `options?` | `string[]` | **仅** select / multi-select 必填非空；其他类型禁止 |
| `secret?` | `boolean` | true ⇒ 只存引用、日志脱敏、永不回显 |

校验：`script-store.js:coerceParam`（number 拒非有限数、select 拒越界、boolean 拒非布尔、JSON 须对象）。`secret` 名称与值在 runner 内进 `secretNames`，渲染串一律 `***`（`script-runner.js:scrubSecrets`）。

### 3.11 `profiles` — 显式跨 profile

| 方法 | 参数 | 返回 | 超时 | 异常 | 说明 |
|---|---|---|---|---|---|
| `get(id)` | `id: string` | `Promise<ForeignProfileContext>` | 默认 30s | `ProfileError` / `PermissionError` | **唯一**跨 profile 路径；双向 ACL；未授权一律 `PermissionError` + audit |

`ForeignProfileContext extends AutomationContext`：跨 profile 可读 `profile`、`get()`、`update()`、`cookies`、`storage`、`screenshot()`；**不含** `page`/`browser`（导航仍绑当前会话）。无 `list()`，不可枚举其他 profile。

### 3.12 `console` / `step`

| 全局 | 方法 | 说明 |
|---|---|---|
| `console` | `log/info/warn/error/debug(...args)` | 入 execution 日志；字符串过 secret scrub；live 经 `onLog`→`automation:event` 推面板 |
| `step` | `step(name: string): void` | 标记 `currentStep` + info 日志；协作式中断在此抛 `CancelledError` |

### 3.13 `filesystem` / `process`（默认 deny）

| 全局 | 默认 | 放开条件 |
|---|---|---|
| `filesystem` | `denyProxy('filesystem')`（任意属性/调用抛 `PermissionError`） | `permissions.filesystem === true` **且** store-level `trusted === true`（签名 + 显式授权 + 围栏 + 审计，缺一不可） |
| `process` | `denyProxy('process')` | 同上（`permissions.process` + `trusted`） |

`trustResolver(scriptId)` 在 wired 模式优先；resolver 失败 = deny，**永不 fail-open**（`script-runner.js:414-429`）。

---

## 4. 错误分类表与 retriable 集合

| 错误类 | `code` | `retriable`（类默认） | 触发场景 | audit 强制 |
|---|---|---|---|---|
| `ScriptError`（基类） | `SCRIPT` | `false` | 脚本逻辑/参数校验失败 | 否 |
| `TimeoutError` | `TIMEOUT` | `true` | 等待/操作超时 | 否 |
| `SelectorError` | `SELECTOR` | `false` | 选择器不存在/不匹配/多义 | 否 |
| `BrowserError` | `BROWSER` | `false` | 窗口/session/导航层故障 | 否 |
| `NetworkError` | `NETWORK` | `true` | 请求失败/断连 | 否 |
| `PermissionError` | `PERMISSION` | `false` | RBAC/ACL/沙箱能力/文件围栏拒绝 | **是** |
| `ProfileError` | `PROFILE` | `false` | `profiles.get` 失败/隔离违规/身份组装失败 | **是** |
| `DownloadError` | `DOWNLOAD` | `false`（Task 层基线 `true`） | 下载超时/取消/落盘失败 | 否 |
| `UploadError` | `UPLOAD` | `false` | `setFiles` 路径越界/文件不存在 | 否 |
| `CancelledError` | `CANCELLED` | `false` | 协作式中断（**不在 9 类 taxonomy 内**，终态 `CANCELLED`） | 否 |

**retriable 集合（Task 层分类基线，`task.md` §5.1）**：

- `true`：`NetworkError`、`TimeoutError`、`DownloadError`、`UploadError`
- `false`：`BrowserError`、`PermissionError`、`ScriptError`、`ProfileError`、`SelectorError`

判定口径（`script-sdk.md` §6.1）：**`err.retriable` 显式值 > 类默认 > 分类表兜底**；队列只读最终 `err.retriable`（`task-queue.js:classify`）。注意 `task-queue.js:26 RETRIABLE_NAMES` 另含 `BrowserError`（历史宽口，以运行时实例值为准）；`script-runner.js` 的 `BrowserError`/`DownloadError` 构造为 `retriable=false`（实现比基线保守）。`CancelledError` 走终态 `CANCELLED`，不进 `RETRYING`。

`classify(err)` 顺序（`script-runner.js:126-157`）：instanceof 9 类 → `err.name` 映射 → `err.code` 前缀表（`BROWSER_`/`NETWORK_`/`SELECTOR_`/`PROFILE_`/`DOWNLOAD_`/`UPLOAD_`/`PERMISSION_`/`TIMEOUT_`）→ `SyntaxError`→`ScriptError` → 含 `timed out` → `TimeoutError` → 兜底 `ScriptError`。

---

## 5. Capability 模型

`script-store.js` 的 `CAPS`（store 校验的 6 键）与 `DEFAULT_PERMISSIONS`：

```js
CAPS = ['browser','cookies','storage','network','filesystem','process'];
DEFAULT_PERMISSIONS = { browser:true, cookies:true, storage:true, network:true, filesystem:false, process:false };
```

`automation.d.ts` 的 `PermissionKey`（10 键，权限面超集）：`'browser'|'cookies'|'storage'|'network'|'filesystem'|'process'|'profile'|'screenshot'|'upload'|'clipboard'`。

规则（`script-sdk.md` §7）：

1. **默认拒绝未列出项**；deny 集硬性不可达：`require('child_process'|'fs'|'os'|'net'|'dgram'|'shell')`、裸 `process`、`eval`/`new Function` 动态代码（vm `codeGeneration:{strings:false, wasm:false}`）。
2. **trusted-script opt-in**：`filesystem`/`process` 放宽仅对签名脚本（哈希签名 + 显式授权 + 授权目录围栏 + 审计）。
3. **trust 位 admin-only**：仅 service 层 `trust()`/`untrust()` 可写；`store.create/update/import` 一律拒 `trusted:true`（`script-store.js:176,226`）；`addVersion` 使旧签名失效。
4. 能力按任务逐项注入、用完收回；Worker 无 DOM、无 Node 全量、无 `window`。
5. `network` 出站策略执行侧强制（SSRF 防护）。

as-built 强制点：`script-runner.js:isAllowed`（`denyProxy` 对未授权键抛 `PermissionError`）；`capAllowed`（legacy 路径，filesystem/process 需 `trusted`）。

---

## 6. 最小可运行脚本示例

> 签名对齐 `automation.d.ts` / `script-sdk.md`。as-built 注入差异见 §7。

### 示例 1 — 打开网页 + 等待元素 + 填表 + 取文本 + 异常处理

```js
// 声明参数：username(string,required)、password(secret,required)
step('open-login');

await browser.goto('https://example.com/login', { waitUntil: 'load', timeout: 30000 });

await page.waitForSelector('#username', { state: 'visible', timeout: 10000 });
await page.fill('#username', params.username);
await page.fill('#password', params.password);   // secret：日志/错误串内自动 ***
await page.click('#submit');

try {
  await page.waitForText('.welcome', /Welcome/i, { timeout: 15000 });
  const heading = await page.getText('h1');
  console.log('logged in as', heading);
  return { heading };
} catch (e) {
  if (e instanceof TimeoutError) {
    throw new BrowserError('login did not complete within 15s');
  }
  throw e;   // 保持原始错误类，交状态机按 retriable 判定
}
```

### 示例 2 — 多标签 / 多 profile（显式跨 profile + 双向 ACL）

```js
// 当前身份（自动注入）：
const self = context;                 // AutomationContext，profile 只读
step('profile-self');
await browser.goto('https://example.com/a');           // page/browser 绑当前会话
await cookies.set([{ name: 'tag', value: 'self', url: 'https://example.com' }]);

// 显式取另一个 profile（唯一跨 profile 路径；无授权 → PermissionError + audit）：
const other = await profiles.get(params.otherProfileId);   // ForeignProfileContext
step('profile-other');
const snap = await other.get();          // 脱敏快照（无 proxy 密码 / 无 FP 载体）
await other.cookies.clear();             // 仅该 profile 的 partition
await other.storage.set({ seen: true }); // 仅该 partition local
const shot = await other.screenshot({ fullPage: true });   // Buffer

console.log('self session', self.profile.sessionId, 'other', snap.id);
return { self: self.profile.id, other: snap.id, bytes: shot.length };
```

约束（务必遵守）：`page`/`browser` 仅绑当前 `ProfileContext`；跨 profile 只能经 `profiles.get(id)` 使用 `cookies`/`storage`/`screenshot`/`get`/`update`，**不能**用 `other.page.goto`（`ForeignProfileContext` 无 `page`）。同一 Task 的多个 Item 不共享 `ProfileContext`/`Session`。

---

## 7. 与 `docs/automation` 的关系（delta）

### 7.1 新增

| 条目 | 对应文件 |
|---|---|
| 9 错误类 + `CancelledError` 的实装与 `classify` 前缀表 | `automation/runtime/script-runner.js` |
| `buildTrace`（失败取证：HTML 上限 262144B / network 尾 50 条 / URL） | `script-runner.js:253-298` |
| `params` 边界清洗（`cleanInput` 去 `__proto__`/`constructor`/`prototype`）与 secret scrub | `script-runner.js:214-238` |
| 围栏实装（upload/download 授权目录，fail-closed） | `automation/electron/browser-api.js:checkPath` |
| store 层 `DEFAULT_PERMISSIONS`/`CAPS`/`trust`（admin-only） | `automation/runtime/script-store.js` |

### 7.2 修改（d.ts 声明面 > as-built 注入面）

| 项 | d.ts / script-sdk.md（目标） | as-built（`script-runner.js` + `browser-api.js`） |
|---|---|---|
| 注入命名空间 | 15 个 | `params`/`context`/`console`/`step` + `CAP_KEYS` 组 + `page`；**未注入** `profiles`、`download`、`dialog`（`CAP_KEYS` 不含 download/dialog） |
| `context` 语义 | 完整 `AutomationContext`（get/update/cookies/storage/screenshot/fingerprint） | 仅 `Object.freeze({ profile })`（最小身份句柄） |
| `browser` | 8 方法 | 仅 `goto` / `screenshot`（其余经 page driver 子集暴露） |
| `page` | 20 方法 | 子集：click/fill/type/press/waitForSelector/waitForText/waitForURL/waitForFunction/getText/getAttribute/getValue（`evaluate`/`getCurrentUrl` 条件暴露；locator/back/forward/reload 等缺失即 `undefined` → 干净 `TypeError`，非 `PermissionError`） |
| `network` | intercept/waitForRequest/waitForResponse | 仅 `recent`（+ 条件 `enable`）；`intercept` 未实装 |
| 缺失语义 | — | 缺失能力以 `undefined` 呈现（`script-runner.js:expose` 注释），**不是**静默降级 |

### 7.3 废弃 / 刻意缺席

| 条目 | 说明 |
|---|---|
| `sleep` / 固定延时默认等待 | 刻意缺席；`waitForTimeout` 仅调试逃逸口，发布版禁固定延时 > 1000ms（`script-sdk.md` §2.2） |
| `d.ts` 中的 Electron/Node 内建类型 | 硬性禁止（权限面原则，`script-sdk.md` §5） |
| 裸 CDP 句柄 / `setFingerprintConfig` / `setSSLConfig` / `setUserAgent` / `fromPartition` 直调 | 脚本不可达（`runtime.md` §7.2） |

---

## 8. 版本兼容策略

| 维度 | 策略 |
|---|---|
| 类型面 | `automation/automation.d.ts` 头注释声明「source of truth: docs/automation/script-sdk.md; keep in sync」；`d.ts` 即权限面，变更即评审。 |
| 版本锚定 | DB 设计 `script_versions.dts_hash` 锚定 d.ts 版本（`database.md` §2）；`ScriptMetadata.version` 语义版本、store 保 newest-first。 |
| 包格式 | `fp-script` 导出包 `{format:'fp-script', v:1, script, version, code}`；导入 `v!==1` 拒绝、fresh uuid 永不覆盖、trust 位不随包携带（`script-store.js:356-394`）。 |
| 兼容原则 | 新增方法向后兼容；破坏性变更须升 `d.ts` 版本并更新 `script-sdk.md`（两份同改）。 |

---

## 9. 引用

- SDK 设计：[../automation/script-sdk.md](../automation/script-sdk.md)；类型面：[../../automation/automation.d.ts](../../automation/automation.d.ts)
- 错误/状态机：[../automation/automation-gap-analysis.md](../automation/automation-gap-analysis.md) 附录 A；重试分类：[../automation/task.md](../automation/task.md) §5
- 沙箱/权限：[../automation/security.md](../automation/security.md)；DB 参数表：[../automation/database.md](../automation/database.md) §3
- 架构（本包）：[05-system-architecture.md](./05-system-architecture.md)；执行摘要：[00-executive-summary.md](./00-executive-summary.md)；待决项：[11-open-questions.md](./11-open-questions.md)
