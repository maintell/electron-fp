# 04 · 自动化技术选型（Technology Selection）

> 目标：结合现有 Electron 指纹浏览器（`F:\code\electron-fp`）的既有能力，在**至少两种可行技术路线**间做可解释的比较，给出唯一推荐 + 备选 + 理由，并记录收益/成本/风险。
> 输入：竞品机制见 [03-competitor-technical-analysis.md](03-competitor-technical-analysis.md)；现状与可复用模块见 [05-system-architecture.md](05-system-architecture.md) 与 `../automation/automation-gap-analysis.md`。
> 原则：**不为功能数量引入不必要复杂度**；优先复用现有能力；所有评分必须给出解释，不允许只给主观分数。

## 1. 现有技术底座（不可推翻的前提）

- 浏览器内核为 Chromium（含指纹补丁），渲染层已有 `Client/renderer/`（含 `automation-panel/`）。
- 自动化运行时**已实现并运行在 Electron main 进程**：`automation/runtime/*` + `automation/electron/*`，入口 `Client/main.js:899` 的 `attachAutomation`。
- 脚本当前在 **`node:vm`** 沙箱内执行（`automation/runtime/script-runner.js`）。
- 页面驱动走 **`webContents.debugger`**（`automation/electron/page.js` / `glue.js`）。
- 对外已有 **HTTP / WS / CLI / IPC（50 通道）同一 Service Layer**。
- 存储为 JSON 文件（`script-store.js`），DB 为设计态未实现。

**结论前提**：选型不是「从零选框架」，而是「在既有 main 进程运行时之上，确定 Adapter 层与隔离层的形态」。任何引入都会与 `node:vm`、`webContents.debugger`、50 通道 IPC 并存。

## 2. 候选一：页面控制后端（Adapter 层选型）

评分维度（user spec §6.2）：兼容性 / 控制能力 / 稳定性 / 隔离性 / 调试能力 / 开发成本 / 性能 / 可扩展性 / 许可风险 / 维护风险。等级：★★★★★ 最优 → ★ 最差；每项附解释。

| 后端 | 兼容性 | 控制能力 | 稳定性 | 隔离性 | 调试 | 开发成本 | 性能 | 可扩展 | 许可 | 维护风险 |
|---|---|---|---|---|---|---|---|---|---|---|
| **Electron `webContents.debugger`（现状）** | ★★★★★ 进程内、无外部依赖 | ★★★★ 浏览器级 CDP 全量可达 | ★★★★ 随窗口生死，`RenderFrameHostChanged` 需重连 | ★★★ 与 renderer 同进程边界，需 ACL | ★★★★ 可直接复用 DevTools | ★★★★★ 已实现 | ★★★★★ 无跨进程开销 | ★★★★ 协议即 CDP | ★★★★★ Electron 自带 | ★★★★ 随 Electron 升级 |
| **raw CDP over loopback WS** | ★★★★ 需自建 cdp-ws 桥 | ★★★★★ 浏览器级最强 | ★★★ 回环无鉴权、需自管生命周期 | ★★★ 需自建 token gate | ★★★★★ 与 DevTools 同源 | ★★★ 已实现 `cdp-ws.js` | ★★★★ 一次 WS 往返 | ★★★★★ 协议标准 | ★★★★★ 协议开放 | ★★★ 需跟随 Chrome 版本 |
| **Playwright（`connectOverCDP`）** | ★★ 无 Electron 支持；打包后 `_electron.launch` 实验性 | ★★★★ 页面级 + 自动等待 | ★★★★ 自动等待/重试成熟 | ★★★ 外部进程 | ★★★★★ trace/ inspector | ★★★ 需引入大依赖 | ★★★ 进程外 | ★★★★ 多语言 | ★★★★ Apache-2.0 | ★★★ 版本需与 CDP 对齐 |
| **Puppeteer（`connect`）** | ★★★ CDP 薄封装 | ★★★ 页面级 | ★★★ 需自管等待 | ★★★ 外部进程 | ★★★ CDP 调试 | ★★★★ 轻量 | ★★★★ | ★★★ JS only | ★★★★ Apache-2.0 | ★★★ |
| **Selenium/WebDriver** | ★★ 需 chromedriver 对齐 | ★★ 仅页面级、可被反检测 | ★★ 明确「可被检测」 | ★★ 外部进程 | ★★ | ★★ | ★★ | ★★ 多语言 | ★★★★ Apache-2.0 | ★★ 驱动版本地狱 |

**推荐**：以 **`webContents.debugger`（进程内）为默认后端**，**raw CDP over loopback WS 为外部/远程后端**，**Playwright `connectOverCDP` / Puppeteer / Selenium 仅作为「兼容 Adapter」**（满足用户既有资产迁移，不进入主链路）。

