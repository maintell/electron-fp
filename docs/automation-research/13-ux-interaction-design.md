# 13 · 交互与体验设计（UX & Interaction Design）

> 性质：研究交付件。**在既有 UI 上演进**（`Client/renderer/automation-panel/`），非重画新面板。
> 口径：每节区分「现状（as-built，可指向代码行）」与「目标（target，待建）」。**不虚构已实现的能力**；凡目标形态均标注依赖的既有缺口（P8 Monaco waive、B4 无 DB 等）。
> 上游：[00-executive-summary.md](./00-executive-summary.md)；架构：[05-system-architecture.md](./05-system-architecture.md)；SDK：[06-script-sdk-specification.md](./06-script-sdk-specification.md)；数据模型：[07-data-model-and-api.md](./07-data-model-and-api.md)；路线图：[10-implementation-roadmap.md](./10-implementation-roadmap.md)；待决项：[11-open-questions.md](./11-open-questions.md)。
> 既有 UI 规范：[../automation/rpa.md](../automation/rpa.md) §9（Builder UI）；[../automation/acceptance.md](../automation/acceptance.md) #33/#34；[../automation/testing.md](../automation/testing.md) §2.2。

---

## 0. 文档定位与既有 UI 基线

本文只回答一件事：**用户怎么用**。执行架构、SDK 语义、数据模型分别归 05/06/07，本文不重复，只引用。

**必须继承的既有 UI（不得推翻，只演进）**：

| 资产 | 位置 | 现状事实 |
|---|---|---|
| 停靠面板外壳 | `Client/renderer/index.html:147-155`、`style.css:241-298` | `#ap-panel` 固定 **420px**，与 `#fp-panel` **互斥共用**右列；F9 切换；挂载点 `#automation-panel` + `#ap-templates` |
| 脚本面板 | `automation-panel/panel.html` + `panel.js`(~95KB) | 视图 `Scripts / Tasks / Schedules / API`（`.ap-views` tab row）；Scripts 内为 `files(150px) | editor | dock`，dock 在 420px 内折到编辑器下方（`style.css:294-298`） |
| 面板设计令牌 | `panel.css:5-34` | 暗色：`--ap-bg:#1e1e1e` / `--ap-surface:#252526` / `--ap-accent:#0078d4` / `--ap-bright:#4ec9ff` / 等宽 `--ap-mono`；`ap-` 前缀 |
| RPA 可视化编辑器 | `automation-panel/rpa/rpa.{html,css,js}` | 三栏 `palette(190) | canvas | inspector(300)`；26 类节点（导航/交互/数据/控制流/系统）；Validate/Replay/Save/Export-Import；JSON 视图；录制覆盖层；`rap-` 前缀 |
| 模板面板 | `automation-panel/panel-templates.js` | 卡片列表 + Install/Preview + 过滤；`ap-tpl-*` 局部类 |
| 桥契约 | `Client/preload.js`（`window.automationApi`）、`rpa.js:10-42`（`window.rpaApi`） | 全部方法**可选**，缺失时横幅降级（`panel.js:1861` `probeBridge`） |
| 错误/状态模型 | `06` §4（9 类 + `CancelledError`）、`05` §7（Execution 7 态）、`07` §3.2（Queue 12 态） | 状态文案的唯一来源 |

**本文新增的 UI 命名前缀**：`aw-`（Automation Workbench，全屏工作台）。面板内既有 `ap-` / `rap-` 一律复用，不重命名（避免触碰 Wave16 已验收的几何与守护测试）。

---

## 1. 设计原则

六条原则，每条给出**可检验的落地约束**（不是口号）。

| 原则 | 含义 | 落地约束（可验收） |
|---|---|---|
| **友好（Approachable）** | 非程序员不写代码也能完成一条业务 | 任意功能从入口 ≤3 次点击可达；每个空状态必须内嵌「下一步」主操作；模板库是首启默认落点 |
| **可发现（Discoverable）** | 用户不需要记命令 | 提供命令面板（`Ctrl+K`）；主操作按钮常驻；能力缺失（无 bridge / 无 Monaco）用**说明性横幅**而非静默禁用 |
| **可观察（Observable）** | 任何时候都能回答「现在在跑什么、到哪一步、还剩多久」 | 状态胶囊（`.ap-pill`）常驻工具栏；运行中提供实时日志流 + `step()` 进度条；执行列表显示 duration |
| **可恢复（Recoverable）** | 误操作与崩溃都能回到已知良好状态 | 运行可取消（协作式 `CancelledError`）；编辑草稿自动存；删除类操作给「撤销」toast；crash recovery 在 UI 可见（见 §4.3） |
| **渐进披露（Progressive Disclosure）** | 默认简单，复杂按需展开 | 参数表单按类型生成（不写 JSON）；高级项（permissions、version pin、cron 原始表达式）收在 `<details>`/「高级」折叠内 |
| **双人群（Two Audiences）** | 可视化给非程序员，代码给程序员，同一资产 | 脚本有 `kind: 'code' | 'flow'`；可视化内部 Canvas⇄JSON 双视图；单向「转为代码」逃生口（§7） |

### 1.1 文案风格（copy style）

