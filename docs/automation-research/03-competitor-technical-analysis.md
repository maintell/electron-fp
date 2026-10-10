# 03 · 竞品实现机制技术分析（Technical Analysis）

> 对 8 款竞品逐一回答 user spec 第五节 14 个技术问题，并标注证据等级 **A/B/C/D**。
> 原则：**不因功能相似就假定架构相同**；无法从公开资料确定的，提出最小验证实验而非猜测。
> 证据等级：A 官方文档/源码明确 · B 官方示例可验证 · C 公开资料推断 · D 证据不足。数据来源见 [01-source-catalog.md](01-source-catalog.md)（2026-10-09）。
> 通用免责：8 家**均未公开**其脚本引擎/服务端的内部实现源码；下述「机制」是**基于公开接口行为 + 官方文档 + 官方示例**的可验证推断，凡推断均标 C。

---

## 0. 一句话架构定位（先给结论，细节见分节）

| 产品 | 执行引擎位置 | 通信通道 | 是否内置脚本运行时 | 隔离粒度 |
|---|---|---|---|---|
| Multilogin | 本地 Launcher 内的 Python Script Runner + 用户外部进程 | 云端 REST + 本地 Launcher REST/WS | 是（Python） | 按 profile |
| GoLogin | 用户外部 Node/Python 进程 + 远程 Cloud Browser | 云端 REST + CDP ws + SDK | 否 | 按 profile/云会话 |
| AdsPower | 客户端内 RPA 引擎 + 用户外部进程 | 本地 REST + RPA 内部 | 是（可视化+Execute-JS） | 按 profile/任务线程 |
| Dolphin Anty | 客户端内 Script Builder + 用户外部进程 | 本地 REST + 远程 v2 + CDP | 是（可视化+Eval） | 按 profile |
| Incogniton | 用户外部 Node/Python 进程 | 本地 REST（无鉴权）+ CDP/WebDriver | 否 | 按 profile（锁文件） |
| Octo | 用户外部进程 | 云端 v2 + 本地 REST + CDP | 否 | 按 profile/容器 |
| Undetectable | 用户外部进程 + WebEngine 页面脚本 | 本地 REST + CDP | 部分（WebEngine 页面脚本） | 按 profile |
| MoreLogin | 用户外部进程 + 云手机 RPA | 本地 REST + Open API + CDP | 否（浏览器）；是（云手机 RPA） | 按 profile/团队锁 |

**关键结论**：**没有一家把「用户代码」跑在浏览器渲染进程里**（WebEngine 用户脚本除外，那是页面注入）；主流是「厂商 API 管实例 → 返回 CDP/WebDriver 句柄 → 用户进程内的框架执行」。这意味着**自研若采用「Electron main 内嵌脚本运行时 + 每 profile 独立会话」是差异化路线**，但也意味着要自担隔离/资源/崩溃恢复责任（竞品把这些推给用户进程）。

---

## 1. Multilogin

| # | 技术问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 引擎运行在哪 | Python **Script Runner** 在本地 Launcher 内运行预定义脚本（如 `cookie_robot.py`，位于 `mlx/deps/scripts`）；用户自写自动化则在用户进程 | A/B |
| 2 | 主/渲染/独立进程 | Script Runner = Launcher 管理的独立 Python 进程；框架自动化 = 用户进程 | A |
| 3 | 通信方式 | 云端 REST（token）驱动 profile；启动返回 `port`，用户以 Selenium remote / `connectOverCDP` / Puppeteer `connect` 接入 | A/B |
| 4 | profile 间隔离 | 每 profile 独立加密实例；并发受套餐席位限制 | A |
| 5 | 参数/结果/错误传递 | `script_params:[{name,value}]`（string/int/float/JSON）；结果无结构化回传文档 | A |
| 6 | 依赖管理 | Script Runner 的依赖安装**未文档化** | D |
| 7 | 浏览器意外关闭 | 未文档化；`profile/stop` 幂等（500「已停止」为良性） | D/A |
| 8 | 防任务失控 | 未文档化（无超时/资源限制文档） | D |
| 9 | 长时任务 | 未文档化 | D |
| 10 | 调试 | 无内置调试；建议外部 IDE | A |
| 11 | 存储 | profile 元数据在云端；脚本文件在本地 `mlx/deps/scripts` | A |
| 12 | 批量/并发 | `script-start` 支持重复 `--profile-id`；并发受席位 | A |
| 13 | 权限/密钥 | 云端 JWT（30min）+ automation token（可配）；工作区角色 | A |
| 14 | 不拖垮浏览器 | 脚本运行在 Launcher 管理的独立进程，理论上与浏览器进程隔离 | C |

