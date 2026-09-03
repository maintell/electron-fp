# Client 自检面板 + 探针页 设计

日期：2026-09-04
状态：待用户审阅

## 背景与目标

`Client/` 是一个多标签指纹浏览器，63 个指纹 key 全部可调（UI 按 schema 动态生成，
无硬编码）。但**它没有任何自检能力**：

- `renderer/app.js` 中 probe / verify / check / detect 命中数为 **0**
- 全部测试能力在 `Client/test-*.js`（40 个文件，只能命令行跑）和
  `fingerprint/scripts/smoke.js`（独立 electron 脚本，`#!/usr/bin/env electron`）

用户看不出「我配的这个指纹到底生效了没有」。目标是把 `smoke.js` 的 28 个表面
检查搬进 UI，让用户一键自检当前 tab。

### 已确认的选择

1. **形态**：内置自检面板 + 探针页（不是把 40 个 test-*.js 全接进 UI）
2. **判定口径**：实测值与配置值**逐项比对**，一致才算通过（沿用 smoke.js 口径）
3. **探针上下文**：**直接在当前 tab** 的 BrowserView 里 `executeJavaScript`
4. **位置**：右侧指纹侧边栏加一个「自检」标签页（配置 / 自检 切换）

## 现状（已核实，非推断）

| 事实 | 值 |
|---|---|
| schema key 数 | 63 |
| `smoke.js` 覆盖的表面 | 28（27 measured + 1 skip） |
| 陈旧 `60-key`/`56-key` 注释 | 23 处，跨 11 个文件 |
| UI 是否硬编码 key | 否，`main.js` / `renderer/app.js` 都从 schema 动态读 |
| `renderer/app.js` 自检相关代码 | 无 |

`smoke.js` 的结构：
- `PROBE`（L69-115）：一个 IIFE 字符串，只读不写，唯一副作用是
  `client_rects_seed` 临时插一个 div 后立刻 `el.remove()`
- `EXPECTED`（L33-67）：期望值表
- `compare(key, expected, got)`（L141-）：逐项比对，有几个 key 有特殊格式
  （`webgl_max_viewport_dims` 单值展开成 `{v,v}`、`webgpu_features` 排序后比、
  `webgpu_limits` 解析 JSON 后逐键比）
- `evalProbe(win)`（L117-）：**必须**在真实 http origin 上跑，不能用 `about:blank`
  （opaque origin 会让 `navigator.storage` / `mediaDevices` 是 `undefined`）

## 设计

### 1. 抽出共享探针模块：`Client/fp-probe.js`

`smoke.js` 目前把 PROBE / EXPECTED / compare 都写死在一个自运行脚本里，
UI 无法复用。**不做大重构**，只是把它抽成一个可 require 的模块：

```js
// Client/fp-probe.js
module.exports = { PROBE, EXPECTED, compare, probeFields };
```

- `PROBE`：探针脚本字符串（从 smoke.js L69-115 原样搬）
- `EXPECTED`：期望值表（从 smoke.js L33-67 原样搬）
- `compare(key, expected, got)`：比对函数（从 smoke.js L141- 原样搬，
  含全部特殊格式处理）
- `probeFields`：PROBE 实际会返回的字段列表，用于区分「未探测」与「探测到但未生效」

`smoke.js` 改为 `require('../Client/fp-probe.js')`，行为不变。这样**单一事实来源**：
改了探针逻辑，命令行和 UI 同时生效，不会出现两套探针悄悄漂移。

> 风险：`smoke.js` 在 `fingerprint/scripts/` 而模块在 `Client/`。跨目录 require
> 用相对路径 `../Client/fp-probe.js`。`run-tests.js` 已经这样跨目录引用（
> `Client/fp-schema.js`），所以模式一致。

### 2. 探针执行：`Client/main.js` 新增 IPC

```js
ipcMain.handle('selftest:run', async (e, tabId) => { ... });
```

流程：
1. 取当前 tab 的 `BrowserView`
2. **关键**：探针必须在真实 http origin 上跑。若当前 tab 是 `about:blank`
   或 `electron://`，先导航到一个本地 http 探针页（起一个临时 http server，
   与 smoke.js 同做法），跑完不恢复（或恢复原 URL）
3. `view.webContents.executeJavaScript(PROBE)`，带超时（15s，同 smoke.js）
4. 用 `compare()` 逐项比对当前 tab 的**实际配置**（不是 EXPECTED 常量！）
5. 返回 `{ rows: [{key, expected, got, verdict}], summary }`

**与 smoke.js 的关键差异**：smoke.js 比对的是硬编码 `EXPECTED`；UI 自检比对的是
**当前 tab 实际配置的指纹**。所以每个 key 有三种结论：