- **面向用户的文案用中文**：错误、空状态、确认框、提示。例：现有 `panel.js` 的 `ap-bridge` 横幅已是中文（「自动化桥未连接…」）。
- **面向开发者的标识符保留英文**：字段名（`scriptId`、`profileContexts`、`cron`）、API（`browser.goto`）、节点类型（`goto`、`clickText`）、状态码（`SUCCESS`、`RETRYING`）——**不翻译**，避免与 06/07 及代码脱节。
- 已在线上使用的英文 chrome 标签（`Scripts/Tasks/Schedules/API`）**不因本文改名**，减少既有测试扰动；新增分区与用户消息用中文。

---

## 2. 信息架构与导航

### 2.1 两种形态

系统提供**同一批视图**的两种外壳，**共用渲染模块**（`panel.js` / `rpa.js` 的 `mount()`），只是布局与信息密度不同。

```
┌───────────────────────────── 形态 A：停靠面板（420px）──────────────────────────────┐
│  #ap-panel  (与 #fp-panel 互斥，F9 切换)                                            │
│  ┌ header: Automation  [＋新建] [●录制] [⤢ 展开] [×] ┐                              │
│  │  ap-views: [ Scripts | Tasks | Schedules | API ]  │  ← 保留既有 4 tab           │
│  ├───────────────────────────────────────────────────┤                          │
│  │  Scripts:  files(150) | editor                     │  ← 快速改/跑              │
│  │            ─────────────── dock(console/params/…)  │                          │
│  │  Tasks:    只读列表 + Cancel/Retry                  │                          │
│  │  Schedules: 列表 + 快捷暂停/触发                    │                          │
│  │  API:      静态参考                                 │                          │
│  └───────────────────────────────────────────────────┘                          │
│  statusbar: Ln/Col · dirty · Last run                             │
└───────────────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────── 形态 B：全屏工作台（≥1024px 窗口）────────────────────┐
│  #automation-workbench (新增 overlay，复用同一批视图模块)                          │
│  ┌ 左主导航(200px) ┬────────────────── 内容区 ─────────────────────────────────┐  │
│  │  脚本库  library │  (由当前分区决定：库 / 编辑器 / 运行 / 任务 / … )          │  │
│  │  编辑器  editor  │                                                            │  │
│  │  运行    runs    │                                                            │  │
│  │  任务    tasks   │                                                            │  │
│  │  Profile profiles│                                                            │  │
│  │  模板    templates│                                                           │  │
│  │  录制    record  │                                                            │  │
│  │  设置    settings│                                                            │  │
│  └──────────────────┴────────────────────────────────────────────────────────────┘  │
│  statusbar: 全局状态 · 并发 N/5 · 队列 M · 当前 profile                            │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 主导航分区（工作台）

| 分区 | id | 职责 | 依赖的既有能力（现状） |
|---|---|---|---|
| 脚本库 | `library` | 列表/搜索/分组/标签、导入导出、信任状态、一键运行 | `automation:scripts:*`（9 通道）、`export/import`（`fp-script` v1） |
| 编辑器 | `editor` | Monaco 编辑 + 参数 schema 编辑 + 版本发布；可视化 ⇄ 代码切换 | `automation.d.ts`、`store.addVersion`；Monaco 为**惰性**（`ensureMonaco`） |
| 运行与监控 | `runs` | 活跃执行、实时日志、步骤进度、取消、历史 | `automation:executions:*`、`onAutomationEvent` live-log |
| 任务与调度 | `tasks` | 队列视图、批量 fan-out、cron/interval/once 配置、暂停/触发 | `automation:tasks:*`(7) + `automation:schedules:*`(6) |
| Profile 绑定 | `profiles` | profile 选择、分组、运行态、指纹摘要（脱敏） | `automation:profiles:*`(11)；`profile-manager.js` |
| 模板 | `templates` | 内置 11 模板、分类过滤、安装/预览 | `automation:templates:*`、`panel-templates.js` |
| 录制 | `record` | 进入受控可视化环境、录制→回放→导入画布 | `automation:recorder:*`(4)、`rpa/` 录制覆盖层 |
| 设置 | `settings` | 并发上限、日志级别、secret 提示策略、API 参考、信任管理 | `automation:status`、`scripts:trust/untrust`、`metrics` |

> **`API` 视图去向**：面板保留（连续 4 tab 不动）；工作台把「API 参考」归入 `settings`，不再单列主导航项。

### 2.3 与现有 F9 面板的关系与迁移路径

| 阶段 | 动作 | 不改动 | 新增 |
|---|---|---|---|
| **M0（现状）** | F9 单面板，4 视图 | 全部 | — |
| **M1** | 面板 header 加 `[＋新建] [●录制] [⤢ 展开]`；`⤢` 打开工作台 overlay | 面板内 4 视图、几何、`ap-` 类 | `#automation-workbench` 空壳 + `aw-` 骨架；Esc/`⤢` 收起 |
| **M2** | 工作台接入 `library / editor / runs`（复用 `panel.js` 既有 `renderFiles/renderConsole/renderExecs/renderDetail`） | 面板仍可独立用 | 左导航；视图路由 `switchView()` 扩展 |
| **M3** | 工作台接入 `tasks / profiles / templates / record / settings` | — | 新组件（§5） |
| **M4** | 面板与工作台**共享选中态与运行态**（同一 execution 在两处都可见） | — | 状态同步（单一 state 源或事件广播） |

**迁移不变量**：`#ap-panel` 的 420px 几何、与 `#fp-panel` 的互斥、`panel:set-open` / `resizeActiveView` 行为**一律不改**（受 `Client/test-automation-panel.js` 19 PASS 守护）。工作台是**额外 overlay**，不改动面板布局。

