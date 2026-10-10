# Automation 测试策略（分层 + 运行规范 + 回归门）

> 性质：测试契约文档。上游：user spec §36（分层）、`AGENTS.md` §1（Idle 优先级）+ 项目约束（PASS 前缀 / 禁 npx / resources/app 影子）、`Client/run-tests.js`（模式参考）。
> 全部 PASS 数为 **2026-09-28 实跑**（逐文件独立进程，exit 全 0）；Electron 探针为真链路实跑（built binary，resources/app 影子已处理并恢复）。

---

## 1. 分层（spec §36）

| 层 | 覆盖域 | 状态 |
|---|---|---|
| Unit | parser / AST / runtime / selector / state machine / retry / scheduler / permission / seeded-rng / ipc / templates / humanize input / ws / cdp-ws / cdp-server / live-recorder / recorder-control / forensics / metrics-e2e / serve / pause-interrupt / relaunch-hook / browser-api / jwt-claims / audit-log | ✅ 33 套，475 PASS（SKIP 14：human-input 1 + browser-api 13） |
| Integration | store→service→HTTP→CLI→worker/executor 全链往返（含 profiles/versions/export-import/中程中断/CLI task run→HTTP） | ✅ `test-integration.js` 8 PASS（Node 级，fake launcher） |
| E2E | 真链路：page 全 ops + launcher partition + relaunch + 真脚本 manager 执行 + 真实 HTTP 源全链 + preload 加法面 | ✅ `probe-automation-smoke.js` 24/24 + `probe-script-e2e.js` 17/17 + `probe-real-site-e2e.js` 12/12 + `probe-preload-surface.js` 13/13（built Electron 实跑 exit 全 0） |
| Stress | 队列级 100×10/并发5 + **真窗档 N=10/20/30/50**（每 profile 真 Window+分区） | ✅ `test-stress.js` 2 PASS + `probe-real-stress.js` 8/8 ×4 档（零丢失、同 profile maxActive=1、峰值 5、资源表至 9.42 GB；100 待内存余量，`FP_STRESS_N=100` 可切） |

---

## 2. Unit 层：`automation/test-*.js` 清单（2026-09-26 实跑）

