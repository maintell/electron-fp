# Automation / Electron 已知陷阱速查

> 性质：实测/文档锚点接地的故障对照表。每条：**症状 / 根因（路径锚点）/ 处置**。
> 上游：`AGENTS.md`（构建与测试纪律）、`fingerSDK/docs/07`（启动遮蔽）、`current-architecture.md`、`runtime.md`、`security.md`、`script-sandbox.md`、`cli.md`、`api.md`、`scheduler.md`、`worker.md`、`competitor-research.md`、本仓 fingerprint 配置通道实测结论（memory）。

---

## 1. 运行时 / 打包

| # | 症状 | 根因（锚点） | 处置 |
|---|---|---|---|
| 1 | 独立 Electron 脚本零输出 / 跑的是旧打包代码 | `resources/app`（或 `default_app.asar`）遮蔽脚本：packaged app 优先于命令行脚本 | 打包目录改名后再跑：`F:\code\src\out\Default\resources\app` → `_app_off`；`Client/run-tests.js` 已内置 stash，手跑脚本要手动做（`fingerSDK/docs/07-startup-abort-diagnosis.md`、`AGENTS.md` §2） |
| 2 | 测试进程 FATAL abort、结果永不打印：`render_process_host_impl.cc` CHECK | `app.exit()` 前 BrowserWindow 未销毁，残留 renderer 触发 FATAL | `app.exit()` 前遍历 `BrowserWindow.getAllWindows()` 逐个 `destroy()`（`AGENTS.md` §2） |
| 3 | 编译/测试期间桌面卡死、机器不可用 | 测试/链接进程以 Normal 优先级吃满全核 | 全树降 Idle：`Start-Process -PassThru` 启动 → `Set-LowPriorityTree`（walk 孙进程）→ `WaitForExit()` 读退出码；**禁用** `start /LOW`（丢退出码）、禁用只降父进程、禁 `Start-Process -PriorityClass`（PS7 无此参数）（`AGENTS.md` §1.1–1.3） |
| 4 | 依赖被静默拉取/执行任意包 | `npx` 隐式下载执行 | 永不 `npx`：从 `node_modules/.bin/` 起，或 `yarn <tool>`（`AGENTS.md` §2、`CLAUDE.md`） |
| 5 | 测试输出行不计入 PASS/FAIL/SKIP | `Client/run-tests.js` 只统计行首 `PASS`/`FAIL`/`SKIP` | 断言日志严格用这三个前缀起行（`AGENTS.md` §2） |
| 6 | 控制台输出中文/± 号乱码（mojibake） | Windows 控制台代码页 vs 源文件 UTF-8 显示层差异 | 仅影响显示、不影响断言与退出码；不要据此改断言。需要核对时看退出码 / `--json` 输出 |

## 2. Session / partition / 指纹通道

| # | 症状 | 根因（锚点） | 处置 |
|---|---|---|---|
| 7 | 重启后 cookie/storage 全丢、用户无感知 | partition 无 `persist:` 前缀 = 内存态：`fp-tab-*`（`Client/main.js:191`）、`fp-group-*`（`MClient/main.js:484`）（`current-architecture.md` §12） | automation 侧一律 `persist:auto-{profileId}`（`runtime.md` §1.2、`task.md` §6）；临时/探针 session 才允许无前缀。生产样板：`fingerSDK/samples/mini-browser/main.js:14` 的 `persist:sdk-mini` |
| 8 | 同 partition 中途改 H2 无效 / 身份混合 | H2 在首次 `fromPartition` 冻结（`current-architecture.md` `:287-293`、`architecture.md` §4） | 后续改 H2 请求**如实拒绝**（`h2Error`），不静默丢弃；要换 H2 面须同 partition 重建 renderer 或换 partition |
| 9 | `FP_<key>=v` 设了没效果 | 实测：`FP_<key>` 仅 27 个 Int/Int64 键有效，36 个 String 键（`tz_id`/`navigator_platform`…）完全无效；且拼接逐字（小写）：`FP_hardware_concurrency` 有效、`FP_HARDWARE_CONCURRENCY` 无效 | String 键走 `FP_CONFIG_DATA=<原始 JSON>` 或 `FP_CONFIG=<文件路径>`（推荐）；`--fingerprint-config=<b64>` 用户手输无效（浏览器进程内部注入通道，`electron_browser_client.cc:700-709`）（`architecture.md` ADR-5） |
| 10 | `FP_CONFIG="  path"` 无效果、无报错 | `fp_config_helpers.h:32` `FpTrim` 只从尾部 pop——**前导**空白静默失效（尾部空白被剪掉，正常） | 去掉前导空白；对称 trim 会改动已发布补丁行为，有意未修（三处需等行数同步：helpers 头 + `00-core.patch` + `fp-fingerprint.patch`） |
| 11 | 任意进程改 env 即指纹注入 | env 通道无鉴权 | `FP_CONFIG*` 默认关闭，启用须 HMAC 签名信封（`architecture.md` ADR-5） |