---

## 3. 主要任务流（每条含四态）

> 四态定义统一为：**空（Empty）/ 加载（Loading）/ 错误（Error）/ 成功（Success）**。桥缺失（`No handler registered` / `window.automationApi` 不存在）是**独立的降级态**，见 §4.3。

### 3.a 首次使用与快速开始（模板 → profile → 运行 → 结果）

**分步**

1. 首次打开面板 → 落点默认在 **模板**（`#ap-templates` 已有卡片区）。
2. 点模板卡片 `Install` → 克隆为真 Script（`installTemplates` 幂等，已存在记 `skipped`）。
3. 自动跳到 `editor`，参数表单已按模板 `parameters` 生成；未填必填项时 Run 禁用并高亮缺失字段。
4. 在 Profile 绑定区选一个 profile（无 profile → 空状态引导「新建/选择 profile」）。
5. `▶ Run` → 状态胶囊转 `running`，dock 切到 Console 显示实时日志。
6. 结束 → 胶囊转 `ok`/`failed`，Executions 列表出现该条，Detail 显示 result / artifacts。

| 态 | 表现 |
|---|---|
| 空 | 模板区无卡片时：「暂无模板」+ `Refresh`；无 profile 时 Run 旁内联提示「先选一个 Profile」 |
| 加载 | 模板卡片用**骨架屏**（3 张灰块）；`Install` 按钮转 spinner 并禁用 |
| 错误 | 顶部 `ap-banner`：「安装模板失败（key）：<message>」+ 重试按钮；桥缺失则显示降级横幅 |
| 成功 | toast「已安装 <name>」；卡片按钮变 `Installed`；自动选中新脚本 |

### 3.b 编写脚本（Monaco：补全 / 诊断 / 运行 / 保存 / 版本）

**分步**

1. `library` 选脚本或 `＋新建`（`doNew` 现状生成 `main()` 骨架）。
2. `editor` 载入代码：**Monaco 存在则用**（`ensureMonaco()` 探 `vendor/monaco`），否则 **textarea 回退**（现状）。
3. 输入时触发：Monaco 用 `automation.d.ts`（`addExtraLib`）给补全与红线；textarea 无补全（诚实降级）。
4. `Ctrl+S` 保存草稿；`Save version` 发布不可变版本（`store.addVersion`，newest-first）。
5. `Ctrl+Enter` 运行（参数取自 Params 表单）。
6. 版本胶囊 `.ap-version` 显示当前版本；历史版本可查看/回滚（`versions` 列表）。

| 态 | 表现 |
|---|---|
| 空 | 无脚本：`.ap-empty`「No script selected. Create one to start editing.」+ 主按钮「＋ 新建 Script」（现状已有） |
| 加载 | Monaco 懒加载时显示「正在加载编辑器…」；`Save` 期间按钮禁用 + spinner |
| 错误 | 语法/运行错误分两级：**编辑期**红线 + Problems 列表（Monaco）；**运行期**走 §4.4 的 9 类错误文案。保存失败用 banner |
| 成功 | 状态栏 `dirty` 点熄灭；toast「已保存 v<N>」；版本胶囊更新 |

> **诚实约束**：Monaco 目前 **waive bundle**（`10` §4；`acceptance.md` §5），只有 `__mountMonaco` hook + textarea 回退。补全/诊断在 Monaco 缺席时**不可用**，UI 必须显式说明，而非假装有。

### 3.c 运行与监控（启动 / 实时日志 / 步骤进度 / 取消）

**分步**

1. `▶ Run`（或工作台 `runs` 的 `Run`）→ 建 execution（`automation:run`）。
2. 状态胶囊 `running`（旋转 spinner，`panel.css:135-138`）。
3. Console 逐行流入日志（`onAutomationEvent` → `appendLog`）；级别着色 `info/warn/error/debug`（`.ap-log-*`）。
4. `step(name)` 标记进度：Console 出现分隔 + 步骤进度条（`currentStep` 字段，`07` §2.5）。
5. `■ Stop` → 协作式中断抛 `CancelledError` → 状态 `CANCELLED`（终态）。
6. `⏸ Pause` 仅在 running 时可见（`.ap-panel.is-running .ap-btn-pause`）。

| 态 | 表现 |
|---|---|
| 空 | 未运行：Console 显示「运行后日志将显示在此」；`runs` 空列表「暂无执行记录」 |
| 加载 | 胶囊 `running`；Stop 可用；日志自动滚底（`renderConsole(atBottom)`），用户上滚则**暂停自动滚** |
| 错误 | 胶囊 `failed`（红）；Console 错误行标红；详情面板显示 `error.name/message`（已 scrub secret） |
| 成功 | 胶囊 `ok`（绿）；状态栏 `Last run <dur>`；Executions 出现新条，Detail 可看 result |

### 3.d 调度与批量（cron 配置 / 多 profile fan-out / 队列视图）

**分步**

1. `tasks` 分区选脚本 → 「新建调度」。
2. 选 `type`：`once`（本地时间）/ `interval`（`everyMs ≥ 1000`）/ `cron`（5 字段 `min hour dom mon dow` 或宏 `@daily`）。cron 提供**可视化构造器**（分/时/日/月/周 5 个输入）+「高级」原始表达式。
3. `profileContexts`：从 Profile 选择器多选（**至少 1**，`scheduler.validate` 强约束）。这是 fan-out 的来源（`07` §2.8：扇出在 scheduler 层）。
4. 可选 `params` 覆盖、`maxAttempts`、`priority`（收在「高级」）。
5. 保存 → 列表出现调度卡片（`.ap-row`）：`type`/`state`(`active|paused|done`)/`nextRunAt`。
6. 队列视图显示 fan-out 出的 task item：状态（`07` §3.2 12 态映射到用户可见的 6 类）+ `attempts/maxAttempts` + `lastError`。

