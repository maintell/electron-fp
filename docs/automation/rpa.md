# RPA（可视化流程编排 → Automation AST）

> 范围：RPA 的定位、AST 节点模型、Selector 策略、录制、等待、控制流、与 Script 双向转换、测试锚点与 builder UI。对齐 `architecture.md` §0/§2（RPA→AST 进同一 Runtime，**不另建执行引擎**）、`script-sandbox.md`（能力模型与执行位置）、`script-sdk.md` §2（SDK API 面与 smart waits）、`task.md` §7（Schedule 桩）、`competitor-research.md` §3（RPA 能力与 Selector 优先级对标）。
> §2/§5/§6 为规格与校验规则；Runtime 实现已落地（`automation/runtime/rpa-ast.js` / `rpa-recorder.js`，其中 `rpa-ast.js:18-36` 是节点/枚举真值来源），§8 断言以实跑为准。

---

## 1. 定位

RPA = **非程序员入口**。用户在 builder 里拖节点、填表单，产出一份流程 JSON（AST）；Runtime 把它当数据执行，不把它当代码跑。

```
录制 / builder 编排
  ▼
RPA AST（JSON，存 scripts.ast_json，database.md §2）
  ▼  校验（§2）→ 编译（§7，可选 astToScript）
Shared Automation Runtime（main 进程，唯一执行点）
  ▼
同一 SDK / 同一 Adapter / 同一 capability 门禁（script-sandbox §2/§3）
```

铁律：

1. **单一 Runtime**：RPA→AST 后与手写 Script、AI Agent 走完全相同的执行路径（`architecture.md` §0/§2：不另建执行引擎）。禁止第二 runtime、RPA 专属 IPC、RPA 专属执行器。
2. **AST 是数据不是代码**：控制流用结构化节点表达（§6），**无 `eval`、无字符串拼 JS**（`script-sandbox.md` §2 eval 永关）；`execJs` 节点也只落 `page.evaluate` 受限通道（超时 + 返回值截断脱敏）。
3. **Renderer 只做 UI**：builder（`Client/renderer/automation-panel/rpa/`）只生成/编辑 JSON；校验、编译、执行全在 main 侧（`architecture.md` §3 铁律）。
4. **调度入口共用**：RPA 流程作为 Script 资产被 Task 引用，定时/批量走 `task.md` §7 Schedule 桩（Phase 6 接线），RPA 不自带调度器。

对标定位（`competitor-research.md` §3）：覆盖 Builder（拖拽 + JS 逃生口）、Selectors、Control（if/loop/try）、Actions（导航/鼠标/键盘/文件/截图/等待）四维；不复制任何竞品实现。

---

## 2. AST 节点类型全表与校验规则

### 2.1 节点全表

流程根：`{ name: string, nodes: RpaNode[] }`。每个节点必有 `id`（builder 生成的稳定短 id）与 `type`。

