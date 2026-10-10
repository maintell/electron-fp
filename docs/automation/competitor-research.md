# 竞品自动化能力调研（研究综述，不含实现拷贝）

> 性质：公开资料的研究性综述，仅提炼通用能力模型与接口形态，不复制任何竞品实现代码、私有协议细节或可执行脚本。
> 范围：12 款指纹浏览器 / 多开浏览器产品的自动化、RPA、调度、调试能力。
> 用途：为自研自动化层提供对标输入（Identity / Launcher / Transport / Script / Executor / Scheduler / Observer / AuthZ）。

## 1. 十二产品自动化接口总表

| 产品 | API 类型 / 鉴权 | 启动绑定返回物 | Scope | Limits |
|---|---|---|---|---|
| AdsPower | 本地 REST，Bearer Token（Local API Key，需先在客户端开启） | start 接口返回三元组：`ws.selenium` / `ws.puppeteer` / `webdriver` 地址 + `debug_port`；调用方可任选其一接入 | profile CRUD、指纹配置、代理、cookies、扩展管理、分组、RPA 流程触发 | 线程数可配（上限约 100）；定时任务 once/daily/weekly/monthly；超限返回错误码需退避 |
| Multilogin | 云端 REST + 本地 Launcher（默认 45001 端口）；双 token：30 分钟有效 JWT + automation token | Launcher 负责拉起本地加密浏览器实例，云端 API 管 profile 元数据；启动后返回 DevTools 连接信息 | profile 生命周期、指纹、代理、cookies、扩展、团队空间 | JWT 短期过期需刷新；automation token 用于无人值守；并发受套餐席位限制 |
| GoLogin | 云端 REST，Bearer（API token） | 创建/启动 profile 后返回远程或本地调试端点；支持云端运行与本地运行两种模式 | profile、指纹、代理、cookies、扩展、文件夹共享 | 免费约 300 RPM、付费约 1200 RPM；429 后有封禁 token 风险，必须退避而非硬重试 |
| Dolphin Anty | 本地 API（默认 localhost:3001），`login-with-token` 一次性换取本地会话 | 启动返回 automation 端点（Puppeteer/Playwright/Selenium 均可接）；提供 stealth chromedriver 对接 Selenium | profile、代理、cookies、扩展、标签、团队共享 | 本地单机并发受内存约束；云端同步受套餐限制 |
| Kameleo | 本地服务（默认 5050），PAT（Personal Access Token） | `ws/.../{id}` 形态的端点，连接时若实例未启动可自动拉起（auto-start） | profile、指纹、代理、cookies、扩展、移动设备画像 | 并发受许可证席位；自动化连接数建议与 profile 一一对应 |
| Linken Sphere | 本地 HTTP（127.0.0.1:{port}，端口可在设置中指定） | sessions 语义：create 建会话、start 拉起；返回调试端口/驱动地址 | sessions、profile 预设、desktops、代理、cookies | 单机并发受内存账约束；API 本身无云端 RPM，以本地资源为瓶颈 |
| BitBrowser | 本地 HTTP（127.0.0.1:54345），POST 统一信封 `{success, data, msg}`；RPA 有 `/rpa/run`、`stop` 等 | 打开浏览器返回 selenium/puppeteer 连接串；RPA 接口按 workflow 粒度启停 | 浏览器 profile、群控、RPA 流程、代理、cookies、扩展 | 队列语义一次运行一个 RPA（one-runs）；并发窗口数受内存限制 |
| MoreLogin | 本地服务（127.0.0.1:40000）+ 开放平台 OAuth2；启动参数 startupParams | 启动返回浏览器内核调试信息 + 驱动端口；startupParams 控制启动行为 | profile、环境、模板、云文件（`morelogin://`）、团队 | 本地并发受机器资源；云端 Open API 受 OAuth2 scope 与配额约束 |
| Incogniton | 本地 API（localhost:35000），zero-token（本地回环免 token，靠本地可达性隔离） | 启动参数 `force_local` / cloud 控制运行位置；返回标准自动化端点 | profile、代理、cookies、扩展、批量操作 | 提供 TS/Python SDK 封装；并发以本地内存账为准 |
| Octo Browser | 云端 REST（`X-Octo-Api-Token`）+ 本地 Agent（58888，无鉴权，靠回环隔离） | 本地启动支持 `debug_port` 固定（1024–65534 可 pin）、`one_time` 一次性 profile、`start` 拉起 | profile、指纹、代理、cookies、扩展、模板 | cost-weighted rate limit（不同接口权重不同）；429 需按权重退避；Action Log 经 WS 推送带 watermark |
| VMLogin | 本地 REST（127.0.0.1:35000） | 启动返回调试端点；特色接口：ExecuteScript（base64 传参执行）+ ScreenShot（base64 回传截图）；`skiplock` 跳过锁定 | profile、代理、cookies、指纹、脚本执行、截图 | 本地并发受内存；脚本执行为同步往返，大负载需拆批 |
| ixBrowser | 本地 REST（127.0.0.1:53200） | 强类型实体：Profile / Proxy / Preference / Fingerprint 分开建模；启动返回调试连接信息 | profile CRUD、代理实体、偏好实体、指纹实体、分组 | 本地并发受内存账；批量创建建议串行 + 小间隔，避免端口竞争 |