| 态 | 表现 |
|---|---|
| 空 | 无调度：「还没有调度」+「＋ 新建调度」；队列空：「队列为空」 |
| 加载 | 提交后按钮禁用；列表轮询（`startSchedPoll`，现状已有）时行右显示小 spinner |
| 错误 | 表单内 `ap-form-err`（`role="alert"`）就地报错：`profileContexts 至少 1` / `cron 表达式无效` / `everyMs ≥ 1000` |
| 成功 | 新卡片插入列表顶部；toast「已创建调度」；`nextRunAt` 显示为相对时间（`fmtRel`） |

### 3.e Profile 绑定与参数（typed params / secret 输入 / profile 选择）

**分步**

1. Params 表单由 `ScriptParameter[]`（9 型）**自动生成**（`renderParams` 现状已做 string/number/boolean/select/secret 等）。
2. 类型→控件映射（见 §5.6）；`secret` 用 `type=password` + 只读回显 `***`，**永不回显明文**。
3. Profile 选择器：单脚本运行选 1 个；调度/批量多选。
4. 校验在**前端**（必填、number 有限、select ∈ options）与**后端**（`validateParameters`）双层；前端拦截给出即时反馈。

| 态 | 表现 |
|---|---|
| 空 | 无参数：Params 面板「该脚本无参数」；无 profile：选择器显示「无可用 Profile」+「新建」 |
| 加载 | profile 列表加载中显示骨架；`profiles.list` 失败回落 `profilesCapability()` 提示 |
| 错误 | 必填缺失 → 字段红框 + Run 禁用；`secret` 泄漏防护：日志/错误串中显示 `***`（`scrubSecrets`） |
| 成功 | 所有必填通过 → Run 可用；参数随 execution 存快照（`params_snapshot`，目标列） |

### 3.f 查看执行历史与产物（日志 / 截图 / trace / 错误定位）

**分步**

1. `runs` 或 dock `Executions` 选一条 → Detail。
2. Detail 显示字段：`executionId / scriptId / version / status / duration / profileId / currentStep / currentUrl`（`07` §2.5）。
3. 失败时展示 `error`（name/message/stack，已 scrub）+ **artifacts**（失败截图）+ **trace**（DOM/网络/URL，`buildTrace`）。
4. 时间线条（`.ap-timeline`，现状由日志派生）定位关键节点；错误行可点跳到对应日志。
5. 产物：截图内联预览（`.ap-artifact-img`），trace 可展开（HTML 上限 262144B / 网络尾 50 条，`06` §7.1）。

| 态 | 表现 |
|---|---|
| 空 | 未选：Detail 面板禁用（`title="先选择一条 execution"`）；选了但无产物：「无产物」 |
| 加载 | Detail 轮询（`syncDetailPoll`）时头部小 spinner |
| 错误 | 取详情失败：pane 内错误行 + `Refresh`；trace 截断时显示「HTML 已截断（262144B 上限）」 |
| 成功 | 字段齐 + 截图缩略 + 时间线可读；「在日志中定位」按钮把错误行高亮 |

### 3.g 录制与可视化编排（进入可视化 → 录制 → 回放 → 编辑）

**分步**

1. `record` 分区（或 rpa 工具栏 `Record`）→ 选 profile + 起始 URL → `recorder.start`。
2. 进入受控环境：录制覆盖层（`.rap-rec-panel`）显示实时捕获列表（`.rap-rec-row`），含 `selector` 与 **quality 档位**（`.q-hi/mid/lo`，颜色只是强化，文本承载值）。
3. 连续输入按 300ms 窗口合并为单 `type` 节点（`rpa.md` §8.2 #1）。
4. `Stop` → `recorder.stop` 返回 `{ast:{nodes,meta}}`；**画布不自动变**，需用户确认 `Import`（`rpa.js:149-151` 设计：捕获独立于画布）。
5. 导入后进入 builder：palette 拖/点追加、inspector 编辑、Validate 本地结构校验 + bridge 校验。
6. `Replay` 经 `rpaApi.replay` 回 main Runtime；期间 UI **只读**（`.is-replaying`）。
7. `Export JSON` / `Save`；需要代码时用单向「转为代码」（§7）。

| 态 | 表现 |
|---|---|
| 空 | 画布无节点：`.rap-empty`「从左侧添加第一个节点」；录制未开始：覆盖层隐藏 |
| 加载 | 录制中：`rap-rec-dot` 脉冲 + 计时 + 计数；Replay 中：面板只读 + 日志条流式 |
| 错误 | 校验错误列表（`.rap-errors`，点选跳节点）；脆弱 selector（quality<20）在捕获行标 `q-lo` 并要求确认 |
| 成功 | `rap-state` 绿点（valid）；`dirty` 点熄灭（已存）；Replay 日志显示执行链路 |

---

## 4. 交互细节

### 4.1 状态与反馈四件套

