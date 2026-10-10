# 02 · 竞品功能矩阵（Competitor Matrix）

> 8 款竞品 × 7 大能力域。单元格格式：`结论` + 证据等级 `[A/B/C/D]`；官方未说明记 `未确认[D]`（**不等于不支持**）。
> 数据来源与访问日期见 [01-source-catalog.md](01-source-catalog.md)（2026-10-09）。机制细节见 [03-competitor-technical-analysis.md](03-competitor-technical-analysis.md)。
> 图例：**原生内置**=产品自带脚本/流程引擎；**官方集成**=官方文档支持的框架连接；**第三方集成**=社区/第三方；**理论可实现**=底层协议允许但官方未支持；**未确认**=官方资料未说明。

## 4.1 自动化执行模式

| 能力 | Multilogin | GoLogin | AdsPower | Dolphin Anty | Incogniton | Octo | Undetectable | MoreLogin |
|---|---|---|---|---|---|---|---|---|
| 浏览器内置脚本系统 | 有 Script Runner(Python)[A] | 无（Cookie Bot 非通用引擎）[A] | 有 RPA/RPA Plus[A] | 有 Script Builder[A] | 无[A] | 无[A] | 有 WebEngine JS 用户脚本[A] | 无（RPA 仅云手机）[A] |
| 外部脚本程序 | Selenium/Puppeteer/Playwright[A] | Node/Python SDK[A] | 本地 API[A] | Local/Remote API[A] | SDK/HTTP[A] | HTTP+框架[A] | HTTP/Selenium[A] | Local/Open API[A] |
| API 启动浏览器并执行 | 是[A/B] | 是[A/B] | 是[A/B] | 是[A/B] | 是[A] | 是[A] | 是[B] | 是[A] |
| 扩展程序执行自动化 | 否（扩展可装，非运行时）[A] | 否[A] | 扩展管理 API（非运行时）[A] | Script Builder 有 Extensions 块[A] | 未确认[D] | 未确认[D] | 未确认[C] | 扩展支持（非运行时）[C] |
| 可视化流程编排 | 未确认[D] | 无[D] | **有 RPA Plus**[A] | **有 Script Builder**[A] | 无[A] | 无[A] | 未确认[D] | 有（仅云手机）[A] |
| 录制用户操作生成脚本 | 未确认[D] | **明确不支持**[A] | 未确认[D] | 未确认[D] | 无（Synchronizer 是实时镜像非录制）[A] | 无[A] | 未确认[D] | 未确认[D] |
| 无头模式 | 是[A] | 是[A] | 是[A] | 是[A] | 是（仅 profile 浏览器，App 为 GUI）[A] | 是[A] | 未确认[D] | 是[A] |
| 启动后自动执行脚本 | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | `autoOpenUrls`（仅开 URL）[A] |
| 启动前初始化脚本 | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] |
| 关闭前清理脚本 | 未确认[D] | 未确认[D] | 仅清理「选项」（清标签/退出浏览器）[A] | Stop 块关 profile[A] | 未确认[D] | 未确认[D] | 未确认[D] | `closeAll`/`removeLocalCache`[A] |
| 多模式组合运行 | 未确认[D] | 未确认[D] | RPA+API 可并用[A] | Script Builder+API[A] | 未确认[D] | 未确认[D] | 未确认[D] | RPA+API+云手机[A] |

**结论要点**：只有 **AdsPower、Dolphin、MoreLogin** 提供真正的可视化流程编排；**GoLogin 明确不支持录制回放**；**8 家中无一家官方文档确认「启动前初始化脚本」或「关闭前清理脚本」钩子**（2026-10-09 核查确认：8 家皆无真正的 on-start/on-close 脚本钩子，仅有替代品）——这是本方案要自研补齐的空白域。

## 4.2 脚本语言与运行时