通用约束（跨产品成立）：

- **内存账**：每个 profile 约 300–500MB 常驻，按此估算单机并发上限，而非按 CPU 核数。
- **disconnect-preserve vs close-kill**：`disconnect`（断开驱动连接）通常保留浏览器进程，`close`（关闭）杀掉进程；Linken 明确区分 disconnect-not-close；Playwright `connectOverCDP` 的 close 默认不断浏览器，需显式关闭。
- **pinned port vs 随机端口**：Octo 支持 pin 固定 debug_port 便于编排；其余多为启动时动态分配，调用方必须从启动返回值读取，不可硬编码。
- **one-time profile**：Octo 等支持一次性临时环境，用完即焚，适合验证码/一次性任务，不计入长期 profile 配额。
- **429 策略**：GoLogin 最严（可 revoke token）；Octo 按权重计费；通用做法是指数退避 + 抖动 + 读限流响应头，不硬重试。

## 2. 脚本存储 / 版本 / 参数 / 导入导出

| 产品 | 存储形态 | 版本 | 参数化 | 导入导出 |
|---|---|---|---|---|
| AdsPower | RPA Processes（流程对象）+ Marketplace（市场模板） | 流程版本随保存递增 | 流程变量 / 全局变量 | 市场模板一键导入；流程可在团队间分享 |
| Multilogin | `mlx` 脚本 + `deps` 依赖 + `scripts` 目录 | 以文件名为版本标识 | `script_params` 传参 | 脚本文件分发；依赖单独声明 |
| Dolphin Anty | Scenarios（场景） | Save 增量保存，Copy 另存 | 场景变量 + JS Execution block 传参 | Copy / Share 链接分享；XPath 选择器内嵌 |
| BitBrowser | Automa 工作流，按 workflowId 寻址 | 工作流版本跟随 Automa | 工作流输入变量 | 工作流 JSON 导入导出 |
| MoreLogin | templateParameter JSON（模板参数）+ workflow JSON | 模板版本化 | templateParameter 结构化传参 | workflow JSON 导入导出；云文件 `morelogin://` 协议引用 |
| Hidemyacc | 拖拽式脚本编排 | 脚本保存即版本 | 脚本变量 | 加密 `.txt` 导出；支持 Puppeteer 脚本导入 |
| Kameleo | `.kameleo` 归档（含 profile + 脚本资产） | 归档整体版本 | 启动参数注入 | `.kameleo` 文件整体迁移 |
| Linken Sphere | presets（预设）+ desktops（桌面）+ WarmUp（养号预热） | 预设版本化 | 预设参数 | 预设跨机器迁移；WarmUp 流程复用 |

要点：参数化是区分"录制回放"与"可复用脚本"的分水岭；凡支持 `script_params` / `templateParameter` / 变量块的产品，均可做一脚本多 profile 复用。加密导出（Hidemyacc `.txt`）与归档迁移（Kameleo）面向团队交付，而非面向版本管理。

## 3. RPA 能力对照