| 机制 | 用途 | 既有实现 | 目标 |
|---|---|---|---|
| **Toast** | 一次性成功/中性反馈，自动消失 | 无 | 新增 `aw-toast`：右下角，3s 自动消失，可含「撤销」 |
| **横幅（banner）** | 需要用户注意但非阻塞 | `.ap-banner`（错误，`role="alert"`）+ `.ap-bridge-banner`（降级）+ `.ap-page-note`（warn） | 复用；错误横幅加「重试」按钮 |
| **骨架屏** | 列表/卡片首次加载 | 无 | 新增 `aw-skeleton`（列表 3 行灰块 / 卡片 3 张） |
| **进度** | 运行/批量/调度 | 胶囊 spinner；`currentStep` | 新增步骤进度条 `aw-steps`（由 `step()` 驱动）；批量显示 `已处理 i/N` |

**规则**：同一时刻最多 1 个错误横幅 + 1 个 toast；错误横幅**不自动消失**（必须可关闭），toast 自动消失。

### 4.2 危险操作确认

| 操作 | 现有模式 | 目标 |
|---|---|---|
| 删除调度 | **二次确认**（`Confirm`/`Keep`，`panel.js:861-863`，`pendingRemove`+`removeTimer`） | 沿用，统一为行内确认条 |
| 删除脚本 | 无 | 弹窗确认（含脚本名）+ 删除后 toast 带**撤销** |
| 停止运行中 execution | 无确认 | 直接停（可恢复），但 toast 提示「已请求取消」 |
| 回滚版本 | 无 | 确认（说明将指向旧版本） |
| 放开 `filesystem`/`process` 权限 / `trust` 脚本 | 无 | **强确认**：说明风险 + 需显式勾选；trust 为 admin-only（`06` §5.3） |

原则：**不可逆才确认**（删除、回滚、提权）；可恢复的（停止、暂停）不打断。

### 4.3 降级态（桥缺失 / Monaco 缺席 / 打包）

这是本项目**已验证**的真实场景（`probeBridge`、`test-automation-panel-degrade.js` 5 PASS）。

- **桥缺失**：`probeBridge()` 在 mount 时调 `getScripts()` 探活；命中 `/No handler registered/i` → 置 `state.bridge=null`、显示 `#ap-bridge` 横幅 + 空状态、`applyDisabled()` 禁用 Run/Save、跳过轮询。
- **其他真实错误**：保持原路径（真实错误可见，不吞）。
- **Monaco 缺席**：textarea 回退 + 说明「编辑器为简化模式（补全/诊断不可用）」。
- **工作台**：同一降级逻辑复用；桥缺失时工作台各分区显示统一「自动化桥不可用」空状态，禁用写操作。

### 4.4 错误呈现（9 类 + Cancelled 的用户可读文案）

> 类别与 `retriable` 以 `06` §4 为准。UI 只做「翻译 + 给一个下一步」，不改错误语义。

| 错误类 | code | retriable | 用户文案（示例） | 主操作 | 徽标 |
|---|---|---|---|---|---|
| `ScriptError` | `SCRIPT` | 否 | 「脚本逻辑出错：<message>」 | 查看日志 / 编辑脚本 | 红 |
| `TimeoutError` | `TIMEOUT` | 是 | 「操作超时（<n>s）。页面可能较慢或选择器未出现。」 | 重试 | 橙·可重试 |
| `SelectorError` | `SELECTOR` | 否 | 「找不到元素 <selector>。页面结构可能已变。」 | 编辑选择器 / 截图 | 红 |
| `BrowserError` | `BROWSER` | 否 | 「浏览器会话异常（窗口/导航层）。」 | 重试运行 | 红 |
| `NetworkError` | `NETWORK` | 是 | 「网络请求失败或断连。」 | 重试 | 橙·可重试 |
| `PermissionError` | `PERMISSION` | 否 | 「权限被拒绝：脚本未获授权（<key>）。」 | 查看权限 / 申请 trust | 红·**已审计** |
| `ProfileError` | `PROFILE` | 否 | 「Profile 身份组装失败或隔离违规。」 | 检查 Profile | 红·**已审计** |
| `DownloadError` | `DOWNLOAD` | 是（Task 层） | 「下载超时或落盘失败。」 | 重试 | 橙·可重试 |
| `UploadError` | `UPLOAD` | 是（Task 层） | 「上传失败：路径越界或文件不存在。」 | 选择文件 | 橙·可重试 |
| `CancelledError` | `CANCELLED` | 否 | 「已取消。」（终态，非失败） | 重新运行 | 灰 |

**呈现规则**：① 一律显示 `code`（开发者可搜索）+ 中文文案（用户可懂）；② `retriable=true` 显示「可重试」徽标与重试按钮；③ `PERMISSION`/`PROFILE` 附「已记录审计」小字（对齐 `06` §4 audit 强制）。

### 4.5 键盘快捷键

| 快捷键 | 作用 | 现状 |
|---|---|---|
| `F9` | 切换停靠面板 | ✅ 现有 |
| `F10` | 切换指纹面板 | ✅ 现有 |
| `Ctrl+Enter` | 运行脚本 | ✅ 现有（`ap-run` title） |
| `Ctrl+S` | 保存脚本 | ✅ 现有（`ap-save` title） |
| `Ctrl+K` | 命令面板（跳分区/运行/新建） | 🆕 目标 |
| `Ctrl+Shift+E` | 展开/收起工作台 | 🆕 目标 |
| `Esc` | 关闭工作台 / 关闭弹窗 / 取消录制确认 | 🆕 目标 |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做（编辑器内） | Monaco/textarea 原生 |
| `Delete` | 删除选中 RPA 节点 | ✅ 现有（`rpa.md` §9） |
| `↑` / `↓` | RPA 节点重排 | ✅ 现有 |
| `Tab` | 焦点序：palette → canvas → inspector | ✅ 现有（`rap` a11y） |