| 文件 | 覆盖域 | PASS |
|---|---|---|
| `test-core.js` | session 状态机（合法/非法迁移含 closed 终态）、CDP allowlist（含只读发现增项 `Browser.getVersion`/`Target.getTargets`）、FP scrub | 16 |
| `test-browser-session.js` | debugger attach/detach（mock webContents）、崩溃 `recover()`、cdp-deny/call 审计、**isolated world 默认+主 world 告警**、`session.input.send`、**stale-context 自愈重试+导航事件失效** | 20 |
| `test-script-store.js` | 参数类型（9 种 coerce/校验）、export/import、软删、JSON 持久化、**trust 门（签名钉选版本/版本 bump 掉签/import/export 不带签）** | 13 |
| `test-script-runner.js` | vm 沙箱注入/deny、capability 权限、error taxonomy、超时、cancel、MAX_LOGS、AbortSignal 中程中断、失败截图 artifacts、onLog 直播、**失败取证 `record.trace`（HTML/网络/URL + 字节上限）**、**T3 清洗 + secret 双 scrub + trustResolver 三态** | 31 |
| `test-forensics.js` | §16 取证包：HTML 捕获+**262144 字节硬截断**、缺失/抛错/非字符串 evaluate → `sources.html=false` 不抛、网络尾部 50 条、URL 优先级与 currentUrl 回退、SUCCESS/CANCELLED 无 trace、TIMEOUT 也取证 | 12 |
| `test-automation-manager.js` | 并发上限 fail-fast、cancel、版本钉选、分页 `{total,rows}` newest-first、AbortController 中断收敛、**metrics 喂养（每条终态一条 record；无 metrics 行为不变）** | 11 |
| `test-task-queue.js` | 12 态状态机、backoff、state/state-deny 审计、cancel/retryNow、shutdown、**claim({skip}) 谓词（保序、可后续认领、异常透传）**、**list `{total,rows}`** | 22 |
| `test-worker.js` | claim FIFO、semaphore 全局并发帽、心跳载荷 + heartbeat_miss、pause/resume、`pause({interrupt:true})`/`abortItem` 中程 abort、`BROWSER_CRASH → relaunch` 钩、**同 profile 串行（claim skip 强制）** | 18 |
| `test-ws-api.js` | WS 握手三门（401/403/404）、viewer/ADMIN 角色拆分、RPC、subscribe 终态推送、unsub、ping/pong（raw-socket 客户端，零依赖） | 6 |
| `test-cdp-ws.js` | CDP-WS 桥：路由（getVersion 转发/合成、getTargets 合成、setDiscoverTargets→targetCreated、attachToTarget→sessionId、page 级转发 sessionId 剥离/回填、非白名单 -32601+审计）+ HTTP/WS 三门（401/403/404/200） | 20 |
| `test-cdp-server.js` | 宿主入口：start 返回 port/baseUrl+自动 publishAll、`urlFor` 与 `/json/version` 广告串逐字一致、publish 回调、未知 profile 发现 404、stop 关闭+幂等、无 onUrl 路径 | 7 |
| `test-live-recorder.js` | 实时录制：注入脚本自包含+缓冲上限、raw→recorder evt 映射、debounce 继承、空/坏缓冲不崩、stop 冲刷+卸载+审计、ast() 过 validate、selector 质量、**跨文档（did-navigate 队列+重注入守卫、主帧 drain、mid-load 重试、stop 移除监听）** | 12 |
| `test-recorder-service.js` | 录制控制面：四方法信封透传、controller 错误 → code 映射、无 controller → 四方法均 honest NOT_IMPLEMENTED | 6 |
| `test-templates-api.js` | 模板 service 安装幂等/list/bridge/HTTP | 7 |
| `test-rpa-ast.js` | AST 校验（节点/步数/循环上限）、执行器节点语义 | 16 |
| `test-rpa-recorder.js` | 选择器生成（data-testid/css/xpath/coordinate）、事件→节点、**gap-wait rng jitter、`lintBlockingSleeps`** | 27 |
| `test-scheduler.js` | once/interval/cron（宏 `@daily` 等在解析层展开）、错过槽丢弃不回填 + interval>2×everyMs 记 schedule-skip、schedule-fire 记账、校验拒绝 | 11 |
| `test-http-api.js` | 网关六关卡、信封/错误码、限流 429 + Retry-After、token 不入 audit、profiles 接线、RBAC viewer、CDP endpoint、JWT 开关向后兼容、**`GET /api/metrics`（聚合一致性 + `?scriptId=` 过滤 + 401/501）**、**trust 门（bearer 403/Admin-JWT 200/签名 400/未配 501）**、**broker fingerprint/rotate**、**audit query/stats**、**executions `{total,rows}`** | 27 |
| `test-jwt-claims.js` | HS256 手写校验（签名/exp/nbf/alg/typ/畸形/缺 sub）、**时钟容差 ±60s**、权限映射 403 命名、Viewer 默认只读 vs 显式授权、角色缺省表、token 零泄漏、向后兼容 | 21 |
| `test-cli.js` | runCli 退出码 0/1/2/3、信封透传、profile 接线（list 打印/未知 id→3/无 manager→2）、**`task run` enqueue（flags 映射/裸 spec）**、**`metrics` 命令（人类可读 + `--json` + 未接线 → 2）**、**`script trust/untrust` + `profile fingerprint/rotate`**、**task list total 尾行** | 23 |
| `test-metrics.js` | createMetrics 9 API（见 `observability.md` §2.2；**crashRate 终态分母**） | 9 |
| `test-profile-manager.js` | Profile CRUD、persist:auto-*、start/stop 三元组（含 inProcess）、bulkStart、assertOwned ACL、软删、**setEndpoint（running-only 合并、永不落盘）**、**broker 五门 + rotate（stop→update→start/H2 预检/bearer）** | 17 |
| `test-ipc-bridge.js` | **50 通道**白名单（含 9 profiles + 2 trust + 2 broker + 2 audit + 2 templates + 4 recorder + metrics）、sender URL/webview 拒、audit 零 args 泄漏 | 18 |
| `test-browser-api.js` | SDK facade 1:1 映射（driver 缺项显式 SKIP×13）、cookies 委派精确参数、frozen context、**`page.evaluate`/`getCurrentUrl` 条件透传（driver 有则委托、无则省略）+ `network.enable` 转发**、**upload/download fence（越界/null/无围栏 deny）** | 14（+13 SKIP） |
| `test-templates.js` | 11 模板解析/权限/幂等安装/版本 bump/data-extraction 单 evaluate | 9 |
| `test-seeded-rng.js` | hashSeed 稳定/雪崩、mulberry32 确定性/分歧、int/jitter 边界、无 Math.random、task-queue backoff 确定性、worker rng 启停、seed 不落盘 | 9 |
| `test-human-input.js` | Fitts 定时/Bezier 轨迹端点与 dt 和/click hold/mistake 回退/scroll 和值/seed 确定性分歧 | 25（+1 SKIP） |
| `test-input-adapter.js` | send-first/CDP-fallback、事件顺序、Backspace 映射、wheel 透传、A/B 缝线 contract 回归 | 10 |
| `test-electron-wire.js` | wire 模块：mock ipcMain 注册全 allowlist 通道、status/脚本往返、profiles wired roundtrip、emit、live-log e2e、main.js 钩子断言、**audit query e2e（中央收集器）** | 10 |
| `test-integration.js` | 跨层：HTTP 建脚本→service 可见→CLI 打印；versions→run；export/import 新 id；profile 起停→CLI/cdp；task 入列→CLI；CLI `task run`→HTTP 可见；worker/executor 执行；HTTP 中程中断收敛 | 8 |
| `test-stress.js` | 100 items/10 profiles/并发 5 零丢失+cap+心跳；list p99<500ms | 2 |
| `test-serve.js` | 生产入口：start 返回 port/token、鉴权 200/401、脚本 API 往返、**worker 真跑队列任务**、**scheduler tick 触发**、WS RPC + 坏 token 拒、stop 关端口+停 worker、token 自动生成+双 stop 安全、**metrics 端到端（跑完可 GET /api/metrics 断言总量/失败率）** | 9 |
| `test-audit-log.js` | 中央收集器：索引键默认、`fn` 双形、query 过滤+分页、门口脱敏、JSONL 落盘、ring 上限、坏路径降级、**wire 全模块漏斗 + 显式 audit 双写** | 9 |
| **合计** | 33 文件 | **475 PASS / 0 FAIL（SKIP 14）** |