| type | 分组 | 关键字段 | 语义 / SDK 映射 |
|---|---|---|---|
| `start` | 结构 | — | 流程入口，恰好 1 个，自动注入 |
| `end` | 结构 | — | 流程出口，恰好 1 个，自动注入 |
| `goto` | 导航 | `url`, `waitUntil?` | `browser.goto`（script-sdk §2.1） |
| `scroll` | 导航 | `selector?`, `dy?`, `toEnd?` | 页内滚动；无 selector 为文档滚动 |
| `click` | 交互 | `selector` | `page.click` |
| `clickText` | 交互 | `text`, `selector?` | 按可见文本定位后 click |
| `clickRole` | 交互 | `role`, `name?` | 按 aria-role/name 定位后 click |
| `fill` | 交互 | `selector`, `value` | `page.fill`（整框赋值） |
| `type` | 交互 | `selector`, `text`, `delay?` | `page.type`（逐键，可 delay） |
| `press` | 交互 | `selector`, `key` | `page.press`（Enter/Tab/…） |
| `select` | 交互 | `selector`, `value` | `<select>` 选值 |
| `upload` | 交互 | `selector`, `files[]` | `upload.setFiles`；路径须过围栏（sandbox §2 upload=fence），越界 `PermissionError` |
| `wait` | 系统 | `for`, `selector?`, `text?`, `url?`, `ms?` | 智能等待（§5）；**非 sleep** |
| `readText` | 数据 | `selector`, `var` | 取文本存变量 |
| `readAttr` | 数据 | `selector`, `attr`, `var` | 取属性存变量 |
| `setVar` | 数据 | `name`, `value` | 变量赋值（字符串字面量） |
| `downloadWait` | 数据 | `pattern`, `var?` | `download.wait`（script-sdk §2.4） |
| `screenshot` | 系统 | `fullPage?`, `var?` | `browser.screenshot`；落盘过围栏 |
| `execJs` | 系统 | `code` | `page.evaluate` 受限通道；Runtime-limited（超时+截断脱敏） |
| `if` | 控制流 | `cond`, `then[]`, `else[]` | 结构化条件（§6），两分支节点数组 |
| `loop` | 控制流 | `mode`, `count?`, `cond?`, `body[]` | 迭代（§6），上限 10000 |
| `gotoLabel` | 控制流 | `label` | 跳转到同流程 `label` 节点 |
| `label` | 控制流 | `name` | 跳转锚点 |
| `try` | 控制流 | `body[]`, `catchVar?` | 异常捕获（§6），映射错误类 |
| `throw` | 控制流 | `message` | 抛出（落入 try 或终态 FAILED） |
| `log` | 系统 | `message`, `level?` | 执行日志（info/warn/error），进 LogLine 流 |

### 2.2 校验规则（validate 必检）

| # | 规则 | 违反处理 |
|---|---|---|
| 1 | `type` 必须在上表全集内 | `unknown node type: {type}`，定位到该节点 |
| 2 | 恰好一个 `start`、一个 `end`，且 `start` 为首个、`end` 为末个 | 结构错误 |
| 3 | `gotoLabel.label` 必须命中同流程存在的 `label.name` | **悬空 label**，定位到 `gotoLabel` |
| 4 | `label.name` 全流程唯一 | 重复 label |
| 5 | 嵌套深度 ≤ **8**（if/loop/try 计层） | 超限拒绝保存 |
| 6 | 节点总数 ≤ **5000**（含嵌套与 start/end） | 超限拒绝保存 |
| 7 | 必填字段齐全（表 2.1 关键字段；`cond` 见 §6） | 字段缺失，定位到节点 |
| 8 | `selector` 类节点在 coordinate 兜底外必须非空（§3） | 缺 selector |
| 9 | 变量引用 `var`/`catchVar` 为合法标识符 | 非法变量名 |

校验出口：`{ ok: boolean, errors: [{ path: number[], nodeId: string, msg: string }] }`；builder 红点 + 错误列表点选跳节点（UI §9）。Runtime 执行前必须过同一校验（不信任 renderer 传入）。

---

## 3. Selector 策略

### 3.1 优先级（综合 `competitor-research.md` §3 最佳实践）

```
data-testid > id > role/name > text > CSS > XPath > coordinate
```

| 档 | 形态 | quality 分 | 说明 |
|---|---|---|---|
| 1 | `data-testid` | 100 | 专为自动化预留，最稳 |
| 2 | `id` | 90 | 唯一且稳定时 |
| 3 | `[role=…][name=…]` / `aria-*` | 80 | 无障碍语义，语义化页面最稳 |
| 4 | `name` 属性 | 70 | 表单控件常用（与 rpa-recorder.js `qualities.name` 一致） |
| 5 | 可见文本 | 60 | 多语言需谨慎（文案一改即失效） |
| 6 | CSS（类名结构稳定） | 40 | 结构稳定时可用 |
| 7 | XPath（相对路径） | 20 | 可用但少优先；绝对路径不生成 |
| 8 | 坐标 `coordinate:{x,y}` | 10 | 最后手段，分辨率/缩放一变即失效（与 `qualities.coordinate` 一致） |