所有快捷键需在**命令面板**可见（可发现性），且不覆盖输入框内的浏览器默认（焦点在 input/textarea 时 `Ctrl+K` 仍应可用，其余单键不劫持）。

### 4.6 撤销 / 拖拽 / 搜索过滤排序分页

- **撤销**：编辑器内 `Ctrl+Z`（原生）；列表级删除用 **toast 撤销**（3s 窗口）；RPA 节点操作为结构变更，暂不做多步撤销（`ponytail:` 一次操作一次确认，撤销栈成本高，先不做；用户有 JSON 视图可回退）。
- **拖拽**：RPA palette→canvas 拖放（现状 `cursor:grab`）；嵌套节点经 inspector「添加到分支」或空槽点击（现状）。目标补：节点拖拽重排（现状为 ↑↓ 按钮）。
- **搜索/过滤/排序/分页**：脚本库按 name/标签/分类过滤（模板面板已有 `.ap-search` 模式可复用）；执行列表按 status/script 过滤 + 时间排序；任务/调度列表同理。**分页**：首期用「加载更多」（后端无 DB、列表为 JSON 全量；`07` §1 明确无 SQLite），DB 落地（`10` N1）后再做真分页——**不假装有服务端分页**。

---

## 5. 组件清单

每个组件给**职责 + 关键状态**（状态取自 05/07，不新造）。

### 5.1 编辑器 `aw-editor`（代码）
- **职责**：承载 Monaco / textarea；补全（`automation.d.ts`）、诊断、保存、版本。
- **关键状态**：`empty`（无脚本）/ `loading`（Monaco 加载）/ `ready` / `dirty` / `readonly`（运行中或降级）/ `monaco-missing`（textarea 回退）。
- **既有锚点**：`panel.js` `mountEditor/ensureMonaco/loadScriptIntoEditor`；`.ap-editor`。

### 5.2 运行器 `aw-runner`
- **职责**：Run/Stop/Pause、状态胶囊、参数收集、实时日志订阅。
- **关键状态**：`ready / running / ok / failed`（对应 `.ap-pill.is-*`）；`cancelling`（点了 Stop 等待协作式中断）。
- **既有锚点**：`.ap-pill`、`doRun/doStop/doPause/pollExecution`。

### 5.3 日志查看器 `aw-log-viewer`
- **职责**：流式日志、级别过滤、时间戳、自动滚底、清空、secret 脱敏显示。
- **关键状态**：`empty` / `streaming`（自动滚底，用户上滚即暂停）/ `paused`（用户上滚）/ `filtered` / `capped`（达 `MAX_LOGS=1000`，提示「新日志已丢弃」，对齐 `07` §2.6）。
- **既有锚点**：`.ap-console`、`appendLog/renderConsole`。

### 5.4 任务表 `aw-task-table`
- **职责**：队列条目、状态、attempts、重试/取消/暂停、fan-out 结果。
- **关键状态**：`empty` / `loading` / `has-items`；行状态映射（12 态 → 用户 6 类，`07` §3.2）。
- **既有锚点**：`.ap-row`、`renderTasks/doTaskAct/startTasksPoll`。

### 5.5 调度卡片 `aw-schedule-card`
- **职责**：展示 `type/state/nextRunAt/lastFiredAt`；暂停/恢复/立即触发/删除。
- **关键状态**：`active / paused / done`（`07` §2.9）；`pending-remove`（二次确认，现状）。
- **既有锚点**：`.ap-row`、`renderScheds/doSchedAct/pendingRemove`。

### 5.6 参数表单生成器 `aw-param-form`
- **职责**：由 `ScriptParameter[]`（9 型）生成控件；前端校验 + 缺失高亮。
- **类型→控件**：`string→text` / `number→number` / `boolean→checkbox` / `select→select` / `multi-select→多选` / `secret→password(*** 回显)` / `file→文件选择(围栏内)` / `textarea→textarea` / `JSON→textarea+校验`。
- **关键状态**：`no-params` / `valid` / `invalid`（必填缺失，Run 禁用）/ `secret-set`（显示 `***` 而非明文）。
- **既有锚点**：`.ap-params`、`renderParams/collectParams`；规则 `07` §2.3。

### 5.7 Profile 选择器 `aw-profile-picker`
- **职责**：单选（运行）/多选（调度批量）；显示运行态 `stopped/starting/running/stopping/error`（`07` §2.10）。
- **关键状态**：`empty`（无 profile）/ `loading` / `ready` / `multi`（已选 N）/ `none-selected`（调度时禁用保存）。
- **既有锚点**：`automation:profiles:*`；`profile-manager.js`。

### 5.8 录制控件 `aw-recorder`
- **职责**：开始/停止录制、实时捕获列表、quality 档位、导入画布确认。
- **关键状态**：`idle` / `recording`（脉冲点+计时+计数）/ `stopping` / `pending-import`（需用户确认）/ `imported`。
- **既有锚点**：`.rap-rec-*`；`rpa.js` recorder 段。

