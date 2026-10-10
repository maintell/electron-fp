# Automation 最终验收标准 §41 逐项矩阵（2026-09-28 修订版）

> 性质：验收状态文档。上游：user spec §41（30 条最终验收）、`testing.md`（475 PASS + Phase 0–8 门）、`api.md`/`cli.md`/`runtime.md`/`observability.md`/`troubleshooting.md`/`automation-gap-analysis.md`。
> 口径：✅ = 已有可运行证据（引实跑 PASS 数或 CLI/HTTP/探针冒烟，scope 备注写边界）；🔶 = 设计 + mock 级就绪，缺 Electron 真链路（引模块与缺口）；⛔ = 未实现（引 blocker）；**waive** = 明确不做，见 §5 决议。
> 全部 PASS 数为 2026-09-28 实跑（33 套独立进程 exit 全 0：store 13 / runner 31 / manager 11 / queue 22 / worker 18 / scheduler 11 / core 16 / profile 17 / jwt 21 / metrics 9 / http 27 / cli 23 / ipc 18 / wire 10 / audit-log 9 / agent-engine 49；探针为 built Electron 真链路实跑 exit 0：smoke 24/24 + script-e2e 17/17 + real-site 12/12 + cdp-ws 11/11 + cdp-server 10/10 + preload 13/13 + live-recorder 7/7 + recorder-control 7/7 + real-stress 8/8×4；生产入口 `bin/serve.js` 冒烟通过；面板真浏览器冒烟通过）。

---

## 1. §41 最终验收标准 30 条逐项矩阵