### 3.2 反模式（禁默认生成）

- `div:nth-child(…)` 深链、绝对 XPath（`/html/body/…`）、依赖动态类名（CSS Modules 哈希、`cls-xxxx`）——**不得作为录制/builder 的默认 selector**。
- 录制器若唯一可得的候选是上述脆弱形态：不静默采纳，标记 `selectorQuality < 20` 并要求人工确认或换档重录。
- `click` 节点可存 `selector` + `quality`（builder 按表打分）；Runtime 只透传，不做二次嗅探。

---

## 4. 录制（record）

链路：**record → debounce → AST shell**。

1. `record.start()`：builder 进入录制态，收集意图事件（导航/点击/输入/按键/选择/上传）。
2. **debounce**：同类高频事件（type 连击、scroll）按 200–300ms 窗口合并为单节点（`type` 节点累积文本）。
3. **AST shell**：每个确认事件生成 §2.1 对应节点骨架（selector 候选按 §3 打分），追加进流程 `nodes`；结构节点（if/loop/label）不录制，录制产物是**线性 shell**，分支由用户在 builder 补。

### 局限（ceiling，诚实声明；2026-09-26 二次修订——跨文档导航已支持）

- **实时 DOM 捕获已落地**：`electron/recorder.js` 经门控会话注入自包含监听脚本（click/input/change/keydown/scroll + history patch），`drain()` 把 raw 事件映射为 `rpa-recorder` 的 evt 契约（**复用其 `generateSelector`/`createRecorder` 原样**），产出经 `rpa-ast` validate 的 AST。真机 Record→Replay 已证：`probe-live-recorder.js` **7/7**（走查 AST 顺序 + 状态复现 + 跨文档两页流程重放），且 `#go` 以 id 档（quality 90）记录而非 nth-child；事件时间戳取自页面，故 debounce/gap 语义为真实间隔。
- **跨文档导航已支持（`webContents` 模式）**：`did-start-navigation`（主帧非 in-place）→ 提交前尽力 drain 旧文档；`did-navigate` → 导航记录由 emitter/本地队列产出（不再依赖页面 buffer）+ 守卫式重注入（`window.__fpRec` 存在则跳过；mid-load 失败重试一次 150ms）。真机两页流程已证：page1 → page2 产出 `goto → goto → fill(#user2=bob)` 并成功重放。**剩余 ceiling**：(a) 提交竞态下旧文档 drain 失败的尾部事件会丢（导航记录保证不丢）；(b) 两次注入都失败（页面 ~150ms 内未稳定）则该文档捕获停摆至下次导航；(c) in-place 与子帧导航不重注入（设计）；(d) 不传 `webContents` 时保持单文档行为（首个真实 load 后失能）。
- **控制面与 UI（2026-09-26）**：录制器经四通道暴露（`automation:recorder:start|drain|stop|state`，见 `api.md` §12），RPA builder 顶栏提供 Record/Stop + live 节点列表 + Import to canvas；`?demo=1` 可离线模拟全循环。证据：`probe-recorder-control.js` 7/7（真机全链）。
- **捕获种类 ceiling**：`change` 仅映射 SELECT→`select`、file→`upload`；修饰键与单字符 keydown 有意跳过（文本走 `input`）。无捕获源的节点类型：`readText`/`readAttr`/`screenshot`/`downloadWait`/`execJs`（可重放、可手工加，但不自动录出）。
- 可注入 **`isUnique(selector) → boolean`** 探针做唯一性实测；未注入时 quality 分只反映形态档位（§3），不代表实测唯一。

---

## 5. 等待

**智能等待是唯一默认路径；`sleep` 禁止作默认**（`script-sdk.md` §2.2 硬性规范）。