### 5.9 可视化画布 `aw-canvas`
- **职责**：有序节点卡片、嵌套分支（if/loop/try）、拖放、选中/错误定位、JSON 视图。
- **关键状态**：`empty` / `valid`（绿点）/ `invalid`（红点+错误列表）/ `dirty` / `replaying`（只读）。
- **既有锚点**：`.rap-canvas`、`.rap-node`、`renderCanvas/renderList/renderErrors`。

---

## 6. 视觉与布局规范

### 6.1 设计语言（沿用 `panel.css`）

不引入新调色板。所有新组件复用 `--ap-*` 令牌（`panel.css:5-23`）：`--ap-bg #1e1e1e`、`--ap-surface #252526`、`--ap-border #333`、`--ap-accent #0078d4`、`--ap-bright #4ec9ff`、`--ap-ok #4caf50`、`--ap-error #f48771`、`--ap-warn #f4a742`、`--ap-mono`、`--ap-radius 4px`。`aw-` 组件**只消费令牌，不新增十六进制字面量**。

### 6.2 列宽与断点（桌面为主，最小 1024）

| 形态 | 断点 | 布局 |
|---|---|---|
| 停靠面板 | 固定 420px 列（`#ap-panel`） | `.ap-main` 恒为 `150px | 1fr` + dock 在下（`style.css:294-298`） |
| 工作台 | `≥1024`（设计下限） | 左导航 200px + 内容区；内容区内部再按分区自适应 |
| 工作台 | `1024–1279` | 左导航收为 **56px 图标栏**（hover 展开 tooltip） |
| 工作台 | `<1024` | 不提供工作台（提示「窗口太窄，使用面板」）；面板不受影响 |

> 现状 RPA/panel 的 `767/1099` 断点（`panel.css:194-213`、`rpa.css:667-733`）保留不动；工作台用**独立 `aw-` 断点**，不改既有断点。

### 6.3 密度、层级、暗/亮

- **密度**：沿用现状 13px 基准（`panel.css:32`），行高紧凑（列表行 padding 8px 12px）。工作台可提供「舒适/紧凑」切换（目标，非必须）。
- **层级**：`bg < surface < surface2 < surface3`（`#1e1e1e → #252526 → #2d2d2d → #383838`）；浮层（录制面板、下拉、toast）用 `box-shadow: 0 6px 20px rgba(0,0,0,.45)`（沿用 `rap.css:553`）。
- **暗/亮**：**as-built 仅暗色**。亮色为**目标**：把 `--ap-*` 语义令牌做两套映射（`[data-theme="light"]` 覆盖），不改组件结构。**当前不实现**，仅预留令牌层（诚实声明：现状无亮色）。

### 6.4 可访问性

- **焦点**：全局 `:focus-visible { outline: 2px solid var(--ap-bright); outline-offset: -2px }`（`panel.css:39/46`，已有）；新组件必须继承。
- **对比度**：正文 `#e0e0e0` on `#1e1e1e`（高）；次要 `#9aa0a6` 用于非关键信息；**颜色不单独承载语义**（`rap-rec-chip` 注释明确：文本承载值，颜色只是强化）。
- **ARIA**：现状已用 `role="tablist"/"tab"/"tabpanel"`、`role="alert"`、`aria-live="polite"`（console）、`aria-current`、`aria-selected`。新组件沿用：toast `role="status"`，骨架 `aria-busy="true"`，进度条 `role="progressbar"` + `aria-valuenow`。
- **键盘可达**：所有交互有键盘路径（§4.5）；拖放必须有「非拖放」等价路径（现状 palette 支持点击追加、节点支持 ↑↓）。
- **动效**：尊重 `prefers-reduced-motion`（`panel.css:834`、`rap.css:661` 已有）。

---

## 7. 双人群衔接（可视化 ⇄ 代码）

### 7.1 事实约束（先讲清楚，再设计）

- `rpa.md` §7.1：**`astToScript`（可视化→代码）已设计**，线性流程可生成普通 JS（可进 Monaco、可发版）。
- `rpa.md` §7.2：**`scriptToAst`（代码→可视化）明确不做**（需完整 JS parser + 语义等价证明，YAGNI）。
- 因此「同一脚本两视图」**不是双向往返**，而是：**一个脚本一个 `kind`，可视化内部双视图 + 单向转代码逃生口**。UI 必须诚实呈现这个不对称，否则用户会期待往返。

### 7.2 模型与 UI

```
Script { kind: 'code' | 'flow' }
  ├─ kind='code'  → Monaco 编辑器（§5.1）
  │                  不可「转为可视化」（诚实禁用 + tooltip 说明原因）
  └─ kind='flow'  → 可视化画布（§5.9）
                     ├─ 视图切换：Canvas ⇄ JSON（现状已有）
                     └─ 「转为代码」按钮（单向）
                          ├─ 可线性化 → 生成新 code 脚本（fork），保留原 flow
                          └─ 含 goto / 深嵌套(>3) / 节点(>500) → 拒绝并说明「保持可视化执行」
```

- **切换位置**：编辑器工具栏一个分段控件 `[ 可视化 | 代码 ]`：
  - `flow` 脚本：`可视化` 激活；点 `代码` 若可线性化则弹出「生成代码副本」确认（说明**不可逆回**），生成后进入新 code 脚本。
  - `code` 脚本：`代码` 激活；`可视化` 置灰，tooltip「暂不支持代码→可视化（见 rpa.md §7.2）」。