- 全部输出 `PASS `/`FAIL `/`SKIP ` 前缀（各文件 `check/t` helper 统一格式）；进程独立，一套崩不连坐（同 `Client/run-tests.js` 设计理由 2）。
- permission/capability 断言在 `test-script-runner.js`（filesystem/process 默认 deny、eval 永关、params 冻结）。

### 2.1 回归门

1. **新增 runtime 模块必须带 `automation/test-*.js`**——无测试的 `runtime/*.js` 不算交付。
2. **全量 suite** = `automation/test-*.js` 顺序跑，**exit code 全 0 且 FAIL=0**：
   ```powershell
   # 每文件独立进程 + Idle（AGENTS.md §1；Start-Process -PriorityClass 不存在，用启动后降级）
   $files = Get-ChildItem F:\code\electron-fp\automation -Filter test-*.js | Sort-Object Name
   foreach ($f in $files) {
     $p = Start-Process node -ArgumentList $f.FullName -PassThru -WindowStyle Hidden `
          -RedirectStandardOutput "$env:TEMP\t.out" -WorkingDirectory F:\code\electron-fp
     Start-Sleep -Milliseconds 400
     try { $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::Idle } catch {}
     $p.WaitForExit()
     if ($p.ExitCode -ne 0) { Write-Host "FAIL $($f.Name) exit=$($p.ExitCode)" }
   }
   ```
3. 断言计数漂移（新增/删除 check）→ 同步更新 §2 表格数字。

### 2.2 Phase 0–8 验收记录（2026-09-27 修订）

| 门 | 结果 |
|---|---|
| 全量 33 套复跑 | **475 PASS / 0 FAIL（SKIP 14），exit 全 0**（2026-09-28 复跑：store 13 / runner 31 / manager 11 / queue 22 / worker 18 / scheduler 11 / core 16 / profile 17 / jwt 21 / metrics 9 / templates 9+7 / browser-session 20 / browser-api 14 / human-input 25 / input-adapter 10 / rng 9 / stress 2 / rpa-ast 16 / rpa-recorder 27 / recorder-service 6 / live-recorder 12 / forensics 12 / ws 6 / cdp-ws 20 / cdp-server 7 / integration 8 / serve 9 / cli 23 / http 27 / ipc 18 / wire 10 / audit-log 9） |
| P1 人性化三车道 Idle 复跑 | **human-input 25（+1 SKIP）/ input-adapter 10 / recorder 27 / browser-session 16，exit 全 0** |
| CLI 退出码（bin/browser-cli.js 实测口径） | NOT_FOUND→3、VALIDATION→2、profile 未接线→2（`test-cli.js` 23 PASS 覆盖接线后行为：trust/untrust、fingerprint/rotate、task total） |
| mapError 顺序修复 + ProfileError code 直认 | `not found` 嗅探先于 `ScriptError`→VALIDATION；`e.code` 已知码（CONFLICT/LIMIT/NOT_FOUND/VALIDATION）直接采用——`CONFLICT: …` 前缀与 `launcher not wired` 不再误落 VALIDATION |
| http-api 安全关卡 + RBAC + JWT | 无/错 token 401、Host 劫持 403、限流 429、CORS 403、token 不入 audit、viewer 写 403、JWT 权限映射 403 命名（27 PASS + `test-jwt-claims.js` 21 PASS：时钟容差 ±60s、trust 门、broker、audit query） |
| 面板语法 + §27 视图覆盖 + 真浏览器冒烟 | `panel.js` / `rpa.js` / `panel-templates.js` / `preload.js` `node --check` exit 0；视图全覆盖（Scripts / Tasks / Schedules / API + 执行详情含日志/工件/时间线 + RPA builder + Templates），preload **29 通道全部命中桥白名单**；**真浏览器冒烟已过**（Playwright MCP + 本地静态服务：4 视图切换 / Tasks 6 行 25 钮 / Schedules 3 行+表单 / API 88 code 块 / 执行详情 timeline+artifacts / **RPA Record→Stop→Append 全循环**，console 0 error）；并据此抓出并修复 `rpa.js` `findAll` `baseParts` 崩溃（三处调用仅传 2 参 → 任何非空流程校验必崩，静态检查漏网）；**Wave16 嵌入真 Client 主窗**：右侧列（与指纹面板互斥、🤖/F9、420px 让位几何）+ `#ap-panel .ap-main` 防溢出覆盖——真窗 `Client/test-automation-panel.js` **19 PASS**（挂载/互斥/列宽/不遮挡/无横向溢出，run-tests.js 直跑 electron）+ 真桥 E2E `test-automation-panel-bridge.js` **6 PASS**（真 preload+wire+IPC：脚本/templates 双通道渲染）+ 降级 E2E `test-automation-panel-degrade.js` **5 PASS**（preload 在/handler 缺位 → absent-bridge 态）+ packaged runtime 守护 `Client/test-packaged-automation.js` **12 检查**（`resources/automation` 双树 parity + CommonJS 标记 + 可加载：buildLocalStack/attachAutomation 44 通道/scripts.list），packaged 同步 `test-app-copy-sync.js` **21/21** |
| Integration / Stress | ✅ Node 级（§1）+ **真窗档已测**（§5：N=10/20/30/50，含资源表/吞吐/teardown） |
| Electron 真链路探针 | ✅ `probe-automation-smoke.js` 24/24（attach/deny/evaluate/scrub/click/screenshot/input + page 全 ops + launcher partition/stop + relaunch cookie 存活）；`probe-script-e2e.js` 17/17（真脚本 manager→runner + 失败取证 HTML/网络/URL，含**生产 facade 路径**断言）；`probe-real-site-e2e.js` 12/12（真 HTTP 源全链）；`probe-real-stress.js` 8/8 ×4 档（N=10/20/30/50 真窗资源账）；`probe-preload-surface.js` 13/13（preload 加法面：templates+onAutomationEvent 在位、既有 facade 完整、渲染器零 Node 泄漏）；`probe-cdp-ws-client.js` 11/11（外部 CDP 客户端：/json/version→WS 三门→getVersion→targetCreated→attach→Page.enable/navigate/loadEventFired→Runtime.evaluate→控制方法拒绝）；`probe-live-recorder.js` 7/7（真机 Record→Replay + 跨文档两页流程重放）；`probe-cdp-server.js` 10/10（宿主入口：发布 cdpUrl→外部 CDP 客户端驱动 launcher 启动的 profile）；`probe-recorder-control.js` 7/7（录制控制面真机：start→state→动作→drain 有序 goto/fill/click→stop 有效 AST→未知会话 NOT_FOUND→teardown 干净），built binary 实跑 exit 全 0 |