| wait.for | 映射 | 字段 |
|---|---|---|
| `selector` | `page.waitForSelector(sel, { visible })` | `selector`, `visible?` |
| `text` | `page.waitForText` | `selector`, `text` |
| `url` | `page.waitForURL` | `url` |
| `timeout` | `delay(ms)`（纯延迟逃逸口） | `ms` |

> 实现现状：`WAIT_KINDS`（`rpa-ast.js:36`）仅放行上表四种 `for` 值；`navigation` / `networkIdle` / `response` / `request` 属 `script-sdk.md` §2.2 的 SDK 目标面，尚未进 AST 校验。

规则：

1. 操作节点（click/fill/…）自带 auto-wait（Locator 惰性求值，script-sdk §2.3），**无需**前置固定延时。
2. `wait` 节点的 `timeout` 只是该次等待的上限，**超时抛 `TimeoutError`**，不是"睡够 timeout"。
3. 若需要纯延迟（罕见）：`wait.for='timeout', ms` 显式逃逸口——映射 `delay(ms)`，仅作用于本节点的后续 `fn` 执行时机；**发布版流程里 delay > 1000ms 打 warning**（同 script-sdk lint 规则），不作为默认推荐。`sleep(5000)` 式固定延时不进发布版流程。
4. 与其他自动化产品一致（competitor §5 backpressure 精神）：等待基于条件（DOM 态/文本/URL/网络空闲/响应），不基于固定 wall-clock。

---

## 6. 控制流（if / loop / try）

### 6.1 条件语法（结构化，无 eval）

```ts
interface Cond { left: string; op: CondOp; right: string }
type CondOp = '==' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'truthy';
// left/right 为字面量或 $var 引用（如 "$status"、"200"、"$title"）
```

- 求值由 Runtime 解释：`left`/`right` 若为 `$name` 则取变量，否则按字面量（数值比较时两侧可解析为数则数值比）。
- **禁止**把 `cond` 拼成字符串交给 `eval`/`new Function`（sandbox §2 永关）；`op` 不在枚举内 → 校验失败。
- `if` 节点：`{ type:'if', cond, then: RpaNode[], else: RpaNode[] }`，两分支独立节点数组（UI 呈现为嵌套容器两槽）。

### 6.2 loop

```ts
interface Loop {
  type: 'loop';
  mode: 'count' | 'while' | 'foreach';  // 实现以 `times` / `forEach` 字段承载，无 `mode`
  count?: number;          // mode='count'：固定次数（实现字段名 `times`）
  cond?: Cond;             // mode='while'：条件为真时继续
  forEach?: string;        // mode='foreach'：'x over y'（对变量 y 的数组逐元素迭代，绑定 x）
  body: RpaNode[];
}
```

- **迭代上限 10000**：累计迭代数（跨所有 loop 实例求和）达 10000 → 抛 `ScriptError(retriable=false)`，流程 FAILED；防失控死循环占住 Worker（对齐 timeout-kill 精神，competitor §4）。
- `while` 每轮重估 cond；`count` 为静态次数，校验要求 `count` ∈ [1, 10000]。
- `foreach` 形式：`forEach: 'x over y'`（`FOREACH_RE`，`rpa-ast.js:35`）——对变量 `y` 的数组逐元素迭代，元素绑定到 `x`；非数组或缺失 → 校验/执行报错。

### 6.3 try / throw

```ts
interface Try { type:'try'; body: RpaNode[]; catchVar?: string }
```

- catch 映射错误类（script-sdk §6.1）：`ScriptError` 及子类 `TimeoutError / SelectorError / BrowserError / NetworkError / PermissionError / ProfileError / DownloadError / UploadError`。
- 捕获后可写 `catchVar`（对象序列化：`{ type, code, message, retriable }`，secret 不入 message）；**非 retriable 错误若不在 try 内 → 直接终态 FAILED**，与状态机一致（gap 附录 A）。
- `try` 不吞 audit：抛出/捕获均记日志（sandbox §6 T9 语义保留）。

### 6.4 goto / label