- **同一资产**：`flow` 与它导出的 `code` 是**两个脚本**（导出即 fork，`code_sha256` 各自绑定），不共享编辑。UI 明确标注「此代码由可视化流程导出，改动不回写」。

### 7.3 非程序员如何不写代码完成业务

三条路径，全部不碰代码：

1. **模板**：11 个内置模板（`script-templates.js`，分类 navigation/auth/forms/data/utility/monitoring/files/workflow）一键 Install，参数表单化。
2. **可视化编排**：26 类节点覆盖导航/交互/数据/控制流/系统；`if/loop/try` 用结构化字段（无 `eval` 字符串）。
3. **录制**：在受控环境操作一次 → 捕获为节点 → 导入画布 → 回放验证。

三条路径的产物**都进同一 Runtime**（`architecture.md` §2），非程序员与程序员的脚本在调度/审计/历史里**一等公民**。

---

## 8. 一致性声明

### 8.1 与 00–11 的对齐

| 本文引用 | 来源 | 关系 |
|---|---|---|
| 双人群/可视化/模板/录制 | `00` §2 | 直接落地（Monaco + RPA→AST + templates） |
| 面板嵌入、preload facade、IPC 50 通道 | `05` §8.1–8.3 | UI 只经 `window.automationApi`，不直连 main |
| Monaco 惰性 / textarea 回退 | `05` §3 表、`10` P8 | UI 必须显式降级（§3.b、§4.3） |
| 15 命名空间 / 9 错误类 / `params` | `06` §2/§4/§3.10 | 参数表单生成 + 错误文案（§4.4、§5.6） |
| `ScriptParameter` 9 型、Execution 7 态、Queue 12 态、Schedule 字段、Profile 字段 | `07` §2.3/2.5/2.8/2.9/2.10、§3.2 | 组件状态与表格字段的唯一来源 |
| 面板 19/bridge 6/degrade 5、RPA 16/27、recorder 7/7 | `09` §1、`10` §5 | 本文改动受其守护，不破坏 |
| Monaco waive、RPA 部分、templates 部分 | `10` §1 P8、§4 | 目标 vs 现状的诚实边界 |
| init/cleanup 钩子空白（OQ-13）、secret vault（P9） | `11` | 不设计不存在的 UI（如「初始化脚本」入口） |

**不越界**：本文不新增 SDK 方法（归 06）、不新增数据字段（归 07）、不改状态机（归 05/07）。

### 8.2 与 `docs/automation/` 的关系（delta）

| 类别 | 内容 |
|---|---|
| **NEW（本包新增）** | ① **停靠面板 ⇄ 全屏工作台**双形态与迁移路径（M0–M4）；② **主导航 8 分区**；③ 7 条任务流的**四态契约**；④ **9 类错误的中文文案 + 主操作 + 可重试徽标**映射；⑤ 组件清单（`aw-*`）与状态枚举；⑥ **双人群的单向转换**交互（诚实呈现 `scriptToAst` 不做）；⑦ 亮色/断点/密度的目标规范。 |
| **MODIFIED（口径演进）** | ① 面板从「单形态 4 视图」演进为「面板 + 工作台」；② `rpa.md` §9 的 Builder UI 由本文承接并扩展（不推翻，仅补导航/降级/文案）；③ 面板错误呈现从「原始 message」升级为「code + 中文文案 + 下一步」。 |
| **DEPRECATED（不再引用）** | 无。本文不废弃任何既有 UI 文档或行为；`panel.js` / `rpa.js` 的既有交互契约（`window.automationApi` / `window.rpaApi`）保持不变。 |
| **不变（复用）** | 面板 420px 几何、与 `#fp-panel` 互斥、F9/F10、`ap-`/`rap-` 类、`.ap-pill`/`.ap-banner`/`.ap-rows`/`.ap-form` 等既有组件与守护测试。 |

### 8.3 本文改动如何验收（建议锚点，非本文件职责）

- 面板回归：`node Client/run-tests.js test-automation-panel.js`（19）/ `-bridge.js`（6）/ `-degrade.js`（5）**不得回退**。
- 工作台新增：建议 `Client/test-automation-workbench.js`——覆盖 ① 8 分区路由可达；② 桥缺失时全分区降级；③ toast/确认/错误文案快照；④ 键盘（`Ctrl+K`/`Esc`）焦点断言。
- RPA 不变：`automation/test-rpa-ast.js`（16）/ `test-rpa-recorder.js`（27）保持。

---

## 9. 引用

- 既有 UI 规范：[../automation/rpa.md](../automation/rpa.md) §9；[../automation/acceptance.md](../automation/acceptance.md) #33/#34；[../automation/testing.md](../automation/testing.md) §2.2；[../automation/troubleshooting.md](../automation/troubleshooting.md) §6 #26。
- 代码锚点：`Client/renderer/automation-panel/{panel.html,panel.js,panel.css,panel-templates.js}`、`.../rpa/rpa.{html,js,css}`、`Client/renderer/{index.html,style.css,app.js}`、`Client/preload.js`。
- 本包：[00-executive-summary.md](./00-executive-summary.md)、[05-system-architecture.md](./05-system-architecture.md)、[06-script-sdk-specification.md](./06-script-sdk-specification.md)、[07-data-model-and-api.md](./07-data-model-and-api.md)、[09-test-and-acceptance-plan.md](./09-test-and-acceptance-plan.md)、[10-implementation-roadmap.md](./10-implementation-roadmap.md)、[11-open-questions.md](./11-open-questions.md)。