---

## 3. Integration 层（✅ Node 级已建，2026-09-26）

`test-integration.js` 8 PASS：同一 stack（store→service→HTTP→CLI flat façade）上脚本 CRUD/版本钉选执行/export-import/profile 起停/task 入列全链往返 + worker/executor 真执行（SUCCESS 回值）+ HTTP `pause{interrupt:true}` 中程收敛 CANCELLED。fake launcher（wsEndpoint 可控），无真浏览器。

Electron 真链路集成 = `probe-automation-smoke.js`（§2.2，24/24）+ `probe-script-e2e.js`（17/17，manager 级真执行 + 失败取证含生产 facade 路径）。`playwright` 依赖仍未 vendored——endpoint 侧已发布（`api.md` §6），client 侧 smoke 待补。

**路径 = `Client/run-tests.js` 模式**（复用其三条硬经验，`Client/run-tests.js:1-27`）：

| 模式要点 | 说明 |
|---|---|
| resources/app 影子 | `out/Default/resources/app` 存在时 electron.exe 起打包应用、脚本零输出——runner 自动 rename `_app_off` 并在 exit 恢复；手动跑独立脚本须先处理（项目 AGENTS.md） |
| 一文件一进程 | BrowserView/随机 partition/崩溃隔离；失败不连坐 |
| keepAlive 窗口 | 摧毁最后一个 BrowserWindow 会触发退出、结果打不出来——`app.exit` 前保持至少一窗 |
| Idle 优先级 | 全程 + 全部子进程 Idle（`Set-LowPriorityTree` 树遍历降级，编译/测试子进程一并覆盖） |
| `e test` | **不跑**，除非用户明说（项目约束） |