## 3. CDP / IPC / 沙箱安全

| # | 症状 | 根因（锚点） | 处置 |
|---|---|---|---|
| 12 | 有人开 `--remote-debugging-port`：全 CDP 无鉴权面可 `Browser.close`/读系统信息 | 端口 = HTTP handler + `/json/list + ws` 全 CDP（`current-architecture.md` §17、`devtools_manager_delegate.cc:63-80`） | 生产**永不开**该 flag（ADR-3）；默认走进程内 `webContents.debugger`；外部接入只走 localhost+token+Host 三门（`runtime.md` §4） |
| 13 | debugger 直调被放行到敏感域 | `electron_api_debugger.cc:113-135` attach/sendCommand 无鉴权全字符串转发 | 过 allowlist：允许 Page/DOM/Input/Network-read/Runtime-limited；**拒** `Browser` / `Target.create*` / `SystemInfo`（`security.md` §4、`runtime.md` §6.2 门控点）；拒绝须 system+audit 双留痕 |
| 14 | renderer XSS → main 全权 | IPC 零 `event.sender` 校验：`Client/main.js:499-665` 全部忽略 `e`，`tabId \|\| activeTabId` fallback 可伪造 | P0 补 sender-check + URL gate；**automation 永不把 debugger 能力桥到 preload**（`current-architecture.md`、`gap-analysis` §IPC） |
| 15 | 脚本 `require('fs')`/逃逸 vm | node:vm 沙箱**非硬安全边界**，ceiling = 同进程逃逸 | 团队内脚本可接受；陌生人脚本升级 `utilityProcess/worker` + structured clone（`script-sandbox.md` §4、`script-runner.js` 头注释）；`env`/`eval`/`new Function` 永关 |
| 16 | 沙箱脚本访问 `process`/`fs` 得 PermissionError | filesystem/process 即使 permission 位 true 也须 `trusted === true` | 这是设计（`script-runner.js` `capAllowed`）；不要靠放宽位绕过，走 trusted 标志 |

## 4. CLI / HTTP / 队列语义

| # | 症状 | 根因（锚点） | 处置 |
|---|---|---|---|
| 17 | CLI/脚本把请求判失败但服务其实正常；HTTP 429 `RATE_LIMITED` | 网关固定窗口限流默认 60 req/min/token（`http-api.js:78,227-233`、`api.md` §4.1） | 429 按 `Retry-After` 退避 + 抖动，**不硬重试**（GoLogin 429 可 revoke token，`competitor-research.md` §13）；CLI 靠退出码分流：0 成功 / 1 失败 / 2 用法或未实现 / 3 NOT_FOUND（`cli.md` §3），勿解析 stderr |
| 18 | `script run` 挂起或结果不进队列 | CLI `script run` 走 manager 内联路径（`task_item_id` 空），不经 queue/worker（`cli.md` §5）；worker 仅 API/HTTP 异步队列模式 | 排队/重试语义用 `task enqueue` 类命令或 HTTP；`automation/bin/browser-cli.js` 有意不 `worker.start()` |
| 19 | 同一 store 并发写损坏 JSON | store 文件锁缺失（`cli.md` §5 ceiling） | 同一 `FP_AUTOMATION_STORE` 只跑一个 CLI 实例；SQLite WAL 落地后自然解除 |
| 20 | ~~HTTP 调 `POST /scripts/:id/versions` 等 404~~ 已修复（2026-09-26）：3 行路由已挂（`test-http-api.js` versions/export/import 块 + `test-integration.js` 跨层往返） | 若复现，先查网关路由表与 service 方法名是否同名（`saveVersion`/`exportOne`/`importOne`） |
| 21 | 外部 Playwright 连不上 / 只见单 context / close 行为怪 | 仓库**无 playwright 依赖**（`runtime.md:261` 冒烟未跑，三门也未建）；`connectOverCDP` 低保真：通常只见 `contexts()[0]`，`close()` 默认不杀底层浏览器 | 依赖多 context 隔离的 Playwright 模式不可用（`competitor-research.md:99`、`runtime.md` §4）；外部接入前先建 localhost+token+Host 三门；`browser.newContext()` 禁止/不存在 |