| 能力 | Multilogin | GoLogin | AdsPower | Dolphin Anty | Incogniton | Octo | Undetectable | MoreLogin |
|---|---|---|---|---|---|---|---|---|
| JS/TS | 是（框架侧）[A] | 是（Node SDK）[A] | 仅页面 Execute-JS[A] | 仅 Eval 块[A] | 是（Node/TS SDK）[A] | 是（框架侧）[A/B] | 是（页面脚本）[A] | 是（Puppeteer）[A] |
| Python | 是（Script Runner 原生）[A] | 是（SDK）[A] | 是（Selenium 示例）[A/B] | 是（框架侧）[A/B] | 是（SDK）[A] | 是（Pyppeteer/Playwright/Selenium）[A/B] | 是（Selenium）[A/B] | 是（Selenium/Playwright）[A] |
| Node.js 运行时 | 未确认[D] | 是（SDK 自身即 Node）[A] | 未确认[D] | 未确认[D] | 是[A] | 未确认[D] | 未确认[D] | 是（示例用 Node）[A] |
| 页面上下文执行 | 框架侧[A] | 框架侧[A] | Execute-JS 页面内[A] | Eval 页面内[A] | 框架侧[A] | 框架侧[A] | WebEngine 页面内[A] | 框架侧[A] |
| 独立进程执行 | 是（CDP/WebDriver/REST）[A] | 是[A] | 是[A] | 是[A] | 是[A] | 是[A] | 是（HTTP/CDP）[A] | 是（CDP）[A] |
| 自定义依赖 | Script Runner 未确认[D] | 是（npm/pip）[A] | 未确认[D] | 未确认[D] | 是（npm/pip）[A] | 是（自建工程）[B] | 未确认[D] | 是（用户侧）[A] |
| npm/包管理 | 未确认[D] | 是[A] | 未确认[D] | 未确认[D] | 是[A] | 是[B] | 未确认[D] | 是[A] |
| 异步/超时/取消 | 仅 script-stop[A]；超时[D] | stop/exit[A]；超时[D] | 进程级 Timeout[A]；停止任务[A] | 播放暂停/停止[A] | client timeout 60s[A]；无运行级 cancel | start timeout 秒[A] | MCP `UNDETECTABLE_TIMEOUT` 60s[A] | CLI `--timeout` 15s[A] |
| 多文件/模块 | 未确认[D] | 是[A] | 子流程复用[A] | 无模块系统（文件读写）[A] | 是[B] | 是[B] | 未确认[D] | 用户侧[C] |
| 参数/环境变量 | `script_params`[A] | token/profile_id/extra_params[A] | 流程变量/系统变量[A] | 变量+系统变量[A] | .env/CLI flags[A/B] | `OCTO_*` env[A] | MCP env[A/B] | `templateParameter`[A] |
| 浏览器内 API 与外部 API 混合 | 是[A] | 是[A] | Execute-JS+外部[A] | Eval+外部[A] | 是[B] | 是[B] | 是[A] | 是[A] |
| 明确语言/依赖版本要求 | 未确认[D] | Node/Python SDK 版本[A] | App/kernel 版本门槛[A] | ChromeDriver 版本对齐[A] | Node16+/Py3.9+[A] | chromedriver 对齐[A] | 未确认[D] | 客户端版本门槛[A] |

**结论要点**：**GoLogin、Incogniton、MoreLogin** 提供最完整的「自建工程」开发体验（真实 Node/Python 工程 + npm/pip 依赖）；**Multilogin 的 Script Runner 是唯一「产品内置 Python 引擎」**；可视化产品（AdsPower/Dolphin）的脚本运行时仅到「页面内 JS 片段」层，无模块系统。

## 4.3 浏览器控制能力（经官方 API / 官方集成框架）