首批 Integration 用例（P1 glue 就绪后按序开）：真实 `attach` → allowlist deny 真链路 → FP scrub 真日志 → `connectOverCDP` 三门 smoke（需先装 playwright + 建 token/Host/端口三门）。

---

## 4. E2E 层（探针 ✅ 24/24 + 17/17 + 12/12 + 11/11 + 13/13 + 7/7 + 10/10 + 7/7 + 8/8×4 / 真实站点已证）

- 已证（真链路，`probe-automation-smoke.js` 24/24，exit 0）：attach → allowlist deny → FP scrub → click 真 send → 截图 → input.send 不抛 → `electron/page.js` 全 ops（file:// 离线页 goto/click-toggle/fill 回读/Enter 提交/cookies/storage/upload/download/network 事件/waits/截图）→ `glue.restartSession` 同 partition relaunch（carried cookie + marker 重 goto）→ launcher persist partition（start/stop/同 id relaunch cookie `rl2` 存活）；另 `probe-script-e2e.js` **17/17**：真脚本经 manager→runner 对真窗执行（SUCCESS 回读/日志/真 CDP calls + 失败取证 HTML/网络/URL，含生产 facade 路径）；`probe-real-site-e2e.js` **12/12**：真 HTTP 源（127.0.0.1）navigate → login POST→302 → welcome 读取 → cookie scoping → localStorage 跨 reload → attachment download(13B) → network ring → 截图 → 403 负例 + 可选公网 example.com 实连。
- 真实站点全链已证（本地 HTTP 源 12/12，isolated-world 默认路径）；资源账已测至 N=50（§5：8/8×4 档；100 待内存门控）；playwright 协议级客户端已证（#25 边界：真依赖不 vendored）。
- 前置：P3（Download/Upload/Dialog SDK 面绑定；driver 级已实）+ 截图落盘归档。
- **smoke.js CDP 模式**：仓库现状无 automation 侧 `smoke.js`（仅 `fingerprint/scripts/smoke.js`，指纹探针非 CDP）。可复用的 CDP 形态 = `Client/test-coverage-audit.js:430` 的 `wc.debugger.attach("1.3")` 模式——E2E smoke 起草时从这里抽，不新发明 attach 流程。
- 站点选择：先 `FP_AUDIT_SITES`（browserleaks/creepjs，`Client/main.js:55-58`）这类只读审计站，login 类站点需凭据注入设计后再开。

---

## 5. Stress 层（✅ 队列级 + 真窗档，2026-09-26）