- 仅允许**向前**跳转（target 索引 > 当前）或跳入同层 label；禁止向后跳制造隐式循环（循环必须用 `loop`，否则逃逸 10000 上限）。
- 校验：`gotoLabel` 目标必须存在且不构成后向环（§2.2 规则 3/4 + 前向检查）。

---

## 7. 与 Script 双向转换

### 7.1 `astToScript`（RPA → JS，线性化逃生口）

| AST 形态 | 生成 JS |
|---|---|
| 线性节点序列 | 逐节点一行 SDK 调用：`goto`→`await browser.goto(...)`、`click`→`await page.click(...)`、`wait`→`await page.wait({...})`、`readText`→`const t = await page.getText(...)`… |
| `if` | `if (evalCond(...)) { then } else { else }`——`evalCond` 为 Runtime 注入的结构化求值函数，**不生成内联表达式字符串** |
| `loop` | `count`→`for (let i=0;i<n;i++)`、`while`→`while (rt.cond(...))`（套 10000 上限计数器） |
| `try/throw` | `try { ... } catch (e) { ... }` |
| `goto/label` | **不支持线性化** → 见下 |

- 产物是普通 Script 源码，可进 Monaco 编辑、可当 Script 发版（ScriptVersion 绑定 code_sha256）。
- **复杂 RPA 留 AST 执行**：含 `goto`（非前向）/ 跨分支跳转 / 深嵌套 > 线性化上限（嵌套 > 3 或节点 > 500）→ `astToScript` 拒绝降级，仍走 AST 直执行。**不为覆盖率强转**——转不动就诚实留在 AST 路径（同一 Runtime，无二等公民）。

### 7.2 `scriptToAst`（JS → RPA，不做）

**不实现 JS→AST 反向解析**（YAGNI：需要完整 JS parser + 语义等价证明，成本远超收益）。手写 Script 进入 builder 的方式只有：用户主动"从模板新建线性流程"（用 §2.1 节点语义重述），或流程本就从 RPA 起步。双向仅指 §7.1 单向导出 + builder 内可视化编辑。

---

## 8. 测试锚点

目标文件：`automation/test-rpa-ast.js`、`automation/test-rpa-recorder.js`（**已落地**，输出遵循 `PASS`/`FAIL`/`SKIP` 前缀，同 `test-core.js` 风格）。

### 8.1 `test-rpa-ast.js`

| # | 用例 | 预期断言 |
|---|---|---|
| 1 | 节点全表覆盖 | §2.1 全部 26 类各构造最小合法样例，`validate().ok === true` |
| 2 | 未知类型 | `{type:'bogus'}` → 错误码含 `unknown`，`nodeId` 指向该节点 |
| 3 | 悬空 label | `gotoLabel` 指向不存在 label → 错误，path 定位正确 |
| 4 | label 重复 | 两个同名 label → 错误 |
| 5 | 嵌套 ≤8 | 9 层 if 嵌套拒绝；8 层通过 |
| 6 | 节点 ≤5000 | 5001 节点拒绝；5000 通过 |
| 7 | start/end 结构 | 缺 start、双 end、end 非末位 → 各自报错 |
| 8 | cond 无 eval | `op:'||'`/`op:'concat'` 非枚举 → 拒绝；`left:'$a'` 取变量求值正确 |
| 9 | loop 上限 | count=10001 拒绝；while 实跑迭代计数达 10000 抛 `ScriptError(retriable=false)` |
| 10 | try 映射错误类 | catch 内 `type`/`retriable` 与 script-sdk §6.1 类名一致；非 retriable 未捕获 → FAILED |
| 11 | 前向跳转 | 后向 gotoLabel → 拒绝；前向合法 |
| 12 | `astToScript` 线性 | 线性流程生成 JS 无 `eval`/`new Function` 字样，含预期 SDK 调用序列 |
| 13 | `astToScript` 拒绝 | 含 goto 的流程 → 返回拒绝（留 AST 执行），不抛半成品 |
| 14 | selector quality | 按 §3 表断言：`[data-testid=x]`→100、`#id`→90、`div:nth-child(2)`→不生成默认（<20 且需确认） |