| 能力 | ML | GL | ADP | DA | INC | Octo | UD | MoreL |
|---|---|---|---|---|---|---|---|---|
| 配置文件 CRUD | ✅A | ✅A | ✅A | ✅A | ✅A | ✅A | ✅A | ✅A |
| 实例启停 | ✅A | ✅A | ✅A | ✅A | ✅A | ✅A | ✅A | ✅A |
| 标签页/窗口 | 框架B | ✅CLI/框架A | ✅A | ✅A | ✅A | ✅A | ✅A | 框架A |
| 导航/前进后退/刷新 | 框架B | ✅A | ✅A | ✅A | 框架B | 框架A | ✅A | 框架A |
| DOM 查询与元素操作 | 框架B | ✅A | ✅A | ✅A | 框架B | 框架A | ✅A | 框架A |
| 点击/输入/滚动/拖拽/键盘 | 框架B | ✅A | ✅A | ✅A | 框架B | 框架A | ✅A | 框架A |
| 截图/文件下载 | 框架B | ✅A | 截图✅A/下载[D] | 截图B/下载[D] | 框架B | 截图/PDF✅A | 截图✅A/下载[D] | 框架A |
| Cookie | ✅导入导出A | ✅导入导出/清空A | ✅查询A | ✅本地+远程A | ✅A | 页面级✅A/整profile❌A | ✅A | ✅A |
| localStorage | 未确认D | ✅CLI A | 未确认D | ✅本地A | 框架B | 框架C | ✅cleardata A | ✅removeLocalCache A |
| sessionStorage | 无[D] | 无[D] | 无[D] | 无[D] | 无[D] | 无[D] | 无[D] | 无[D] |
| IndexedDB | 无细粒度[D] | 存储开关(默认关)[A] | 清除/备份/同步[A] | 仅同步开关[A] | 无细粒度[D] | 与 LocalStorage 合并开关[A] | 无细粒度[D] | ✅removeLocalCache A |
| 网络请求监听 | 未确认D | 未确认D | Listener Request A | 未确认D（CDP C） | ✅官方示例B | 桌面框架A/移动❌A | 未确认D | 未确认D |
| 请求头/网络配置 | 框架B | 框架B | 未确认D | 未确认D | 框架B | 框架A | 未确认D | 框架A |
| 页面 JS 执行 | 框架B | ✅CLI eval A | ✅Execute-JS A | ✅Eval A | 框架B | ✅A | ✅evaluate A | ✅MCP/CDP A |
| 页面事件监听 | 框架B | 框架B | Listener A | 未确认D | 框架B | 框架A | 未确认D | 框架A |
| 文件上传/下载 | 框架B | ✅上传A | ✅Input File A/下载[D] | ✅File upload A | 框架B | 框架A | 未确认D | 框架A |
| 浏览器通知/弹窗 | 框架B | 框架B | 未确认D | ✅Popups A | 框架B | 框架A | 未确认D | 框架A |
| 多标签切换 | 框架B | ✅A | ✅A | ✅A | ✅A | ✅A | ✅A | 框架A |
| 异常检测/恢复 | 未确认D | doctor A | 未确认D | 未确认D | 未确认D | 未确认D | 未确认D | 未确认D |
| 运行状态查询 | ✅profile-status A | ✅A | ✅A | 未确认D | ✅A | 未确认D | ✅status A | ✅A |

**结论要点**：**sessionStorage 8 家皆无持久化控制**；**IndexedDB**：GoLogin 存储开关(默认关)、AdsPower 清除/备份、Dolphin 仅同步开关、Octo 与 LocalStorage 合并开关、MoreLogin 可清；**网络拦截**只有 AdsPower（Listener）、Incogniton（官方示例）、Octo（桌面框架）有据；**异常检测/恢复**几乎无人文档化（GoLogin `doctor` 是唯一沾边项）。这些是自研差异化的高价值区。

## 4.4 自动化框架集成