- **队列级**：`test-stress.js` 2 PASS——100 items × 10 profiles、并发 5：零丢失、maxParallel≤cap、heartbeat 存活、list p99<500ms。
- **真窗档**：`probe-real-stress.js` **8/8 ×4 档**（built Electron 实跑 exit 0）——N 个真 BrowserWindow（`FP_STRESS_N`，默认 10）＋每 profile 复用 glue 会话＋每 profile 独立 manager＋单 worker（并发 5）：
  - N=10（50 items）：零丢失 50/50、同 profile `maxActive=1`、全局峰值 5、heartbeat 7×；wall 2.0s（avg 40ms/item）；工作集 1.83 GB → 峰值 2.11 GB → teardown 0.36 GB；`Tab` 进程数 = 窗口数（10），拆除后 3 进程。
  - N=20（100 items）：零丢失 100/100、串行与全局帽同守；wall 3.7s（avg 37ms）；工作集 3.39 → 3.94 → 0.42 GB；`Tab`=20。
  - N=30（150 items）：零丢失 150/150、`maxActive=1`、全局峰值 5、heartbeat 19×；wall 5.1s（avg 34ms）；工作集 4.96 → 5.78 → 0.47 GB；`Tab`=30（33 进程）。
  - **N=50（250 items，2026-09-26 达标）**：零丢失 250/250、`maxActive=1`、全局峰值 5、heartbeat 40×；wall 10.8s（avg 43ms）；工作集 8.12 → 9.42 → 0.55 GB；`Tab`=50（53 进程）；setup 10.1s / teardown 1.4s。
  - 换算 ≈165–197 MB/渲染器：100 档投影 ≈18–19 GB，超本机当前空闲（9.48 GB）→ **未跑**（诚实边界，不伪造）；`$env:FP_STRESS_N=100` 一条命令可切，待更大内存机器/释放后执行。teardown 断言：`BrowserWindow.getAllWindows()===0` 且 launcher 列表空。
- **前置**：Profile Manager P8 ✅（`persist:auto-{profileId}` 已真接线 = launcher）。
- **监控项**：`app.getAppMetrics()`（workingSetSize / percentCPUUsage / byType）+ worker 心跳载荷 + launcher 窗口数；本探针三项全采。
- **判据**（已实测）：无 item 丢失 ✅、同 profile 零并行写 ✅（claim skip 强制）、全局并发 ≤cap ✅、teardown 零残留 ✅。

---

## 6. 运行规范（硬约束）

| 规则 | 来源 |
|---|---|
| 所有测试进程（含子进程树）**Idle 优先级** | 项目 `AGENTS.md` §1；`Start-Process -PriorityClass` 不存在 → 启动后降级 + 树遍历 |
| 输出行前缀 **`PASS `/`FAIL `/`SKIP `** | `Client/run-tests.js` 只数这三个前缀；automation 各文件已同格式 |
| **禁 npx** | 项目约束：静默拉取任意包；用 `node_modules/.bin/` 或 `yarn <tool>` |
| 不跑 `e test` / `e start` | 除非用户要求；`e` 本机未装 |
| 独立 Electron 脚本先移 `resources/app` → `_app_off` | 影子问题（`run-tests.js` 自动处理，手动跑须自查） |
| 销毁全部 BrowserWindow 前先 `app.exit` 之外保持存活窗口 | 否则 FATAL CHECK 中止、结果不打印（项目 AGENTS.md） |
| 顺序执行、逐文件收集 exit code | 全 0 才算绿；不并行（Idle 下并行无收益且互相抢尾巴 CPU） |

---

## 7. 状态

2026-09-28。Unit 33 套 475 PASS（SKIP 14）实跑存证（新增 `test-audit-log.js` 9；store/runner/manager/queue/http/jwt/cli/metrics/profile/ipc/browser-api/cdp-ws 增量见 §2 表）；MClient `test-agent-engine.js` 49 PASS（含 bridge T12/T13 + caller:'agent' 审计标记）；Integration（8）/ Stress（2）Node 级已建；E2E 真链路探针 24/24 + 17/17 + 12/12 + 11/11 + 13/13 + 7/7 + 10/10 + 7/7 + 8/8 ×4 档（page 全 ops、真脚本 manager 执行 + 生产态失败取证、真实 HTTP 源全链、外部 CDP 客户端驱动、preload 面、真机 Record→Replay 跨文档、宿主 CDP 入口发布可连 URL、录制控制面全链、真窗资源账）；生产入口 `bin/serve.js` 冒烟 + §35 metrics 通链（manager→service→HTTP/CLI/IPC）+ 中央审计通链（全模块→collector→HTTP/IPC query）；仅 50/100 真 profile 档为内存门控边界（§5），一条命令可切。