## 5. 调度 / Worker

| # | 症状 | 根因（锚点） | 处置 |
|---|---|---|---|
| 22 | 停机恢复后没补跑历史槽；audit 里只见一条 `schedule-skip` | catch-up 防雪崩：错过 N 槽**只补一次**，多余槽丢弃记 `schedule-skip`（`scheduler.md` catch-up 行、`scheduler.js:246-248`） | 设计如此，勿当 bug 加循环；interval 停机期间也不回填（`reschedule` 注释 never backfill）。once 型过期则下个 tick 补发一次 |
| 23 | `worker.pause()` 后运行中任务还在跑 | pause = **停止认领**，不打断 STARTING/RUNNING（`worker.js:38-39`、`worker.md` §6 ceiling；`RUNNING→PAUSED` 迁移非法，`task.md` §3） | 等自然结束或 `stop()`（仍等 drain）；要中程中断需 runner 注入 AbortSignal + smart wait 查 `signal.aborted`（升级路径 `worker.md` §6） |
| 24 | 同 profile 任务被并行执行 | 违反"同一身份不并行写"（`task.md` §4 唯一 `(task_id, profile_id)`） | 同 profile 靠 claim/bind `persist:auto-{profileId}` 串行；`worker.md` §3 |
| 25 | 连续 5 次 `RECOVERABLE_SESSION` 后 worker 不再认领 | `consecutiveFailures >= 5` → `abort()` 自停（`worker.js:136-138`） | 查 session 恢复链（`runtime.md` §5.2 七步，步骤 6 relaunch/reattach 是 P1 缺口）；恢复后重建 worker |

---

## 6. 打包 / 模块解析（packaged automation runtime）

| # | 症状 | 根因（锚点） | 处置 |
|---|---|---|---|
| 26 | 默认 `electron.exe` 运行（加载 `resources/app`）时面板降级为 "bridge not available"、静默无桥 | ① `resources/automation` 缺失——接入点 `Client/main.js:905` 的 `require('../automation/electron/wire')` 期望 `resources/{app,automation}` 平级；② 即使已复制：`out/Default/package.json` 是 `"type":"module"`（TS 工具链守卫），树内无就近 CommonJS 标记则 `resources/automation/**/*.js` 被按 ESM 解析，`require` 报错并被一行接线 try/catch **静默吞掉** | 复制 `automation/{electron,runtime}` + 树根 `package.json`（`"type":"commonjs"`，见其 `//` 注释）→ `resources/automation/`；守护 `Client/test-packaged-automation.js`（双树 parity + 可加载 + 标记在位，12 检查）；半接线 host 下面板自动走降级态（`test-automation-panel-degrade.js` 5 检查） |

---

## 快速分流

- **进程起不来 / 输出空** → §1 #1、#2
- **构建把机器打死** → §1 #3（Idle 树降 + detached 轮询）
- **cookie 活不过重启** → §2 #7
- **指纹 env 不生效** → §2 #9、#10
- **安全审查报 CDP/IPC** → §3 #12–#14
- **CI 拿不到正确退出码** → §4 #17（退出码表 `cli.md` §3）
- **定时任务少跑** → §5 #22；**pause 不停当前跑** → §5 #23
- **默认运行下面板无桥 / 降级态** → §6 #26