### 8.2 `test-rpa-recorder.js`

| # | 用例 | 预期断言 |
|---|---|---|
| 1 | record→debounce | 连续 type 事件 300ms 窗口合并为单 `type` 节点，文本累积正确 |
| 2 | 事件→节点映射 | click/fill/goto/select/upload 事件各自落到 §2.1 对应 type |
| 3 | AST shell 线性 | 录制产物 nodes 为线性序列，无自动插入 if/loop |
| 4 | selector 打分 | 注入候选按 §3 打分；data-testid 候选存在时必须选用 |
| 5 | isUnique 注入 | 注入 `isUnique` 探针为 true → quality 采纳；false → 降档/标记需确认 |
| 6 | 无探针 ceiling | 未注入 `isUnique` → 不崩溃，quality 仅形态档位，录制继续（纯逻辑生成） |
| 7 | 脆弱形态拒绝 | 唯一候选为绝对 XPath/`div:nth-child` 深链 → 不静默采纳，`selectorQuality<20` 标记 |
| 8 | 校验联动 | 录制产物直接过 `validate()` → `ok===true`（shell 永远结构合法） |

---

## 9. Builder UI（automation-panel 扩展）

实现位置：`Client/renderer/automation-panel/rpa/`（`rpa.html` + `rpa.css` + `rpa.js`，独立文件，不改既有 `panel.*`）。

| 项 | 规格 |
|---|---|
| 布局 | 三栏：左 palette（分组：导航/交互/数据/控制流/系统）→ 中 flow canvas（纵向有序卡片 + 连线；if/loop 为嵌套容器，含 then/else 或 body 槽）→ 右 inspector（节点表单：selector/value/cond 结构化字段 + 上移/下移/删除/复制） |
| 顶栏 | 流程名、Validate（`window.rpaApi.validate` 或本地结构校验兜底）、Replay（无 bridge 禁用 + tooltip）、Save、Export/Import JSON |
| 交互 | palette 拖拽或点击追加；嵌套节点经 inspector"添加到分支"或空槽点击加入 |
| 状态 | 有效绿点 / 无效红点+错误列表点选跳节点 / 脏 `●` / Replay 期间 readonly |
| 桥接 | `window.rpaApi = { save, load, validate, replay, subscribeLog }` 全可选；缺失时横幅提示（同 panel.js 模式）；`?demo=1` 加载示例线性流（goto→wait→fill→click→readText→if） |
| JSON 视图 | textarea 双向同步，blur 即校验，供高级用户直改 |
| a11y | palette 项 `aria-*`；焦点序 palette→canvas→inspector；选中节点支持 Delete 删除、↑↓ 重排 |

builder 是编辑器，不是执行器：Replay/执行一律经 `rpaApi.replay` 回 main Runtime，renderer 不跑任何流程逻辑。

---

## 附：与既有文档的对照

| 本文小节 | 对齐点 |
|---|---|
| §1 定位 | architecture §0/§2（同入口、不另建引擎）、§3（renderer 不执行）；database §2（`ast_json` 列） |
| §2 节点/校验 | script-sdk §2 API 面；competitor §3 Actions/Control 维 |
| §3 selector | competitor §3 优先级与反模式 |
| §4 录制 | gap §1.4/P8（RPA→AST 阶段）；CDP 接线对齐 architecture §2/§10 |
| §5 等待 | script-sdk §2.2 禁 sleep 硬性规范 |
| §6 控制流 | script-sdk §6 错误类；gap 附录 A 状态机；competitor §4 timeout-kill |
| §7 双向 | architecture §2（RPA→AST 后路径一致）；sandbox §2 eval 永关 |
| §8 测试锚点 | test-core.js PASS/FAIL/SKIP 约定 |
| §9 UI | panel.js bridge 契约模式；task §7（调度共用，RPA 无专属调度） |