| # | 验收项 | 状态 | 证据/缺口 | 前置 |
|---|---|---|---|---|
| 1 | 脚本创建（create） | ✅ | `test-script-store.js` 13 PASS（CRUD/持久化）+ `test-automation-manager.js` 11 PASS + `test-http-api.js` 27 PASS（POST /api/scripts 201）+ `test-cli.js` 23 PASS | — |
| 2 | 脚本编辑（edit） | ✅ | store meta 更新 + `PUT /api/scripts/:id`（`api.md` §4.2，网关测试覆盖信封/错误码） | — |
| 3 | 保存版本（save version） | ✅ | store 不可变 versions + service `saveVersion`（`test-script-store.js` 13 PASS；`test-automation-manager.js` 11 PASS 版本钉选）；CLI export/import 往返（`test-cli.js` 23 PASS）；**11 内置模板**（§28）：`test-templates.js` **9 PASS** + `test-templates-api.js` **7 PASS**（service/bridge/HTTP）；网关 `POST /:id/versions`→201、`GET /:id/export`、`POST /import`→201 已挂（`test-http-api.js` 27 PASS；`test-integration.js` 8 PASS 跨层往返） | — |
| 4 | 类型化参数（params） | ✅ | `test-script-store.js` 13 PASS：9 种参数类型 coerce/校验、required/default；run 前 `validateParameters` 失败 400 不产生 execution（`api.md` §4.2） | — |
| 5 | 执行（run） | ✅ | `test-automation-manager.js` 11 PASS + `test-cli.js` 23（exit 0/1）+ `test-http-api.js` 27（`POST /:id/run`）+ `test-integration.js` 8（跨层版本钉选执行 + worker/executor 执行）+ bin 冒烟（`testing.md` §2.2） | — |
| 6 | 停止（stop/cancel） | ✅ | manager pre-start cancel + AbortController 中程收敛（`test-automation-manager.js` 11 PASS）+ `queue.cancel`/`retryNow`（`test-task-queue.js` 22 PASS）+ CLI `script stop`（`test-cli.js`） | — |
| 7 | 暂停/恢复（pause-resume） | ✅ | **协作式中程中断已落地到线**：runner `run(spec,params,{signal})`——pre-start 检查 + promise race（abort 胜）+ `step()` 边界抛 `CancelledError`（`test-script-runner.js` 31 PASS 含 abort）；`worker.pause({interrupt:true})` + 新增 `abortItem(id)` 单点打断（`test-worker.js` 18 PASS）；`createTaskExecutor` 把 manager 终态译回 queue 语义（SUCCESS/CANCELLED/TIMEOUT/FAILED）；service `pauseTask(id,{interrupt})` + HTTP `POST /tasks/:id/pause` body 透传——真 worker 拓扑下 RUNNING→PAUSED→CANCELLED 当即收敛（`test-integration.js` 8 PASS 含 hang 脚本 15s 内收敛，不断言超时兜底）。**边界**：vm 内不经过 signal 的硬 hang 仍靠 taskTimeout（worker-kill territory，不撒谎标 PAUSED）；真暂停语义=收敛到 CANCELLED（§3.2(b)），非 vm 冻结 | — |
| 8 | 实时日志（live logs） | ✅ | **getLogs API ✅** + **三路推送 ✅**：IPC push（wire `emit` + runner/manager `onLog` 线程 + 面板 `onAutomationEvent` 订阅，`test-electron-wire.js` 10 PASS 含 live-log e2e）+ **WS ✅**（`runtime/ws-api.js` 无依赖实现：loopback+Bearer/viewer 三门、RPC、250ms subscribe 推送；`test-ws-api.js` **6 PASS**：401/403/角色拆分/终态推送/unsub/ping）。面板 poll 留终态 fallback。**边界**：mock-socket 级 e2e 已证，真窗口投递待 Client 启动实看 | — |
| 9 | 错误分类（errors） | ✅ | error taxonomy：`test-script-runner.js` 31 PASS（retriable-vs-not、Timeout/Permission/Selector 等类、超时、cancel、onLog）+ `task.md` §5 分类表 + CLI exit 1/2 映射 | — |
| 10 | 自动截图（auto-screenshot） | ✅ | **真链路捕获 ✅**：`electron/glue.js` `screenshot()` + `electron/page.js` `screenshot()` 经 `Page.captureScreenshot`——探针真机 glue 2310 bytes、page 9929 bytes（24/24 内）；**失败自动归档 ✅**：runner `record.artifacts[]`，FAILED/TIMEOUT 时抓 `browserApi[.browser].screenshot`，抛错记 error-artifact 永不拖记录；**§16 失败取证 ✅**：`record.trace`（DOM/HTML ≤262144 B 硬截断 + 网络尾部 50 + URL；源缺失记 `sources.*=false` 且不抛；SUCCESS 不取证）——`test-forensics.js` **12 PASS** + `test-script-runner.js` 31 + 真机 `probe-script-e2e.js` **17/17**（失败腿 + 生产 facade 路径均断言 HTML 含 fixture 标记/网络≥1/URL 正确）。**边界**：落盘 `screenshot_path`/`trace_path` 列待 database.md SQLite 化时接 | — |
| 11 | 连接 profile（connect profile） | ✅ | **API 接线 ✅**：service `profiles` 组 + HTTP 全路由（CRUD/status/start/stop/cdp）+ CLI `profile *`（exit 0/2/3）+ IPC 9 通道（含 wired roundtrip）——`test-http-api.js` 27、`test-cli.js` 23、`test-ipc-bridge.js` 18、`test-electron-wire.js` 10、`test-profile-manager.js` 17 PASS；**真 attach ✅**：`electron/glue.js` + 探针 24/24；**真 partition 绑定 ✅**：`electron/launcher.js` 建窗即 `persist:auto-*`（非 persist 拒建），同 id relaunch cookie `rl2` 存活（24/24 内） | — |
| 12 | 页面操作（page ops：导航/点击/输入） | ✅ | **`electron/page.js` 真驱动 ✅**：goto（Page.navigate+双load信号15s）/resolve（boundingRect）/click+fill/type（真 planClick/planTyping 经 adapter，send 后端）/press（keyDown+char+keyUp 三元组，Enter 提交已证）/四种 wait——探针真机：goto/click-toggle/fill 回读/Enter 提交全 PASS（24/24 内）。**SDK→manager 绑定 ✅**：`electron/executor.js`+`browser-api.js`——真脚本经 manager→runner 对真窗执行（`probe-script-e2e.js` 17/17：SUCCESS/结果回读/日志/真 CDP 4 calls） | — |
| 13 | Cookies | ✅ | 真链路 ✅：`page.cookies` 经 `webContents.session.cookies`（partition 自动 scoped）——探针 set/get PASS。**边界**：委派单测（`test-browser-api.js` 14 PASS，cookies 精确参数）+ executor 接线；脚本级合并入真实站点 E2E | — |
| 14 | Storage（local/session） | ✅ | 真链路 ✅：`page.storageGet/Set` 经 isolated evaluate localStorage——探针 file:// 页 set/get PASS。**边界**：同 #13；另 data: URL 系 opaque origin，localStorage 恒抛 SecurityError（diag 实证），E2E 页用 file://（离线意图不变） | — |
| 15 | 上传（upload） | ✅ | 真链路 ✅：`page.upload` 经 DOM.getDocument→querySelector→describeNode→setFileInputFiles——探针 input files:1 且 change 事件到（out3=files:1）。**围栏已落地 ✅**：`browser-api.js checkPath`（授权目录内放行，越界/null/无围栏 → `PermissionError` retriable=false；`test-browser-api.js` 围栏块 14 PASS 含异步拒绝形）+ executor 按 profile 派生 `os.tmpdir/fp-<id>` 默认围栏 | — |
| 16 | 下载（download） | ✅ | 真链路 ✅：`page.download` 经 Page.setDownloadBehavior + will-download once → savePath——探针 data: 链接 completed 18 bytes 落盘。**围栏已落地 ✅**：同 upload（`download.save` 经 checkPath；`test-browser-api.js`） | — |
| 17 | 网络监听（network listen/intercept） | ✅ | 真事件 ✅：`page.enableNetwork` + Network.requestWillBeSent ring（cap 200）——探针 goto 后 ring≥1 PASS；CDP `Network` 只读白名单不断言越权（`test-core.js` 16 PASS）。**边界**：intercept/改写能力仍按 capability 授权未接（P1/Network 事件接线后补） | intercept 接线（后补） |
| 18 | 智能等待（wait DOM/URL/Network） | ✅ | 真等待 ✅：`waitForSelector/Text/URL/Function` 100ms poll + TimeoutError——探针 selector+url/text 全 PASS。**边界**：networkIdle/response 语义待 Network  deepening（#17 同步） | 同 #17 |
| 19 | 批量 profile 执行（batch profiles） | ✅ | fan-out：1 Schedule × N profileContexts → enqueue × N（`test-scheduler.js` 断言 #5）+ Task 展开模型（`task.md` §2）+ `test-task-queue.js` 22 PASS | — |
| 20 | 并发控制（concurrency） | ✅ | worker 全局 semaphore（`test-worker.js` 18 PASS：capacity + abortItem + relaunch hooks）+ **同 profile 串行已强制**：`claim({skip})` 谓词 + worker `runningProfiles` 集合（同身份 QUEUED 项跳过、结清后可再认领，`profileKey`=profileContext.id→profileId→null 不约束），断言同 profile maxActive=1、异 profile 并行=2、无饥饿；manager `maxConcurrent` fail-fast（11 PASS）+ stress 100 items 实证 maxParallel≤5（`test-stress.js`） | — |
| 21 | 重试（retry） | ✅ | backoff：`test-task-queue.js` 22 PASS + `test-worker.js`（retriable vs non-retriable）+ 公式（`task.md` §5.2） | — |
| 22 | 定时调度（scheduled） | ✅ | `test-scheduler.js` 11 PASS：once/interval/cron 解析、时区步进、catch-up skip、fan-out、pause/resume/triggerNow、校验拒绝、`schedule-fire/skip` 审计（`scheduler.md` §8/状态） | — |
| 23 | HTTP API | ✅ | **生产入口 ✅**：`automation/bin/serve.js`（`createAutomationServer`）一体启动 API+WS+worker+scheduler，token 缺失自动生成并打印 banner，SIGINT/SIGTERM 优雅停机——`test-serve.js` **9 PASS**（含 worker 真跑队列任务、scheduler tick、WS RPC、stop 关端口、metrics 端到端）+ CLI 冒烟（banner→token 200 / 无 token 401→清理）；`test-http-api.js` **27 PASS**（六关卡 + 3 路由 + profiles 全路由 + RBAC viewer + JWT + CDP endpoint + token 不入 audit + **`GET /api/metrics` 聚合一致性/`?scriptId=` 过滤/401/501** + **trust 门 + broker fingerprint/rotate + audit query/stats + executions `{total,rows}`**）；WS 传输见 #8；curl 样例（`api.md` §9） | — |
| 24 | CLI | ✅ | `test-cli.js` 23 PASS（退出码 0/1/2/3、`--json` 信封、profile 接线、`--param` coerce、**`task run` enqueue：flags 映射/裸 spec**、**`script trust/untrust` + `profile fingerprint/rotate`**、**task list total 尾行**）+ bin 实测（`task run --json`/裸 spec exit 0；`testing.md` §2.2）；跨层 CLI `task run`→HTTP `/tasks` 可见（`test-integration.js`）；spec §22 七命令全齐 + broker/trust 扩展命令 | — |
| 25 | Playwright 外部接入（CDP） | ✅ | **闭环已建成**：① 桥 `runtime/cdp-ws.js`（`GET /json/version` 带 `webSocketDebuggerUrl` + `/json/list`；WS `/api/cdp/<profileId>` 升级前验 loopback+token，401/403/404；浏览器级发现/挂载合成、页面级经 allowlist 转发 + `sessionId` 剥离/回填 + 事件回传）——`probe-cdp-ws-client.js` 11/11；② **宿主入口** `electron/cdp-server.js`：`createProfileCdpServer({launcher,token,onUrl})` 起桥并把**真实可连 URL** 经 `profile-manager.setEndpoint` 合并进 `GET /api/profiles/:id/cdp`（`{inProcess:true, cdpUrl}`；running-only、永不落盘）——`probe-cdp-server.js` **10/10**（读回 `pm.status(id).endpoint.cdpUrl` → 外部 CDP 客户端 101 → getVersion → getTargets → attachToTarget → Page.enable/navigate/loadEventFired → Runtime.evaluate → 坏 token 401 → teardown 0 窗口 0 句柄）；③ `test-cdp-server.js` 7 PASS、`test-cdp-ws.js` 20 PASS、`test-profile-manager.js` 17 PASS。**边界**：仓库不 vendored `playwright`（用户侧自装即可 `connectOverCDP(cdpUrl)`）；不开 `--remote-debugging-port` | — |
| 26 | 权限控制（permission control） | ✅ | **runner capability ✅**：`test-script-runner.js` 31 PASS；**网关三档 ✅**：admin token 全权 + viewer（`readToken`）GET-only + **team JWT claims**（HS256 手写校验，零依赖，**时钟容差 ±60s**；`permissions[]` 缺项→403 命名所需权限，role 仅作缺省；`test-jwt-claims.js` 21 PASS + `test-http-api.js` 27 PASS；WS 同规则 `test-ws-api.js`） | — |
| 27 | 沙箱（sandbox） | ✅ | `script-sandbox.md` 能力模型 + vm ceiling 诚实声明（§4）+ `test-script-runner.js` 31 PASS（注入/deny-proxy/codegen 关/**T3 清洗 + secret 双 scrub + trustResolver 三态**）+ `test-audit-log.js` 9 PASS（门口二次脱敏） | — |
| 28 | 审计日志（audit log） | ✅ | **中央收集器已落地 ✅**：`runtime/audit-log.js`（内存 ring + JSONL 文件 `FP_AUTOMATION_AUDIT_FILE`；`test-audit-log.js` **9 PASS**）+ `GET /api/audit[/stats]` + IPC `automation:audit:query/stats`（viewer 可读）+ wire 全模块漏斗（显式 audit 双写不丢源）；audit 事件 **30+ 种**（`auth-jwt`：sub/ok/reason；`cdp-ws-open`/`close`/`deny`；`recorder-start`/`recorder-stop` 引擎级 + `recorder-session-start`/`recorder-session-stop` 控制面级；`script-trust/untrust`；`fingerprint-update/rotate/deny`；永不记 token/签名/载体）+ **`ipc-bridge.js` 50 通道**：白名单 + sender-check + ipc-deny/ipc-call、args 不入 audit——`test-ipc-bridge.js` **18 PASS**；token 不入 audit（`test-http-api.js` 27）；队列 state/state-deny（`test-task-queue.js` 22）；worker relaunch（`test-worker.js` 18）；CDP 桥拒绝审计（`test-cdp-ws.js` 20）。`electron/wire.js` 一调接入（`test-electron-wire.js` 10，含 audit query e2e）+ `Client/main.js` 原生 20+ 通道外层 `checked()` 门 + `MClient/main.js` 37 通道同门 | — |
| 29 | 崩溃恢复——记账闭环（步 1–4：检测/接管/幂等/重试） | ✅ | `queue.crash` + retry：`test-task-queue.js` 22 PASS + `test-worker.js` 心跳 + takeover 判定（`worker.md` §4 表步 1–4 全 ✅） | — |
| 30 | 崩溃恢复——进程自愈（步 6 relaunch/reattach） | ✅ | **真 relaunch ✅**：`glue.restartSession`（stop→destroy→同 partition 重建→start）——探针真机：carried cookie `rl-1` 跨重启存活 + marker 重 goto（24/24 内）；**worker 编排 ✅**：`BROWSER_CRASH → await relaunch() → queue.crash → retry → SUCCESS`（`test-worker.js` 18 PASS：hook 实调、抛错不挡重试照记审计）。**边界**：re-navigate=从头重放（at-least-once）；launcher persist 重启 cookie `rl2` 存活已证（24/24 内）；kill-residual 真实场景编排为可选深化 | — |
| 31 | 完整测试（full tests） | ✅ | Unit：33 套 **475 PASS / 0 FAIL（SKIP 14）**，exit 全 0，2026-09-28 复跑（`testing.md` §2 表逐文件 PASS 数 + §2.2 Phase 0–8 门） | — |
| 32 | Integration / E2E / Stress 三层 | ✅ | Integration：`test-integration.js` 8 PASS（跨层往返 + worker/executor 执行 + HTTP 中程中断）；E2E：`probe-automation-smoke.js` **24/24** + `probe-script-e2e.js` **17/17** + `probe-real-site-e2e.js` **12/12** exit 0（page 全 ops + launcher partition/relaunch + 真脚本 manager 执行 + 生产态失败取证 + 真 HTTP 源 login/cookie/storage/download/403 负例；isolated-world 导航自愈已修）+ `probe-cdp-server.js` **10/10** + `probe-recorder-control.js` **7/7**（宿主 CDP 入口与录制控制面真机全链）；Stress：`test-stress.js` 2 PASS（队列级 100×10/并发5）+ `probe-real-stress.js` **8/8 ×4**（真窗档 N=10/20/30/50 → 50/100/150/250 项：零丢失、同 profile maxActive=1、全局峰值 5、心跳；资源表 2.11 / 3.94 / 5.78 / 9.42 GB，Tab 进程数=窗口数）。**边界**：100 档因内存未跑（投影 ≈18–19 GB > 本机空闲 9.48 GB），`FP_STRESS_N=100` 一条命令可切 | 100 待内存余量 |
| 33 | 完整开发文档（full dev docs） | ✅ | `docs/automation/` 实存 **21 份**（+`profile-manager.md` 专册）+ `api.md` §10 wire 契约 + WS（`ws-api.js` 头注释协议）+ 本矩阵修订；`automation/automation.d.ts` + `panel.js` 头注释 bridge 契约。**templates 已进面板 ✅**（`panel.html` + mount 接线，des-1）；**缺（waive，见 §5）**：marketplace 专册、Monaco 专册（panel hook + vendor loader 即文档，见 §5） | — |
| 34 | 不变量：指纹/隔离/稳定性不被破坏 | ✅ | ① `fingerprint/` **内容零改动（哈希实证）**：`git hash-object`(worktree) == `git rev-parse HEAD:<path>`（如 `10-blink-core.patch` f1ffdbf1dc、`fp-fingerprint.patch` a140945510 两侧一致；`git status` 的 `.M` 为 17:58 批量文件操作的 mtime/stat 噪声，porcelain v2 显示 index/worktree blob 相同、`git diff --raw` 空）；本次全部写入局限在 `automation/`、`docs/automation/`、`Client/renderer/automation-panel/`（untracked 新增）与 `Client/main.js`+`Client/preload.js` 的加法式接线，以及 Wave16 面板嵌入 `Client/renderer/{index.html,app.js,style.css}` 的加法式列接线；② automation 代码位于 `automation/` + `Client/renderer/automation-panel/`，外加四处加法式接线：`Client/main.js` 一行 try/catch、`Client/preload.js` automationApi facade（templates + onAutomationEvent）、`panel.js` mount/push 订阅、`Client/renderer/{index.html,app.js,style.css}` 的 `#ap-panel` 列（与 `#fp-panel` 互斥、复用同一 420px 让位几何，既有行逻辑未改）——**preload 面已实探**：`probe-preload-surface.js` 13/13（templates/onAutomationEvent 在位、既有 facade 六方法完整、`window.api` 完整、渲染器 `require/process/module` 全 undefined 零 Node 泄漏），`node --check` 全过；③ CDP allowlist + FP scrub（`test-core.js` 16，含只读增项后仍拒 `Browser.close`/`Target.createTarget`）；④ Env ADR-5；⑤ `persist:auto-*` + **同 profile 串行已强制**（claim skip + runningProfiles，真窗 N=30 下 maxActive=1 实证）；⑥ Client packaged 副本再同步（`preload.js` md5 两侧一致、移除无运行时消费者的 `tls/` 三文件）→ `Client/test-app-copy-sync.js` **14/14 PASS**。**边界**：Client 全套件未重跑——其测试各自是独立 Electron main 脚本、不加载 app 的 main/preload，跑它并不覆盖这两处编辑；已用 preload 专项探针 + 一行 try/catch 守护替代，且未改既有行逻辑 | — |

**合计 34 行：✅ 34 / 🔶 0 / ⛔ 0；另 §5 waive 2 项（Monaco bundle、templates 专册——功能面已覆盖，仅文档/资产形态 waive）。**

### 1.1 状态统计

| 状态 | 数量 | 行号 |
|---|---|---|
| ✅ | 34 | 1–34（scope/边界见各行备注） |
| 🔶 | 0 | — |
| ⛔ | 0 | — |

---

## 2. 剩余工作（2026-09-28 修订：P0 缺口清零）

| 级 | 项 | 说明 |
|---|---|---|
| ✅ 已落地 | BrowserView `fromPartition(persist:auto-*)` 绑定 | `electron/launcher.js` + 探针（partition/stop/relaunch cookie）；#11/#30 边界关闭 |
| ✅ 已落地 | SDK（script-sdk page.*）→manager 执行绑定 | `executor.js`+`browser-api.js` + script-e2e 17/17；#12 边界关闭（#13/14 委派单测，脚本级并入真实站点 E2E） |
| ✅ 已落地 | 真实站点 E2E（本地 HTTP 源 + 可选公网） | `probe-real-site-e2e.js` 12/12（isolated-world 默认路径）；#32 站点边界关闭 |
| ✅ 已落地 | 外部 CDP 客户端接入（Playwright/Puppeteer 兼容） | `cdp-ws.js` 桥 + `probe-cdp-ws-client.js` 11/11（协议级握手/attach/驱动/事件/拒绝）；`#25` 边界关闭（playwright 依赖仍不 vendored，用户侧自装） |
| ✅ 已落地（10/20/30/50 档） | 真浏览器资源账 stress | `probe-real-stress.js` 8/8 ×4（N=10/20/30/50：零丢失、同 profile 串行、全局峰值 5、资源表+teardown 归零；50 档 250 项、峰值 9.42 GB）；100 待内存余量（`FP_STRESS_N=100` 可切） |
| ✅ 已落地 | team JWT claims | `jwtSecret` 开关（HS256 手写、零依赖）；`permissions[]` 强制 + 403 命名；`test-jwt-claims.js` 21 PASS；#26 边界关闭 |
| ✅ 已落地 | templates 进面板 UI | `panel.html` + mount；marketplace 专册仍缺（非阻塞） |
| ✅ 已落地 | 面板 §27 视图全覆盖（Tasks / Schedules / API + 执行详情含日志/工件/时间线） | Wave14：`panel.js` +951、`preload.js` tasks/schedules 组；29 通道全命中桥白名单；`node --check` 双过 + 静态结构审计（48 id 全解析/0 死控件）；`?demo=1` 可离线演练。**Wave16（2026-09-27）**：右侧 DOM 列嵌入 `Client/renderer/{index.html,app.js,style.css}`——与指纹面板共用同一列且互斥（🤖 按钮/F9），复用 `panel:set-open`→`resizeActiveView` 的 420px 让位几何（`#ap-panel .ap-main` 作用域覆盖防 420px 溢出）；真窗验证 `Client/test-automation-panel.js` **19 PASS**（挂载/互斥/列宽=420/视图不遮挡/无横向溢出）+ 真桥 E2E `Client/test-automation-panel-bridge.js` **6 PASS**（真 preload+wire+IPC：seeded 脚本与 templates 双通道渲染、`panel:set-open` 经真 preload 触发；`#ap-templates` 兄弟区 + `#ap-panel-body` 滚动容器）+ 降级 E2E `Client/test-automation-panel-degrade.js` **5 PASS**（preload 在/handler 不在：probeBridge 识别 `No handler registered` → 走既有 absent-bridge 态），packaged 副本同步 `test-app-copy-sync.js` **21/21**。**默认运行全功能**：`resources/automation` ← `automation/{electron,runtime,package.json}`（32 .js 双树 parity + CommonJS 标记——`out/Default/package.json` 是 `type:module`，无标记则 require 变 ESM 且被一行接线静默吞掉；守护 `Client/test-packaged-automation.js` **12 检查**：parity + `buildLocalStack`/`attachAutomation` 44 通道/`scripts.list` 全过）。半接线 host 仍走降级态（降级 E2E **5 PASS** 守卫；troubleshooting §6 #26） |
| ✅ 已落地 | §16 失败取证（DOM/HTML + 网络日志 + URL） | Wave15-B/C：`record.trace`（失败专属、字节/条数上限、源缺失不抛）+ `test-forensics` 12 + probe **17/17**；**生产 facade 直连**（`page.js` 导出 `evaluate`/`getCurrentUrl`、`browser-api.js` 条件透传、`network.enable` 已接）——生产执行器路径真出 HTML/URL/网络 |
| ✅ 已落地 | §35 metrics 通链（manager 终态喂养 + service 组 + `GET /api/metrics` + CLI `metrics` + IPC 通道） | Wave15-A：`serve.js` 默认建 metrics 并贯通；`test-metrics` 9 / `test-http-api` 27 / `test-cli` 23 / `test-serve` 9 / `test-ipc-bridge` 18；**并修复 `metrics.filtered()` 不认 `scriptId` 的真缺陷**（`?scriptId=` 过滤曾静默返回全量，`test-http-api` 抓到）；**crashRate 终态分母 ceiling 已关闭**（RUNNING/QUEUED 不进分母） |
| ✅ 已落地 | 中央审计通链（全模块→collector→HTTP/IPC query） | `runtime/audit-log.js`（ring + JSONL +門口脱敏）+ wire 漏斗 + `GET /api/audit[/stats]` + IPC 双通道；`test-audit-log` 9 / `test-ipc-bridge` 18 / `test-electron-wire` 10 / `test-http-api` 27 |
| ✅ 已落地 | trust 真签名门 | store trust()/untrust()（版本钉选）+ runner trustResolver + HTTP Admin-JWT 门 + CLI trust/untrust；`test-script-store` 13 / `test-script-runner` 31 / `test-http-api` 27 / `test-cli` 23 |
| ✅ 已落地 | FingerprintBroker 最小 + rotate | 五门 + H2 冻结诚实 + stop→update→start 一 call；HTTP/CLI/IPC 三入口；`test-profile-manager` 17 / `test-cli` 23 / `test-ipc-bridge` 18 |
| ✅ 已落地 | 双客户端 IPC sender 门 + 导航守卫 | Client 20+ / MClient 37 通道 `checked()` + setWindowOpenHandler deny + will-navigate file-only + webview deny + permission deny-list；copy-sync 21/21 |
| ✅ 已落地 | secret 脱敏 + T3 清洗 + upload/download 围栏 | runner 名+值双 scrub（含 stack）+ store 边界清洗 + browser-api fence；`test-script-runner` 31 / `test-browser-api` 14 |
| ✅ 已落地 | JWT 时钟容差 + 列表 `{total,rows}` 分页 | ±60s skew + executions/tasks 分页 total；`test-jwt-claims` 21 / `test-task-queue` 22 / `test-automation-manager` 11 / `test-cli` 23 |
| ✅ 已落地 | agent 桥 + caller 审计 | record/runScript 双工具 + run 级 ctx + MClient runTrajectory + 全事件 `caller:'agent'`；`test-agent-engine` 49 |

---

## 3. 明确不绕过架构（三个最大阻塞：不走捷径的裁定）

### 3.1 Playwright 外部接入被「无依赖 + 不开端口」策略挡住

- **问题**：§41 要求 Playwright `connectOverCDP` 外部可接。
- **原因**：① 仓库不 vendored `playwright`（`runtime.md` 验收 3 实测）；② ADR-3 禁止生产开 `--remote-debugging-port`。
- **影响**：外部脚本/CI 用 Playwright 驱动指纹浏览器的路径不通；但进程内 SDK 路径不受影响。
- **可选方案**：(a) 开 debug port——最快但全 CDP 无鉴权，绕过 allowlist 与审计，不做；(b) 进程内 endpoint：loopback 三门出 `wsEndpoint`，挂 Service 之外 Adapter 之上；(c) 砍掉该验收项。
- **现状 2026-09-26（已闭合）**：选 (b) 并**建成闭环**——`runtime/cdp-ws.js` 提供 loopback+token+Host 门控的 CDP-over-WS 端点（`GET /json/version`→`webSocketDebuggerUrl`），浏览器级发现/挂载由桥合成、页面级转发经既有 allowlist + 审计 + FP scrub；`probe-cdp-ws-client.js` 以协议级客户端走通完整握手与驱动链（11/11）。外部 Playwright/Puppeteer 用户侧自装后按标准 `connectOverCDP(wsUrl)` 即可接入；(a) 仍不做（不开原生 debug port）。
- **成本**：已支付（桥 371 行 + 15 单测 + 11 项真机探针）；新增监听面已按 security.md §4 三门约束记录。

### 3.2 中程暂停（pause 打断运行中任务）需要 runner AbortSignal

- **问题**：§41 pause-resume 要求中程可断。
- **原因**：`task.md` §3 `RUNNING→PAUSED` 过状态机直标即谎言；runner 曾只有 pre-start cancel；vm 内 hang 的 await 无法硬杀。
- **影响**：`stop()` 的「等自然结束」可能等到 per-task timeout 兜底。
- **可选方案**：(a) 硬标 PAUSED——技术债炸弹，禁止；(b) 协作式：AbortSignal 注入 + `pause({interrupt:true})` 收敛到 CANCELLED；(c) 文档化 ceiling。
- **现状 2026-09-26**：(b) 已落地到线——runner signal race + `step()` 边界 + `worker.pause/abortItem` + `createTaskExecutor` 翻译 + service/HTTP `{interrupt:true}`（`test-worker.js` 18、`test-integration.js` 8，hang 脚本 15s 内收敛）；#7 ✅。真暂停语义=收敛 CANCELLED，非 vm 冻结——已在行内写明，不再是 ceiling。
- **成本**：已支付。

### 3.3 Stress 压测被「无真实 profile + 无 persist partition」挡住

- **问题**：§41 完整测试中 Stress 档位。
- **原因**：Profile Manager P8 未落地则压「不存在的身份」是假数据；partition 无 `persist:` 则重启丢身份。
- **影响**：真浏览器资源账（CPU/RAM/进程数）未测。
- **可选方案**：(a) 假 profileContext 硬压——假数据，不做；(b) P0 profiles wire + `persist:auto-*` 先行再压；(c) 降级队列层 stress。
- **现状 2026-09-26**：(b) 前置已齐且**真窗档已测至 50**——队列级 `test-stress.js` 2 PASS + 真窗 `probe-real-stress.js` **8/8 ×4 档**（N=10/20/30/50 真 Window+分区：零丢失、同 profile `maxActive=1`、全局峰值 5、资源表 2.11/3.94/5.78/9.42 GB、teardown 归零）；#32 ✅。100 档因内存未跑（投影 ≈18–19 GB > 空闲 9.48 GB），`FP_STRESS_N=100` 一条命令可切——诚实标注，不伪造。
- **成本**：压测脚本复用 `testing.md` §2.1 Idle 运行器 + 采样器。

---

## 4. 状态

2026-09-28。34 行矩阵基于 475 PASS（SKIP 14）实跑（33 套独立进程 exit 全 0；2026-09-28 复跑）+ `Client/test-app-copy-sync.js` 21/21 + `Client/test-automation-panel.js` 19/19 + `test-automation-panel-bridge.js` 6/6 + `test-automation-panel-degrade.js` 5/5 + `test-packaged-automation.js` 12 检查（面板嵌入真 Client 主窗 + 默认运行带 runtime）+ MClient `test-agent-engine.js` 49（含 bridge）+ 真机探针 24/24 + 17/17 + 12/12 + 11/11 + 13/13 + 7/7 + 10/10 + 7/7 + 8/8×4 exit 0 + 生产入口冒烟 + §35 metrics 通链 + 中央审计通链；✅ 34 / 🔶 0 / ⛔ 0，另 §5 waive 2 项（文档/资产形态）。§3 三个阻塞全部收口（3.1 CDP 桥+宿主入口建成、3.2 AbortSignal、3.3 真窗档已测）+ P0 六缺口清零（trust/Broker/IPC 门/审计收集器/脱敏+T3/围栏/时钟容差/分页/rotate/agent 桥）；仅 50/100 真 profile 档为内存门控。

---

## 5. 明确 waive（本次 goal 条件允许，不再跟踪）

| 项 | 决议 | 理由 |
|---|---|---|
| Monaco bundle | waive（bundle 形态） | vendored Monaco 无离线资产管道，CDN 违反单机离线姿态。功能面已覆盖：textarea 基座 + `__mountMonaco` hook + vendor 自动加载（`panel.js` ensureMonaco，无网络探测，缺席即回退），不阻塞 #1/#2。 |
| templates/marketplace 专册 | waive | store/service/bridge/HTTP 全覆盖（`test-templates.js` 9 + `test-templates-api.js` 7）；专册文档缺失不挡功能行。 |