**证据表**：帮助中心/自动化 hub 存在 A；v1/v2/v3 端点 + Launcher 基址 A；30min token A；RPM A；Script Runner(Python)+params A/B；Selenium/Puppeteer/Playwright 启动模式 A/B；核心版本保留 5 个 A；**RPA 不支持 A**；端点 schema C（SPA 抓取失败）；localStorage/IndexedDB、调度、重试、市场 D。

---

## 2. GoLogin

| # | 技术问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 引擎运行在哪 | 用户 Node/Python 进程；Cloud Browser 时浏览器在远端、控制在本端 | A |
| 2 | 进程 | 独立进程（SDK 拉起 Orbita 返回 `wsUrl`/`debuggerAddress`；CLI daemon 用 `connectOverCDP`） | A |
| 3 | 通信 | REST（`api.gologin.com`）+ CDP ws + Cloud `/connect` | A |
| 4 | 隔离 | 每 profile 独立；Cloud 会话 1–4 并发 | A |
| 5 | 参数/结果/错误 | SDK 参数（token/profile_id/extra_params）；`DEBUG=gologin` 日志 | A |
| 6 | 依赖 | 标准 npm/pip 工程，用户自管 | A |
| 7 | 浏览器意外关闭 | `stop({posting:false})`/`exit()`；云 `DELETE /browser/{id}/web` | A |
| 8 | 防失控 | 无内置；**建议并发 10–20**、`ulimit -n 65536` | A |
| 9 | 长时任务 | Cloud Browser 小时配额；无长任务守护文档 | A/D |
| 10 | 调试 | 无内置编辑器；CLI `doctor` 诊断 | A |
| 11 | 存储 | profile 云端；localStorage 可导出导入；脚本在用户侧 | A |
| 12 | 批量/并发 | `batch --targets --concurrency N`；云并发按套餐 | A |
| 13 | 权限/密钥 | Bearer JWT；**429 永久吊销 token**；Free 无 API | A |
| 14 | 不拖垮浏览器 | 用户进程与浏览器分离；Cloud 侧由 GoLogin 托管 | A |

**证据表**：docs/基址/OpenAPI1.0/Bearer A；Node+Py 官方 SDK A/B；Puppeteer/Playwright/Selenium 连接 A/B；Cloud `/connect` A/B；Cookie Bot/Run-with-Sync A；CLI runbooks/batch/jobs A；MCP+skills A；限流/token 吊销/Cloudflare/创建上限 A；定价分层 A；版本 pin A；sessionStorage/IndexedDB/调度/优先级/超时/市场 D。

---

## 3. AdsPower

| # | 技术问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 引擎运行在哪 | **客户端内 RPA 引擎**（V1/RPA Plus，块式图）+ 用户外部进程 | A |
| 2 | 进程 | RPA 在客户端内执行；框架自动化在用户进程 | A |
| 3 | 通信 | 本地 REST `local.adspower.net:50325`（Bearer）；启动返回 `ws.selenium`/`ws.puppeteer`/`webdriver` 三元组 | A/B |
| 4 | 隔离 | 每 profile 独立；任务线程 ≤100 | A |
| 5 | 参数/结果/错误 | 流程变量/系统变量 + Execute-JS 变量注入；日志错误以「!」标注 | A |
| 6 | 依赖 | RPA 内**无 npm/模块系统文档**；Execute-JS 为代码注入 | D |
| 7 | 浏览器意外关闭 | 「After task completes」选项（清标签/存标签/退出浏览器/保持打开）；无崩溃恢复文档 | A/D |
| 8 | 防失控 | **进程级 Timeout**（0=禁用）；「Stop task」停止该任务全部运行 profile | A |
| 9 | 长时任务 | 无专门文档；任务跨设备可见但仅本机可执行 | A/D |
| 10 | 调试 | RPA Plus 可从任意步骤/从头调试 + 调试日志面板 | A |
| 11 | 存储 | 流程/任务在客户端；≤3000 进程、每组 ≤500；JSON 导入导出 | A |
| 12 | 批量/并发 | 单任务 ≤5000 profile；线程 ≤100，超出排队 | A |
| 13 | 权限/密钥 | API key（付费）+ 成员 RPA 权限；key 重置需重启服务 | A |
| 14 | 不拖垮浏览器 | RPA 在客户端进程内，理论上是共享进程（**风险点**） | C |