**理由**：竞品全部是「厂商 API 管实例 → 返回 CDP/WebDriver 句柄」；本产品已在 main 进程内直接持有 `webContents`，用 `webContents.debugger` 可**省掉一整层外部进程与端口管理**（竞品的最大复杂度来源），且天然获得浏览器级控制力。Playwright 无 Electron 一等支持（`_electron.launch` 实验性、ASAR 不支持），不适合作为主后端，但保留 `connectOverCDP` 兼容外部用户脚本。

**成本/风险**：主后端的成本是「自己写自动等待/重试」（Playwright 白送）；风险是 `RenderFrameHostChanged` 后会话失效需重连（已实现 `restartSession`）。兼容 Adapter 的成本是引入大依赖与版本对齐；缓解=列为可选、默认不装。

## 3. 候选二：脚本运行时隔离选型（安全/资源层）

评分维度：执行隔离 / 资源隔离 / 安全隔离 / 兼容性 / 性能 / 开发成本 / 可调试性。

| 方案 | 执行隔离 | 资源隔离 | 安全隔离 | 兼容性 | 性能 | 开发成本 | 可调试 |
|---|---|---|---|---|---|---|---|
| **`node:vm`（现状）** | ★★ 同进程、可逃逸 | ★ 无 CPU/内存上限 | ★ 明确**不是**安全边界 | ★★★★★ 已实现 | ★★★★★ 无开销 | ★★★★★ | ★★★ |
| **`worker_threads`** | ★★★ 独立 V8 isolate | ★★★ 可 terminate、可限制堆 | ★★★ 同进程，仍非强安全边界 | ★★★★ Node 内置 | ★★★★ | ★★★★ | ★★★ |
| **`utilityProcess`（Electron）** | ★★★★ 独立子进程 | ★★★★ 可杀、可限内存 | ★★★★ 进程边界 + OS 限制 | ★★★★★ Electron 内置 | ★★★★ | ★★★ 需 IPC 编排 | ★★★ |
| **独立 `child_process` + Node** | ★★★★★ 进程 + 可选 OS 沙箱 | ★★★★★ | ★★★★★（配合 OS 权限/容器） | ⛔ 需另装 Node（违反分发约束，见 [16](16-zero-runtime-distribution-constraints.md)） | ★★★ | ★★ | ★★ |

**推荐**：**分两档**——
- **可信脚本（本机用户自建）**：沿用 `node:vm`，但**显式声明其上限**（同进程逃逸），配 capability 默认 deny（`child_process`/`fs`）。
- **不可信脚本（第三方/市场）**：升级到 **`utilityProcess`**（Electron 内置，无需外装 Node），配 OS 级资源限制与受控 API 代理。

**理由**：用户 spec §6.5 明确要求「不得把 `node:vm` 描述为可靠安全边界」。`utilityProcess` 是 Electron 原生能力，兼容性最好、无外部依赖、可 terminate；`worker_threads` 只能做执行/资源隔离，不能做安全隔离。**禁止**把 `worker_threads` 或 renderer 沙箱当作安全边界。

> **分发硬约束（见 [16](16-zero-runtime-distribution-constraints.md)）**：**应用自身**的运行时基底只能来自 Electron 内嵌（V8 / 内嵌 Node / `node:vm` / `worker_threads` / `utilityProcess`）；**禁止**应用 spawn 系统 `node`/`python` 或捆绑第二解释器。因此候选「独立 `child_process` + Node」被否决。**注**：此约束不限制用户在**自己的**工程里使用外部 SDK 时自备解释器（见 [14](14-external-sdk-design.md)）。

**收益/成本/风险**：收益=隔离等级可随信任级提升；成本=`utilityProcess` 需自建 RPC 编排与序列化边界；风险=进程间传递 `BrowserWindow`/`webContents` 句柄不可行 → 采用「控制面留在 main、脚本面在 utilityProcess、经受控 API 代理调用」的设计（见 [08-runtime-security-and-reliability.md](08-runtime-security-and-reliability.md) §执行安全）。

## 4. 候选三：编辑器组件

| 方案 | 功能 | 体积 | 许可 | 维护 | 集成成本 |
|---|---|---|---|---|---|
| **Monaco Editor** | ★★★★★ TS 类型提示、诊断、多文件 | 大（~MB 级） | MIT | ★★★★★ 微软主推（VS Code 同源） | ★★★ 需打包 worker |
| CodeMirror 6 | ★★★★ 轻量、模块化 | 小 | MIT | ★★★★ | ★★★ |
| 纯 textarea | ★ | 极小 | — | — | ★★★★★ |