| verdict | 含义 | 颜色 |
|---|---|---|
| `pass` | 配置了值，实测等于配置值 | 绿 |
| `fail` | 配置了值，实测**不等于**配置值（含回退到真机值） | 红 |
| `skip` | 未配置（该 key 未启用）或探针未探测到 | 灰 |
| `error` | 探针抛错 | 橙 |

未启用的 key 报 `skip` 而不是 `fail` —— 只对用户主动配置的项负责。

### 3. UI：`renderer/index.html` + `app.js`

侧边栏顶部加两个标签：**配置** / **自检**。

自检页内容：
- 顶部：一键「运行自检」按钮 + 汇总（`12 pass / 2 fail / 49 skip`）
- 主体：按 schema 分组的表格，每行 `key | 期望(配置值) | 实测 | 结果`
- 只显示非 `skip` 的行，默认折叠 `skip`（可展开看全量 63 行）
- 失败行高亮，并在行内给一句人话解释（如「数值型 key 传了字符串，内核静默回退到真机值」）

复用的既有能力：`fp:coverage`（L511）已能算出哪些 key 是 active 的，
自检直接复用，不重新实现。

### 4. 顺带修 23 处陈旧计数

23 处 `60-key` / `56-key` 全部改成 63。其中两处是**历史快照**，必须保留原数字：
- `test-app-copy-sync.js:10`（「copy 是 56-key 版本」——描述一个已发生的事故）
- `test-migrate-ua.js:9`（「老式 profile：56 keys」——迁移测试的固定输入）

这两处加一句「(historical: 56 was correct when this was written)」说明为何不改。

## 不做的事（YAGNI）

- **不**把 40 个 `test-*.js` 接进 UI —— 需要 spawn 子进程、解析输出、处理
  `resources/app` stash，复杂度远高于收益。命令行 `run-tests.js` 已覆盖。
- **不**做外部站点验证（browserleaks/creepjs）—— 需要出网，且已有
  `test-external-validation.js`。
- **不**改探针覆盖的表面数（28 个）。扩大到全部 63 个是另一次工作。

## 测试

新增两个文件：

**`Client/test-selftest.js`** — 用真实 BrowserWindow 验证判定逻辑：
1. 探针本身可用（返回对象、不抛错、能读到 storage / webgl 表面，证明跑在真实
   origin 而非 opaque origin）
2. 未配置任何 key 时**不产生任何 fail 行**
3. 正确生效的 key 判 pass
4. **核心**：配置了但回退到真机值必须判 fail。用 `webgl_max_viewport_dims: '8192'`
   （字符串）这个实测过的陷阱构造，它会静默回退到 32767。并配一条对照：同样的
   key 传数字 8192 必须判 pass —— 否则「陷阱」断言可能只是因为这个 key 根本不工作
   才通过的
5. `audio_data_strength` 传数字落在 0.0005 默认值上；传字符串则不同
6. 判定值域只有 pass/fail/skip/error

第 4 条的对照是关键：没有它，陷阱断言可能因为「该 key 永远失败」而通过。

**`Client/test-selftest-ui.js`** — 验证 DOM / IPC 契约，这是单元测试看不到的部分：
- 8 个 DOM id 在 `index.html` 中存在且被 `app.js` 引用（改名会被立刻抓住）
- 点击标签页真的切换面板并移动高亮
- 点 Run 真的调到 IPC bridge
- skip 行默认隐藏、勾选后显示
- 结果按 schema 分组，且 **fail 组排在 error 组之前、error 组排在 pass 组之前**
- 不在 schema 里的 key 落在 Other 组而不是消失

分组排序那条断言抓到过一个真实 typo：组内排序的比较函数误写成
`order[b.verdict]`（bucket 对象）而非 `order[r.verdict]`（行对象），导致所有分组
权重都取到默认值 9，排序退化成纯字母序。已修复并突变验证。

`smoke.js` 改为 require 模块后行为不变这一条，由既有的
`Client/test-smoke-gate.js` 覆盖（它断言 smoke.js 的 pass / skip 数量）。

## 文件清单

| 文件 | 改动 |
|---|---|
| `Client/fp-probe.js` | 新增，从 smoke.js 抽出 PROBE/EXPECTED/compare |
| `fingerprint/scripts/smoke.js` | 改为 require 该模块，行为不变 |
| `Client/main.js` | 新增 `selftest:run` IPC |
| `Client/renderer/index.html` | 侧边栏加「自检」标签页 |
| `Client/renderer/app.js` | 自检页逻辑 |
| `Client/renderer/style.css` | 自检页样式 |
| `Client/test-selftest.js` | 新增测试 |
| 11 个文件 | 23 处陈旧计数（其中 2 处保留历史数字并加说明） |