**证据表**：Local API 端口/鉴权/付费门槛/headless CLI A；5 语言连接示例 A/B；RPA V1+Plus（Execute-JS、循环、错误处理）A；调度/100 线程/5000 profile/任务日志 A；市场+分享码+成员权限 A；限流（含三方冲突）A；RPA 积分/付费模板 C（2022 新闻）；录制回放/init 脚本/版本管理/重试/下载 D。

---

## 4. Dolphin Anty

| # | 技术问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 引擎运行在哪 | **客户端内 Script Builder**（块式图）+ 用户外部进程 | A |
| 2 | 进程 | Script Builder 在客户端内；框架自动化在用户进程 | A |
| 3 | 通信 | 本地 REST `localhost:3001/v1.0`（JWT）+ 远程 v2 + CDP | A |
| 4 | 隔离 | 每 profile 独立；并发未文档化 | A/D |
| 5 | 参数/结果/错误 | 变量 + 系统变量（`Browser_profile_id` 等）；Eval 返回值可入变量 | A |
| 6 | 依赖 | 无模块系统；文件读写 TXT/CSV/JSON/DOCX/XLSX | A |
| 7 | 浏览器意外关闭 | Stop 块（红线程）关 profile；`stop` 同步数据到云 | A |
| 8 | 防失控 | 播放暂停/停止；MCP 120s 启动超时；`E_BROWSER_RUN_DUPLICATE` | A/B |
| 9 | 长时任务 | 未文档化 | D |
| 10 | 调试 | 单步回放（到达某步暂停/停止/改块/重跑）+ Logs | A |
| 11 | 存储 | 场景在客户端/云；场景**按 e-mail 转移**（无文件导出） | A |
| 12 | 批量/并发 | 多 profile 多选运行；并发未文档化（社区报 429/499） | A/C |
| 13 | 权限/密钥 | JWT（创建时可配过期，仅显示一次）；团队/可替换资源 | A |
| 14 | 不拖垮浏览器 | Script Builder 在客户端进程内（**风险点**） | C |

**证据表**：Local API（3001/v1.0/JWT/start-stop/cookies/localStorage）A；Remote v2+Darkwing+OpenAPI+500/min A；CDP 连接+官方示例 A/B；Script Builder 块集（Eval/Extensions/Popups/循环/数据块）A；场景转移（限额/复制移动）A；付费门槛 A；计划结构 A；无调度/无市场/无 SDK/无版本管理 D；OpenAPI 1.0.7/402/429/499 C（社区）。

---

## 5. Incogniton

| # | 技术问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 引擎运行在哪 | **用户外部 Node/Python 进程**（无内置引擎） | A |
| 2 | 进程 | 独立进程：SDK/HTTP → App(:35000) → CDP/WebDriver → 浏览器 | A |
| 3 | 通信 | 本地 REST（无 token）+ CDP DevTools URL | A |
| 4 | 隔离 | 每 profile **锁文件** `.incogniton/locks/` 拒绝第二个进程；单会话 | A |
| 5 | 参数/结果/错误 | `.env`/CLI flags；启动错误返回 `{status:"error",message}` 但 **HTTP 200** | A |
| 6 | 依赖 | 标准 npm/pip 工程 | A |
| 7 | 浏览器意外关闭 | 关闭 tab → 发 CDP `Browser.close` → 轮询状态回 `Ready`（因 `stop()` 可能丢新写 cookie） | A |
| 8 | 防失控 | client `timeout` 60s；launchTimeout 60s；**无运行级 cancel**，`forceStop` 杀 profile | A |
| 9 | 长时任务 | 靠外部 OS 调度器（Task Scheduler/launchd）或 `--repeat`（不重叠） | A/B |
| 10 | 调试 | 无内置编辑器；SDK 带完整类型定义 | A |
| 11 | 存储 | `result.json` + `output/<timestamp>/` 产物；profile JSON 可导入导出 | A/B |
| 12 | 批量/并发 | SDK 循环；每 profile 单会话；`asyncio` 协调多 profile | A/B |
| 13 | 权限/密钥 | **本地 API 无 token**（靠回环）；云 MCP 走 `v5api.incogniton.com` | A |
| 14 | 不拖垮浏览器 | 用户进程与浏览器分离；App 本身 GUI，Linux/Docker 不可用 | A |