**推荐**：**Monaco**（对齐 user spec §6.3「VS Code Monaco Editor」），配 `automation.d.ts` 作为类型提示来源。**理由**：竞品 8 家**全部没有代码级编辑器**（见 [02](02-competitor-matrix.md) §4.5），这是差异化点；Monaco 与 `automation.d.ts`（已存在 453 行）组合可直接获得补全/诊断。**成本**=打包体积与 worker 配置；缓解=按需加载。

## 5. 候选四：可视化流程编排（可选，后续）

| 方案 | 说明 |
|---|---|
| 复用现有 RPA→AST（`rpa-ast.js` + `rpa-recorder.js`） | 已有 26 节点 AST、选择器生成、录制；**推荐作为可视化层的唯一实现**，避免第二套运行时 |
| 引入 Automa / 第三方编排 | 引入外部生态与许可/维护风险，与「统一运行时」冲突，**不推荐** |

**推荐**：**不引入外部编排引擎**，可视化层继续走「RPA→AST→同一 `script-runner`」，与竞品「可视化与代码两套引擎」形成差异（竞品 RPA 与外部脚本是两条链路）。

## 6. 决策记录（ADR 摘要）

| ADR | 决策 | 备选 | 理由 | 成本/风险 |
|---|---|---|---|---|
| ADR-1 | 页面后端默认 `webContents.debugger`，外部用 raw CDP | Playwright 主链路 | 进程内、无端口管理、浏览器级控制 | 需自写等待/重试 |
| ADR-2 | 保留 Playwright/Puppeteer/Selenium 为**可选**兼容 Adapter | 只支持 CDP | 迁移既有用户资产 | 大依赖、版本对齐 |
| ADR-3 | 可信脚本 `node:vm`；不可信脚本 `utilityProcess` | 全部 vm / 全部独立进程 | 按信任级分档，诚实声明隔离等级 | RPC 编排成本 |
| ADR-4 | 编辑器用 Monaco + `automation.d.ts` | CodeMirror | 类型提示、对齐 spec | 打包体积 |
| ADR-5 | 可视化 = RPA→AST 同一运行时 | 引入外部编排 | 避免第二套运行时 | 需维护 AST |
| ADR-6 | 不引入 DB 作为首期强依赖；先 JSON + 快照 | 直接 SQLite | local-first、与 remote worker 不冲突 | 易失性（靠快照缓解） |
| ADR-7 | 运行时基底限定 Electron 内嵌；拒绝系统 node/python 与第二解释器 | 独立 child_process+Node / Python Script Runner | 客户机零安装、避免客诉（[16](16-zero-runtime-distribution-constraints.md)） | 失去「用系统解释器」的灵活性 |

## 7. 许可与维护评估（新增依赖）

| 依赖 | 许可 | 维护状态 | 结论 |
|---|---|---|---|
| `node:vm` / `worker_threads` / `utilityProcess` | Node/Electron 内置 | 随运行时 | ✅ 零外部依赖 |
| Monaco Editor | MIT | 微软活跃 | ✅ 可引入 |
| Playwright | Apache-2.0 | 微软活跃 | ⚠️ 仅可选 Adapter |
| Puppeteer | Apache-2.0 | 活跃 | ⚠️ 仅可选 Adapter |
| Selenium | Apache-2.0 | 活跃 | ⚠️ 仅可选 Adapter |
| Automa 等第三方编排 | 各异 | 社区 | ❌ 不引入 |

> 硬约束：**禁止 `npx`**（本仓 `CLAUDE.md`）；依赖从 `node_modules/.bin/` 或 `yarn` 调用。所有新增依赖必须评估维护状态、版本兼容与许可。

## 8. 与竞品的差异化定位（选型产出）

| 维度 | 竞品普遍水平 | 本方案目标 |
|---|---|---|
| 页面后端 | 外部进程 + CDP/WebDriver | 进程内 `webContents.debugger`（更低开销） |
| 脚本隔离 | 推给用户进程 | 按信任级分档（vm / utilityProcess） |
| 编辑器 | 无代码级编辑器 | Monaco + 类型定义 |
| 版本管理 | 8 家皆无 | 不可变版本 + 发布态 |
| 调度/幂等 | 弱/无 | 内置调度 + 幂等键 + 恢复边界 |
| 可视化 | 独立第二引擎 | 与代码同运行时（AST） |

> 落地架构与模块边界见 [05-system-architecture.md](05-system-architecture.md)；安全与可靠性见 [08-runtime-security-and-reliability.md](08-runtime-security-and-reliability.md)；实施排期见 [10-implementation-roadmap.md](10-implementation-roadmap.md)。