| 框架 | ML | GL | ADP | DA | INC | Octo | UD | MoreL |
|---|---|---|---|---|---|---|---|---|
| Playwright | ✅connectOverCDP[A/B]（仅 Mimic） | ✅[A/B] | ✅[A/B] | ✅connectOverCDP[A/B] | ✅推荐[A/B] | ✅[A/B] | 博客声明[C] | ✅官方指南[A] |
| Puppeteer | ✅（仅 Mimic）[A/B] | ✅wsUrl[A/B] | ✅ws.puppeteer[A/B] | ✅browserWSEndpoint[A/B] | ✅[A/B] | ✅[A/B] | 博客声明[C] | ✅[A] |
| Selenium | ✅remote[A/B]（无本地） | ✅debuggerAddress[A/B] | ✅webdriver[A/B] | ✅改版 chromedriver[A] | ✅（标注 known issue）[A/B] | ✅debuggerAddress[A/B] | ✅官方仓库[A/B] | ✅debugPort[A] |
| WebDriver | 是[A] | 是[A] | 是[A] | 是[A] | 是[A] | 是[A] | 是[C] | ✅返回 webdriver 路径[A] |
| CDP | ✅[A] | ✅[A] | ✅[A] | ✅原生[A] | ✅[A] | ✅原生[A] | ✅websocket_link[B] | ✅原生[A] |
| 厂商自有 HTTP API | ✅云端+Launcher[A] | ✅[A] | ✅[A] | ✅本地+远程[A] | ✅[A] | ✅云端+本地[A] | ✅[A] | ✅本地+Open[A] |
| 厂商 SDK/CLI | ✅xcli（无 SDK）[A] | ✅Node/Py/3CLI/MCP[A] | ✅headless CLI（无 SDK）[A] | 无[A] | ✅Node/Py/CLI/MCP[A] | 无[A] | 无 SDK[A] | ✅ml-cli+demo+MCP[A] |
| 多标签 | ✅B | ✅A | ✅A | ✅A | ✅A | ✅A | ✅A | ✅A |
| 并发控制 | 未确认（仅 RPM）[D] | ✅Cloud 1–4/本地 10–20[A] | ✅线程≤100[A] | 未确认[C] | ✅单 profile 单会话[A] | ✅1 容器/会话[A] | 未确认[C] | ✅团队锁[A] |
| 事件订阅 | 未确认[D] | 未确认[D] | Listener[A] | 未确认[D] | 未确认[D] | ✅Action Log WS[A] | 未确认[D] | 未确认[D] |
| 断开/清理语义 | ✅stop[A] | ✅stop/exit[A] | ✅close+stop[A/B] | ✅close 不杀+stop 同步[A] | ✅Browser.close+轮询[A] | ✅stop/force_stop[A] | ✅stop/clearcache[A] | ✅close/closeAll[A] |
| 官方可运行示例 | ✅[A/B] | ✅[A/B] | ✅5 语言+Firefox[A/B] | ✅Puppeteer/Playwright/Selenium[A/B] | ✅11+2+Python[A/B] | ✅多语言片段[A/B] | ✅Selenium 仓库[A/B] | ✅官方指南[A] |