| 维度 | 通用能力 | 说明 |
|---|---|---|
| Builder | 可视化拖拽 / 录制回放 / 代码块混排 | Dolphin、Hidemyacc、AdsPower 均提供拖拽 + JS 代码块逃生口；BitBrowser 复用 Automa 生态 |
| Selectors | XPath、CSS、文本、role、id、坐标 | Dolphin Scenarios 以 XPath 为主 + JS Execution 兜底；通用优先级见下 |
| Control | if 条件、loops/foreach/while 循环、try/error 分支（green-red 双出口）、子流程调用 | 错误出口双色建模（成功绿 / 失败红）是多家一致的做法 |
| Actions | navigate 导航、mouse 点击/悬停/拖拽、keyboard 输入/快捷键、file 下载/上传、cookie 读写、storage（local/session）读写、tab/window 管理、截图、等待 | 文件上传下载与 cookie/storage 是 RPA 与纯爬虫的分水岭 |

Selector 优先级（综合多家最佳实践）：

1. `data-testid`（最稳，专为自动化预留）
2. `id`（唯一且稳定时）
3. `role` / `name`（无障碍语义，语义化页面最稳）
4. 可见文本（text，适合多语言需谨慎）
5. CSS 选择器（结构稳定时好用）
6. XPath（相对路径可用，绝对路径脆弱）
7. 坐标点击（最后手段，分辨率/缩放一变即失效）

反模式：`div:nth-child(...)` 深链、绝对 XPath、依赖动态类名（如 CSS Modules 哈希类）均属脆弱选择器，应避免。

## 4. 调度器能力对照

| 维度 | 通用能力 | 产品实例 |
|---|---|---|
| single | 单次立即执行 | 各家均支持 |
| batch | 批量 profile 依次执行 | VMLogin 批量、ixBrowser 批量创建+启动 |
| concurrent | 并发信号量，限制同时运行数 | Hidemyacc 约 10 路同时；AdsPower threads 上限约 100 |
| queue | 队列串行，一次跑一个 | BitBrowser RPA queue one-runs |
| cron / interval / one-time | 定时（once/daily/weekly/monthly）、间隔轮询、一次性延迟 | AdsPower scheduled once/daily/weekly/monthly 最完整 |
| retry-backoff | 失败重试 + 指数退避 | 通用；GoLogin/Octo 场景下必须退避，不可硬重试 |
| timeout-kill | 超时杀掉任务，防止僵死占用席位 | 长 RPA 必备；与内存账联动 |
| deps-chain | 任务依赖链（A 成功才跑 B） | Multilogin 脚本依赖、Linken WarmUp 链 |

## 5. 调试器能力对照

| 维度 | 通用能力 | 说明 |
|---|---|---|
| per-step logs | 单步日志，定位哪一步失败 | RPA builder 标配；失败步高亮 + 输入输出快照 |
| console | 经 CDP 接管 console 消息 | 透过 `Console.messageAdded` / `Runtime.consoleAPICalled` 采集 |
| network | 经 CDP 查看请求瀑布与失败请求 | 透过 Network 域；注意敏感 header 脱敏 |
| DOM | 经 CDP 快照/高亮当前 selector 命中节点 | 调试选择器漂移的核心手段 |
| screenshots | 失败自动截图 + 关键步手动截图 | VMLogin ScreenShot base64 即此能力 API 化 |
| trace | 全流程 trace（含动作序列 + 时间线） | Playwright trace 模式为事实标准形态 |
| action-log stream | 动作日志流式推送，带 watermark 断点续传位点 | Octo Action Log WS watermark 即此模式 |
| backpressure | 读 rate-limit 响应头做背压，而非固定 sleep | Octo cost-weighted 与 GoLogin 429 场景必需 |

## 6. 框架兼容矩阵