**证据表**：本地 REST 无 token + 端点表 A；Node+Py SDK+CLI+示例仓库 A；Playwright/Puppeteer/Selenium A/B；无内置引擎/可视化/录制 A（缺失）；Synchronizer 行为与 5 上限 A；Cookie Collector A；MCP 19 工具 A；仅桌面端 A；定价与门槛 A；「20 窗口」C（与 A 冲突）；IndexedDB/init/清理/统计/限流 D。

---

## 6. Octo Browser

| # | 技术问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 引擎运行在哪 | **用户外部进程**（无内置引擎） | A |
| 2 | 进程 | 独立进程：云端 v2 管 profile，本地 :58888 启停，用户进程接 CDP/WebDriver | A |
| 3 | 通信 | 云端 REST（`X-Octo-Api-Token`）+ 本地 REST（无鉴权）+ CDP | A |
| 4 | 隔离 | 每 profile；**1 容器/并行会话**（Docker 指引）；pin `debug_port` 防端口竞争 | A |
| 5 | 参数/结果/错误 | 响应信封 `{success,msg,data,code}`；400 校验错误 `{"validation_error":{...}}` | A |
| 6 | 依赖 | 用户自建工程 | B |
| 7 | 浏览器意外关闭 | 停止时须显式 stop；**弃置 profile 阻塞再启动**；`force_stop`（≥1.7） | A |
| 8 | 防失控 | start `timeout`（秒）；请求加权（force_stop=2、one-time=4）；**400 错误扣 6 RPM/1 RPH** | A |
| 9 | 长时任务 | 无长任务守护；Docker 建议 1 容器/会话 | A |
| 10 | 调试 | 无内置编辑器；Action Log WS（10 事件，24h 流） | A |
| 11 | 存储 | profile 云端；Action Log UI 30 天；`debug.log` | A |
| 12 | 批量/并发 | 批量 profile 操作；按限流与容器数 | A |
| 13 | 权限/密钥 | 云端 token（团队共享）；**2FA 开启则本地 API 无法登录** | A |
| 14 | 不拖垮浏览器 | 用户进程与浏览器分离；移动 CDP 有多项限制（`page.route()` 无效等） | A |

**证据表**：云端 v2+基址+token+信封+分页 A；本地 :58888+端点+错误码 A；Playwright/Puppeteer/Pyppeteer/Selenium/CDP 示例 A/B；one-time profile（4×RPM/auto-delete）A；Cookie Robot 且不可 API 启动 A；Docker/K8s A；限流与加权 A；Profile 任务（提醒、≤10）A；Action Log A；团队权限 A；无内置引擎/可视化/录制 A；无 SDK/CLI D；任务层级冲突 A vs C；IndexedDB/init/清理 D。

---

## 7. Undetectable