**关键区分（用户 §4.4 特别要求）**：`connectOverCDP`（单 context 视角、low-fidelity、close 不杀浏览器）与原生 `wsEndpoint`/`connect`（full 多 context）**不是同一层面**；厂商「实例管理 API」与「页面自动化 API」也必须分开——8 家全部是「厂商 API 管 profile/启动 → 返回 CDP/WebDriver 句柄 → 框架接管页面」。**没有任何一家把页面自动化 API 内置到厂商 API 里**（AdsPower/Undetectable 的 browser/* 端点是最接近的例外，但能力远小于 CDP）。

## 4.5 脚本编辑器与开发体验

| 能力 | ML | GL | ADP | DA | INC | Octo | UD | MoreL |
|---|---|---|---|---|---|---|---|---|
| 内置编辑器 | 无（建议外部 IDE）[A] | 无[A] | ✅RPA 画布[A] | ✅Script Builder 画布[A] | 无[A] | 无[A] | WebEngine 简易文本框[A] | ✅RPA 画布（云手机）[A] |
| 代码高亮/补全/lint | 无[A] | 无[A] | 未确认[D] | 未确认[D] | 无[A] | 无[A] | 未确认[D] | 未确认[D] |
| 断点/单步/Console | 无[A] | 无[A] | ✅调试（任一步/从头）+日志面板[A] | ✅单步回放+日志[A] | 无[D] | 无[D] | 未确认[D] | ✅视图树调试器（非代码单步）[A] |
| 变量查看/调用栈 | 无[A] | 无[A] | 部分（日志）[A] | 未确认[D] | 无[D] | 无[D] | 未确认[D] | 部分（元素属性）[A] |
| 脚本模板 | ✅profile 模板[A] | 无脚本模板[A] | ✅Marketplace 模板[A] | ✅场景复制/转移[A] | 无[A] | 无脚本模板（profile 模板有）[A] | ✅2 个内置 WebEngine 脚本[A] | ✅RPA 市场+个人模板[A] |
| 导入导出 | ✅profile/cookie[A] | ✅profile/cookie/storage[A] | ✅JSON[A] | ✅e-mail 转移（无文件导出）[A] | ✅profile JSON/cookie[A] | ✅profile/cookie[A] | ✅profile(.prof)[A]/脚本[D] | ✅workflow/profile[A] |
| 版本管理 | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] |
| 团队共享/权限 | ✅工作区角色[A] | ✅profile 共享/角色[A] | ✅分享码+成员权限[A] | ✅转移+团队可见性[A] | ✅角色/组[A] | ✅子账号/权限[A] | ✅角色/云组[A] | ✅团队/组/授权模式[A] |

**结论要点**：**8 家全部没有脚本版本管理**（这是本方案要自研的确定性空白）；**8 家全部没有「浏览器厂商提供的代码级编辑器」**（AdsPower/Dolphin/MoreLogin 是画布式，非代码 IDE）——用户 spec 要求 Monaco + `automation.d.ts` 正是对此空白的回应。

## 4.6 脚本运行和任务管理

| 能力 | ML | GL | ADP | DA | INC | Octo | UD | MoreL |
|---|---|---|---|---|---|---|---|---|
| 任务状态机 | 仅 profile-status[D] | ✅CLI sessions[A] | ✅任务状态+日志[A] | 日志/回放（非正式状态机）[C] | 未确认[D] | ✅profile 状态[A] | 无[D] | ✅云运行时 STARTING/RUNNING/CLOSED[A] |
| 单次执行 | ✅A | ✅A | ✅A | ✅A | ✅A | ✅A | ✅A | ✅A |
| 定时执行 | 未确认[D] | ✅CLI jobs[A] | ✅once/daily/weekly/monthly[A] | 未确认[D] | 外部 OS 调度[A/B] | ✅仅提醒（非执行）[A] | 未确认[D] | ✅云手机 RPA 定时[A] |
| 周期执行 | 未确认[D] | ✅jobs[C] | ✅[A] | 未确认[D] | ✅--repeat[A/B] | 未确认[D] | 未确认[D] | ✅[A] |
| 手动触发 | ✅A | ✅A | ✅[A] | ✅[A] | ✅[A] | ✅[A] | ✅[A] | ✅[A] |
| 指定 profile 触发 | ✅[A] | ✅[A] | ✅[A] | ✅[A] | ✅[A] | ✅[A] | ✅[A] | ✅[A] |
| 多 profile 批量 | ✅profile_ids[]A | ✅batch[A] | ✅≤5000/task[A] | ✅多选运行[A] | ✅SDK 循环[A/B] | ✅批量[A] | ✅MCP batch[A] | ✅批量端点[A] |
| 任务队列 | 未确认[D] | ✅batch --concurrency[A] | ✅超线程排队[A] | 未确认[D] | 无（单会话锁）[A] | 未确认[D] | 未确认[D] | ✅团队锁[A] |
| 并发数限制 | 未确认[D] | ✅[A] | ✅线程≤100[A] | 未确认[C] | ✅单会话[A] | ✅1 容器/会话[A] | 未确认[C] | ✅[A] |
| 优先级 | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] |
| 超时 | 未确认[D] | 未确认[D] | ✅进程级[A] | ✅120s 启动（MCP）[B] | ✅client 60s[A] | ✅start timeout[A] | ✅MCP 60s[A] | ✅CLI 15s[A] |
| 失败重试 | 未确认[D] | ✅指引+Web Unlocker maxRetries[A] | ✅仅「重跑」[C] | 未确认[D] | 无（明确警告不幂等）[A] | 无（需自行退避）[A] | 未确认[D] | ✅53 操作重试矩阵[A] |
| 指数退避 | 未确认[D] | ✅指引[A] | 未确认[D] | 未确认[D] | 无[D] | ✅须遵 Retry-After[A] | 未确认[D] | ✅退避+抖动[A] |
| 暂停/恢复 | 未确认[D] | ✅close/sessions[A] | ✅Stop task[A] | ✅播放暂停[A] | ✅Ctrl+C/forceStop[A/B] | ✅stop/force_stop[A] | 未确认[D] | RPA 任务取消[A]；浏览器未确认[D] |
| 幂等性控制 | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | ✅明确不幂等[A] | ✅明确不幂等[A] | 未确认[D] | 无幂等键（查询状态后重试）[A] |
| 执行日志 | 未确认[D] | ✅jobs[A] | ✅Task Log[A] | ✅Show logs[A] | ✅result.json[A] | ✅debug.log+Action Log[A] | 未确认[D] | ✅子任务记录[A] |
| 历史记录 | 未确认[D] | ✅jobs[A] | ✅Task Log[A] | 未确认[D] | ✅profile 历史[A] | ✅Action Log 30 天[A] | 未确认[D] | ✅操作日志[A] |
| 任务产物 | 未确认[D] | ✅截图/PDF[A] | ✅截图[A] | ✅文件写出[A] | ✅output/[A] | ✅截图/PDF[A] | 未确认[D] | 未确认[D] |
| 资源清理 | ✅stop[A] | ✅stop/exit[A] | ✅清理选项[A] | ✅Stop 块[A] | ✅forceStop[A] | ✅force_stop[A] | ✅cleardata[A] | ✅closeAll/removeLocalCache[A] |

**结论要点**：**优先级（priority）在 8 家中全部未确认**；**内置调度器**只有 AdsPower、MoreLogin（云手机 RPA）真正具备，GoLogin 用 CLI jobs，Incogniton 靠外部 OS 调度，Octo 的任务只是「提醒」；**幂等性**只有 Incogniton/Octo 明确声明「不幂等」，MoreLogin 明确「无公开幂等键」。这三项（优先级、内置调度+幂等语义、任务恢复）是自研的核心补强点。

## 4.7 脚本生态和商业化能力

| 能力 | ML | GL | ADP | DA | INC | Octo | UD | MoreL |
|---|---|---|---|---|---|---|---|---|
| 模板库 | ✅profile 模板[A] | 无脚本模板[D] | ✅Marketplace[A] | ✅场景转移[A] | 无[D] | ✅profile 模板[A] | ✅2 内置脚本[A] | ✅RPA 市场[A] |
| 脚本市场 | 无[D] | 无[D] | ✅RPA 市场[A] | 无[D] | 无[D] | 无[D] | 无[D] | ✅RPA 市场[A] |
| 用户自定义脚本 | ✅Script Runner[A] | 无通用引擎[A] | ✅RPA[A] | ✅Script Builder[A] | ✅外部脚本[A] | ✅外部脚本[A] | ✅WebEngine[A] | ✅RPA（云手机）[A] |
| 脚本分享 | 未确认[D] | 未确认[D] | ✅分享码[A] | ✅e-mail 转移[A] | 未确认[D] | 未确认[D] | 未确认[D] | ✅市场发布[A] |
| 团队共享 | ✅[A] | ✅[A] | ✅[A] | ✅[A] | ✅[A] | ✅[A] | ✅[A] | ✅[A] |
| 脚本版本管理 | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] |
| 审核/发布 | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | ✅市场审核[A] |
| 收费脚本/订阅 | 未确认[D] | 未确认[D] | 历史「用户模板出售」（2022，C） | 未确认[D] | 未确认[D] | 未确认[D] | 未确认[D] | ✅市场付费模板[A] |
| 组织/成员权限 | ✅工作区角色[A] | ✅角色[A] | ✅成员权限[A] | ✅团队[A] | ✅角色/组[A] | ✅子账号[A] | ✅角色/云组[A] | ✅团队/组[A] |
| 使用量统计 | ✅object-stats[A] | ✅云用量[A] | ✅Task Log[C] | 未确认[D] | 未确认[D] | ✅Action Log[A] | 未确认[D] | ✅操作日志[A] |
| profile 授权限制 | 按套餐[A] | 按套餐[A] | Free 2/Pro 10–100/Ent 5000+[A] | Free 5→3(2026-10)/Starter 20–60/Team 300/Ent 1000+[A] | Free→3/Starter Plus 10/Ent 50/Prof 150/Custom 500+[A] | Lite 3/Starter 30/Base 200/Team 600/Adv 100k[A] | Free 5 云/Base 50/Pro 100/Custom 10200[A] | Free 2/Pro 10+[A] |
| API 调用限额 | 50/75/100/100 RPM[A] | 300/500/800/1200 RPM[A] | 5/15/25 req/s[A] | 本地1500/min·远程500/min[A] | 未公布[D] | 50–200 RPM/500–3000 RPH[A] | 未公布[D] | 200/min GCRA[A] |
| 自动化功能的订阅门槛 | Pro 10+[A] | Free 无 API[A] | 需付费[A] | 需付费（Free 402）[A] | Entrepreneur $29.99[A] | Base €79[A] | Base+（Free 不可）[A] | **Free 即含 Local API**[A] |

**结论要点**：**脚本版本管理、脚本审核/发布、收费脚本在 8 家中几乎全为空白**（仅 AdsPower/MoreLogin 的 RPA 市场沾边，且是可视化流程而非代码脚本）；**API 限额**普遍按套餐 RPM 阶梯 + 429 退避，GoLogin 最严（429 吊销 token）、Octo 最细（请求加权 + 400 错误扣费）。

---

## 8. 跨产品通用约束（用于架构设计输入）

1. **内存账**：每个 profile 常驻约 300–500MB（GoLogin 官方、AdsPower 线程模型一致），单机并发应按内存反推，而非 CPU 核数。
2. **disconnect-preserve vs close-kill**：`disconnect` 通常保留浏览器进程，`close` 杀进程；Dolphin/Octo 明确「close 不杀，需显式 stop」。
3. **端口策略**：多为启动时动态分配并回读（Dolphin/AdsPower/GoLogin），Octo 支持 pin 固定 `debug_port`（1024–65534）便于编排。
4. **一次性 profile**：Octo one-time profile（4× RPM、auto-delete）是唯一成熟的「用完即焚」语义。
5. **429 策略**：必须指数退避 + 抖动 + 读限流响应头；GoLogin 最严（可吊销 token），Octo 按权重计费，MoreLogin 用业务码 35000 而非 HTTP 429。
6. **本地回环默认无鉴权**：Incogniton/Octo/Undetectable 的本地 API 默认无 token（靠回环隔离），**不可暴露到非回环**。
7. **版本锁定**：ChromeDriver/kernel/Playwright 客户端版本须与对端匹配，是跨产品共同痛点。
8. **凭证与安全**：本地 API key/token 泄露面大（Multilogin 30 分钟 token、MoreLogin 1 小时 OAuth），需在设计里做 token 轮换与最小权限。

> 机制层面的深度分析（每家脚本引擎运行在哪、如何通信、如何隔离、证据等级 A/B/C/D）见 [03-competitor-technical-analysis.md](03-competitor-technical-analysis.md)；技术选型见 [04-automation-technology-selection.md](04-automation-technology-selection.md)。