| 接入方式 | 保真度 | 生命周期语义 | 版本约束 | 适用场景 |
|---|---|---|---|---|
| Playwright `connect`（直连产品返回的 ws） | full（多 context 能力完整） | 受产品侧管理 | version-locked（客户端 Playwright 版本须与对端匹配） | 首选的产品自动化通道；**无 Electron 支持** |
| Playwright `connectOverCDP` | low-fidelity（单 context 视角） | close 不杀浏览器（需显式关） | 同上 | 已有实例的临時接管/调试 |
| Playwright `_electron.launch` | experimental | 自管理 | ASAR 不支持，打包后行为差异 | 仅实验，不建议生产依赖 |
| Puppeteer `connect` | CDP thin（协议薄封装） | disconnect 保留浏览器 | 与 Chrome/CDP 版本弱绑定 | 轻量脚本、Hidemyacc 导入源 |
| Selenium + debuggerAddress | low fidelity（仅页面级） | 需 stealth chromedriver 配套 | chromedriver 与内核大版本对齐 | 存量 Selenium 资产复用（Dolphin 明确支持） |
| raw CDP（直连 debug_port） | full browser-level（浏览器级，最强） | 完全自理 | Chrome 136+ 需 non-default user-data-dir；回环无鉴权，**不可暴露到非回环** | 自研执行器/调试器的终极逃生口 |
| `webContents.debugger`（进程内） | native preferred（Electron 首选） | per-window，随窗口生死 | 无外部版本约束 | Electron 自研首选：单窗口 attach；flat 会话经 `Target.attachToTarget`（`flatten:true`）+ sessionId 路由；`RenderFrameHostChanged` 后需重连 |
| product-SDK（各家 TS/Python SDK） | 取决于封装（多为 connect 的再包装） | 跟随产品语义 | 跟随产品发版 | 团队交付快，但锁定供应商 |

Standard vs product-SDK 结论：标准协议（CDP / Playwright / Puppeteer）保证可迁移性，product-SDK 保证开箱即用；长期资产应沉淀在标准协议侧，product-SDK 只做启动与 profile 管理。

## 7. 通用八能力模型（自研对标用）

1. **IdentityStore（身份存储）**：profile CRUD、分组、指纹实体、代理实体、cookies、扩展、偏好设置的持久化与版本化；对应 ixBrowser 强类型实体、Multilogin 云端元数据。
2. **Launcher（启动器）**：把身份变为运行实例；支持 pinned port / 随机端口回读、one-time 临时身份、force_local/cloud 运行位置选择、skiplock 等启动修饰。
3. **Transport（传输）**：ws + http + driver 三元组（selenium/puppeteer/cdp 任选其一）；本地回环默认无鉴权或 zero-token，云端 Bearer / PAT / OAuth2 / 双 token。
4. **ScriptStore（脚本存储）**：流程/场景/工作流对象化存储，文件名或保存即版本，变量/params 参数化，JSON/归档/加密文本多形态导入导出。
5. **Executor（执行器）**：RPA 语义（builder + selectors + control + actions）或标准框架 connect（Playwright/Puppeteer/Selenium）或 raw CDP；ExecuteScript base64 与 ScreenShot base64 是最小执行闭环。
6. **Scheduler（调度器）**：single/batch/concurrent（信号量）/queue/cron-interval-one-time/retry-backoff/timeout-kill/deps-chain；并发上限由内存账（300–500MB/profile）反推。
7. **Observer（观测器）**：per-step 日志、console/network/DOM（经 CDP）、截图、trace、action-log 流（watermark 续传位）、rate-limit 响应头背压。
8. **AuthZ（鉴权与配额）**：本地回环隔离 vs 云端 token；RPM 配额、cost-weighted 计费、429 退避策略（GoLogin 可 revoke token 为最严一档）。

## 8. 官方文档 URL（关键入口）

1. AdsPower Local API：https://docs.adspower.com/docs/local-api-overview
2. Multilogin API 文档：https://docs.multilogin.com/lumen/api/
3. Multilogin Launcher / 自动化：https://docs.multilogin.com/lumen/launcher/
4. GoLogin API 参考：https://www.gologin.com/api-documentation/
5. Dolphin Anty 自动化：https://docs.dolphin-anty.com/api/automation
6. Kameleo 自动化 API：https://help.kameleo.io/automation/
7. Linken Sphere 自动化：https://docs.linkensphere.info/automation/
8. BitBrowser API 文档：https://docs.bitbrowser.net/open-api/
9. BitBrowser RPA 文档：https://docs.bitbrowser.net/rpa/
10. MoreLogin 开放平台：https://docs.morelogin.com/open-api/
11. Incogniton API 入门：https://help.incogniton.com/api/
12. Octo Browser API：https://octobrowser.net/api
13. VMLogin API：https://www.vmlogin.com/api/
14. ixBrowser API：https://www.ixbrowser.com/api-doc
15. Hidemyacc 自动化：https://hidemyacc.com/automation
16. Playwright CDP 连接说明：https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
17. Chrome DevTools Protocol：https://chromedevtools.github.io/devtools-protocol/
18. Electron webContents.debugger：https://www.electronjs.org/docs/latest/api/debugger