| # | 技术问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 引擎运行在哪 | **用户外部进程** + **WebEngine 页面内 JS 用户脚本**（手动右键运行） | A |
| 2 | 进程 | 外部进程走 HTTP/CDP；WebEngine 脚本在页面上下文 | A |
| 3 | 通信 | 本地 REST `127.0.0.1:25325`；启动返回 `debug_port`+`websocket_link` | A/B |
| 4 | 隔离 | 每 profile；**Local API 仅 Chromium 核** | A |
| 5 | 参数/结果/错误 | profile create/update 携带配置；API 无结构化错误文档 | A/D |
| 6 | 依赖 | 浏览器侧未文档化；MCP 自身是 npm | D |
| 7 | 浏览器意外关闭 | `stop`/`clearcache`/`cleardata`/`close` | A |
| 8 | 防失控 | 未文档化（MCP 有 `UNDETECTABLE_TIMEOUT` 60s） | A/D |
| 9 | 长时任务 | 未文档化 | D |
| 10 | 调试 | WebEngine 脚本为 Settings 内简易文本框；无 lint/断点 | A/D |
| 11 | 存储 | profile 云端同步；`.prof` 导入导出 | A |
| 12 | 批量/并发 | MCP batch 用 `Promise.all` 扇出（无上限） | A/C |
| 13 | 权限/密钥 | **未发现鉴权头**；角色/云组存在 | C/A |
| 14 | 不拖垮浏览器 | 用户进程分离；WebEngine 脚本在页面内（**风险点**） | C |

**证据表**：本地 HTTP API + 端点清单 A；基址/端口 25325 A；Selenium 集成+chromedriver A/B；CDP `debug_port`/`websocket_link` B；Puppeteer/Playwright 支持 C（仅博客）；MCP A；WebEngine JS 脚本 A；无调度/队列/重试/历史 D；无官方 SDK/CLI D；本地 API 无鉴权 C（缺失推断）；计划门槛 A（自相矛盾）。

---

## 8. MoreLogin

| # | 技术问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 引擎运行在哪 | **用户外部进程**（浏览器）+ **云手机 RPA 引擎** | A |
| 2 | 进程 | 独立进程：本地 REST/CLI/MCP → CDP；云运行时返回 `cdpUrl` | A |
| 3 | 通信 | 本地 REST `127.0.0.1:40000` + Open API（OAuth2）+ CDP | A |
| 4 | 隔离 | 每 profile；本地并发 create 受**团队级锁**；云手机并发配额 | A |
| 5 | 参数/结果/错误 | `templateParameter`（转义 JSON 串）；业务码（如 35000/33407/19147）；64 位整数以十进制字符串序列化 | A |
| 6 | 依赖 | 用户侧（`puppeteer-core` 等） | A |
| 7 | 浏览器意外关闭 | `close`/`closeAll`；云运行时 STARTING/RUNNING/CLOSED；`connect` 重发使旧 viewer 失效 | A |
| 8 | 防失控 | CLI `--timeout` 15s；云运行时需更长超时；**53 操作重试/完成矩阵** | A |
| 9 | 长时任务 | 云运行时/云手机需更长超时；RPA 子任务记录 | A |
| 10 | 调试 | RPA 视图树调试器（元素 X/Y/bounds/text/fullID/class/desc/package），非代码单步 | A |
| 11 | 存储 | RPA 子任务执行记录；profile 分享标志；零知识加密同步（AES-256 用户持钥） | A |
| 12 | 批量/并发 | 批量端点（setGroup/setProxy/setRemark）；创建量 [1–50]（同页又说 1–200）；云手机 1–10 | A |
| 13 | 权限/密钥 | 本地可选静态 token（仅回环）；Open API OAuth2 token 3600s；团队/组/IP 白黑名单 | A |
| 14 | 不拖垮浏览器 | 用户进程与浏览器分离；RPA 在云手机侧 | A |

**证据表**：Local API 端点+runtime A；Open API+OAuth2+1h token A；CDP+Selenium/Playwright/Puppeteer A/B；云运行时（cdpUrl）A；MCP 工具 A；CLI `ml-cli` 命令树 A；RPA 可视化引擎（云手机）A；限流 200/min GCRA A；重试/幂等语义 A；定价含 Free Local API A；sessionStorage/网络拦截 D；浏览器日志/优先级 D。

---

## 9. 跨产品证据等级汇总（14 问 × 8 家 → 结论可信度）

| 技术问题 | 证据最强者 | 普遍等级 | 说明 |
|---|---|---|---|
| Q1 引擎位置 | Multilogin（唯一内置通用引擎）A | A/C | 多数无内置引擎，用户进程 |
| Q2 进程模型 | 8 家一致（独立进程） | A | WebEngine 页面脚本是唯一例外 |
| Q3 通信 | 8 家一致（REST + CDP/WebDriver） | A/B | 无一家把页面 API 内置进厂商 API |
| Q4 隔离粒度 | Incogniton 锁文件 / MoreLogin 团队锁 | A | 隔离多在「每 profile 单会话」层 |
| Q5 参数/错误 | MoreLogin（业务码 + 重试矩阵）A | A/C | 多数错误语义不完整 |
| Q6 依赖管理 | GoLogin/Incogniton（标准工程）A | A/D | 内置引擎的依赖多不透明 |
| Q7 崩溃处理 | Octo/MoreLogin A | A/D | 「弃置 profile 阻塞再启动」是共性陷阱 |
| Q8 防失控 | AdsPower 进程超时 / Octo 加权扣费 | A/C | 资源限制普遍薄弱 |
| Q9 长时任务 | 全员薄弱 | D | 仅云侧有小时配额 |
| Q10 调试 | AdsPower/Dolphin 画布调试 | A/C | 代码级断点 8 家皆无 |
| Q11 存储 | MoreLogin（零知识加密）A | A/C | 脚本版本存储 8 家皆无 |
| Q12 批量/并发 | AdsPower ≤5000/任务 | A/C | 并发多受内存账 |
| Q13 权限/密钥 | 分两派：云端 token vs 本地无鉴权 | A/C | 本地无鉴权是系统性风险 |
| Q14 不影响浏览器稳定 | 全员把用户代码放独立进程 | A/C | 客户端内引擎（AdsPower/Dolphin）有共享进程风险 |

**对自研的三条硬结论**：
1. **「脚本版本管理 + 代码级编辑器 + 优先级调度 + 幂等语义 + 崩溃恢复」是 8 家的共同空白** → 自研必须在这五项上做到明确优于竞品，否则无差异化。
2. **隔离/资源/崩溃是竞品普遍推给用户进程的痛点** → 自研若把运行时放进 Electron main，必须自建 `utilityProcess`/`worker_threads` 级隔离与资源上限，**不能靠 `node:vm` 当安全边界**（见 [08-runtime-security-and-reliability.md](08-runtime-security-and-reliability.md)）。
3. **本地回环 API 默认无鉴权是系统性弱点**（Incogniton/Octo/Undetectable）→ 自研的本地 API 必须默认 token + sender/URL gate。

---

## 10. 最小验证实验（对 D 级/冲突项的取证方案，而非继续猜测）

| 待验证项 | 状态（2026-10-09 核查后） | 最小实验（仅残余项） |
|---|---|---|
| Multilogin Script Runner 依赖/超时/多文件 | **未决（D）** — 官方无文档 | 跑 `import requests` 脚本 + 观察 `script-stop` 是否触发超时 |
| AdsPower RPA Execute-JS 模块化复用 | 未决（非 OQ） | 「Apply Created Process」+ 变量跨流程一致性 |
| Dolphin 并发上限 | **部分裁决** — Free=3（官方 A）；付费天花板未知 | Local API 并发 N=3/5/10，记录 429/499 |
| Octo one-time 4×+auto-delete | ✅ **已确认**（A） | — |
| Incogniton 启动错误 HTTP 200 | 未决（非 OQ） | 对已开 profile 重复 launch，断言 body |
| Undetectable Local API 无鉴权 | ✅ **已确认**（A：文档 + 官方示例/MCP 仅发 Accept/Content-Type） | — |
| MoreLogin 创建量 1–50 vs 1–200 | ✅ **已裁决**（Local 1–50 / Open 1–200） | — |
| GoLogin 429 吊销 token | 未决 — 需账号实测 | 超 RPM 触发 429 后用同 token 请求 |
| Incogniton 非 loopback 绑定 | 未决（OQ-8） | 实机 Settings→Automation 观察 |
| MoreLogin localhost Local API 限额 | 未决（OQ-12） | 压测 local port 观察 `code:35000` |

> 完整裁决见 [11-open-questions.md](11-open-questions.md) §1/§4；本表只保留**仍需实测**的残余项。
