# 09 · 测试与验收计划（Automation 研究 + 设计包）

> 性质：**测试 + 验收契约**。定位：把仓内**已实测**的测试资产（`docs/automation/testing.md`、`acceptance.md`）与**待建**的测试项合并成一份可执行、可判定的计划。
> 口径铁律：本文件**不新增任何未实测数字**。凡标「基线」者一律引 `testing.md` / `acceptance.md` 实跑记录并注明日期；凡标「待测」者只给**测量方法**，不给预估值。
> 上游：user spec §12（验收条件）、§36（测试分层）、§41（最终验收）；`docs/automation/testing.md`（475 PASS 清单）、`acceptance.md`（34 行矩阵）、`automation-gap-analysis.md`（P0–P10 / 阻塞项）、`troubleshooting.md`（陷阱表）、`AGENTS.md`（构建与测试纪律）。
> 同包：`./05-system-architecture.md`、`./06-script-sdk-specification.md`、`./07-data-model-and-api.md`、`./10-implementation-roadmap.md`；同包编号 00–11，本文件为 **09**。

---

## 1. 测试分层与运行入口

| 层 | 载体 | 运行入口 | 计数口径 | 现状基线（实跑） |
|---|---|---|---|---|
| Unit | `automation/test-*.js`（**33** 文件，Node） | 逐文件独立 `node <file>`，进程隔离 | 行首 `PASS `/`FAIL `/`SKIP ` | **475 PASS / 0 FAIL / SKIP 14**，exit 全 0（2026-09-28） |
| Integration | `automation/test-integration.js`（Node，fake launcher） | `node automation/test-integration.js` | 同上 | **8 PASS** |
| E2E | `automation/probe-*.js`（**11** 文件，built Electron 真链路） | `node Client/run-tests.js <probe>`（自动 stash `resources/app`）或独立跑前手改 `_app_off` | 同上 | smoke **24/24**、script-e2e **17/17**、real-site **12/12**、cdp-ws-client **11/11**、cdp-server **10/10**、preload **13/13**、live-recorder **7/7**、recorder-control **7/7** |
| Stress | `automation/test-stress.js`（队列级）+ `probe-real-stress.js`（真窗档） | Node / Electron | 同上 | test-stress **2 PASS**；probe-real-stress **8/8 ×4**（N=10/20/30/50） |
| Client 面板 | `Client/test-automation-panel.js` / `-bridge.js` / `-degrade.js`（Electron） | `node Client/run-tests.js test-automation-panel.js` | `Client/run-tests.js` 只数 `PASS`/`FAIL`/`SKIP` | panel **19 PASS**、bridge **6 PASS**、degrade **5 PASS** |
| 打包守护 | `Client/test-packaged-automation.js`（Node） | `node Client/test-packaged-automation.js` | 自定义 12 检查 | **12 检查**（`resources/automation` 双树 parity + CommonJS 标记 + 可加载） |
| 打包启动 | `Client/test-packaged-boot.js` | `node Client/run-tests.js test-packaged-boot.js` | PASS/FAIL | **15 PASS**（模块图 + 资产引用） |
| 副本同步 | `Client/test-app-copy-sync.js` | Node | 自定义 | **21/21** |
| 指纹静态门 | `fingerprint/scripts/check.py` | `python fingerprint/scripts/check.py` | 退出码 | 静态闸（<1s），patch 集 7 片 `00→60` |

### 1.1 硬约束（所有层通用，源 `AGENTS.md` §1–§2 + `testing.md` §6）

| 约束 | 说明 |
|---|---|
| **Idle 优先级** | 编译/测试全树降 Idle：`Start-Process -PassThru` 启动 → `Set-LowPriorityTree`（walk 孙进程）→ `WaitForExit()` 读退出码；**禁** `start /LOW`（丢退出码）、**禁**只降父进程、**禁** `Start-Process -PriorityClass`（PS7 无此参数） |
| **PASS/FAIL/SKIP 前缀** | `Client/run-tests.js` 只统计行首这三个前缀；automation 各文件已同格式 |
| **禁 npx** | 从 `node_modules/.bin/` 起或 `yarn <tool>` |
| **`e` 未安装** | 用直连 `F:\code\src\third_party\ninja\ninja.exe -C F:\code\src\out\Default electron`；不跑 `e test`/`e start` |
| **resources/app 影子** | 独立 Electron 脚本前 `out/Default/resources/app` → `_app_off`（`Client/run-tests.js` 自动处理） |
| **退出前销毁窗口** | `app.exit()` 前逐个 `destroy()`，否则 `render_process_host_impl.cc` FATAL CHECK 中止、结果不打印 |
| **零外部解释器（分发）** | 客户分发不得依赖系统 `node`/`python`；打包验证需在无解释器环境跑通三链路（见 [16](16-zero-runtime-distribution-constraints.md)） |

### 1.2 全量 Unit 复跑命令（可直接执行）

```powershell
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

---

## 2. 功能测试用例

> 每行 6 列：用例 / 前置条件 / 执行步骤 / 预期结果 / 失败判定 / 现有覆盖锚点。锚点中的 PASS 数为 2026-09-28 实跑。

| 用例 | 前置条件 | 执行步骤 | 预期结果 | 失败判定 | 覆盖锚点 |
|---|---|---|---|---|---|
| **F1 脚本 CRUD** | store 可写目录；service 就绪 | create → read → update meta → list → 软删 → list | 每步返回一致对象；软删后默认列表不含；JSON 持久化重载可见 | 任一返回字段不符 / 重载丢失 / 删除未生效 | `test-script-store.js` **13**、`test-automation-manager.js` **11**、`test-http-api.js` **27**（POST 201）、`test-cli.js` **23** |
| **F2 语法检查** | 一段含语法错误的源码 | 提交 → 编译/校验 | 拒绝且给出 `SyntaxError` 类 error taxonomy；不产生 execution | 语法错误被接受 / 崩溃 / 无错误分类 | `test-script-runner.js` **31**（vm compile/deny）；`test-rpa-ast.js` **16**（AST 节点/步数/循环上限） |
| **F3 启动正常结束** | 合法脚本 + 可启动 session | run(spec, params) | 终态 SUCCESS；返回值可读；日志完整 | 终态非 SUCCESS / 返回值缺失 | `test-automation-manager.js` **11**、`test-integration.js` **8**（SUCCESS 回值） |
| **F4 主动抛异常** | 脚本内 `throw` | run | 终态 FAILED；error taxonomy 归类；失败截图/取证产出 | 未归类 / 未落终态 / 记录挂死 | `test-script-runner.js` **31**（error taxonomy + artifacts）、`test-forensics.js` **12** |
| **F5 超时** | 脚本 `await` 超过 taskTimeout | run | 终态 TIMEOUT；不悬挂；TIMEOUT 也产 trace | 永不返回 / 无 trace / 误标 SUCCESS | `test-script-runner.js` **31**、`test-forensics.js` **12**（TIMEOUT 取证） |
| **F6 取消** | 运行中任务；`AbortSignal` 已注入 | `cancel` / `pause({interrupt:true})` / `abortItem(id)` | pre-start 立即取消；中程在 `step()` 边界抛 `CancelledError`，收敛 CANCELLED | 取消后仍跑 / 硬标 PAUSED（谎言） | `test-script-runner.js` **31**、`test-automation-manager.js` **11**、`test-worker.js` **18**、`test-integration.js` **8**（hang 15s 内收敛） |
| **F7 浏览器关闭后状态更新** | 运行中 session，宿主窗口被销毁/崩溃 | 关闭/崩溃 → 观察队列与 session | session 进 closed 终态；`BROWSER_CRASH → relaunch → queue.crash → retry → SUCCESS` | 状态滞留 RUNNING / 无自愈 | `test-core.js` **16**（closed 终态）、`test-browser-session.js` **20**（`recover()`）、`test-worker.js` **18**（relaunch 钩） |
| **F8 profile 绑定** | 两个 profile | 各起 session，检查 partition | 绑定 `persist:auto-{profileId}`；非 persist 拒建；同 id relaunch cookie 存活 | partition 非持久 / 身份串台 | `test-profile-manager.js` **17**、`test-task-queue.js` **22**（`profileKey`）、`probe-automation-smoke.js` **24/24**（relaunch cookie） |
| **F9 多标签** | 单 profile 多 session | 并发开多个 target/session | 各 session 状态机独立、审计可分；CDP attach 隔离 | 会话串扰 / 状态机互染 | `test-core.js` **16**（session 状态机）、`test-browser-session.js` **20**、`test-cdp-ws.js` **20**（sessionId 剥离/回填） |
| **F10 多 profile 并发** | N 个 profile + 队列任务 | 集中入列，worker 消费 | 同 profile 串行（maxActive=1）、异 profile 并行、全局 ≤ cap、零丢失 | 同 profile 并行写 / 超帽 / 丢项 | `test-worker.js` **18**、`test-stress.js` **2**、`probe-real-stress.js` **8/8 ×4** |
| **F11 日志与结果查询** | 跑过若干 execution | `GET /api/executions`、`GET /api/audit[/stats]`、IPC/WS 订阅 | 分页 `{total,rows}` newest-first；审计可过滤；live-log 推送 | 分页字段缺 / 审计丢失 / 推送断 | `test-http-api.js` **27**、`test-audit-log.js` **9**、`test-metrics.js` **9**、`test-ws-api.js` **6**、`test-electron-wire.js` **10**（live-log e2e） |
| **F12 导入导出** | 已存脚本/版本 | export → 改 id → import | 导出含版本；导入生成新 id；往返等价 | 往返不等价 / 覆盖原脚本 | `test-script-store.js` **13**（export/import）、`test-cli.js` **23**、`test-http-api.js` **27**、`test-integration.js` **8** |
| **F13 版本切换回滚** | 多版本脚本 | saveVersion(v2) → 钉 v1 执行 → 回滚 v1 | 版本不可变；执行绑定指定版本；回滚后新执行用 v1 | 版本被覆盖 / 钉选无效 | `test-script-store.js` **13**、`test-automation-manager.js` **11**（版本钉选）、`test-integration.js` **8**（versions→run） |

---

## 3. 稳定性测试用例

| 用例 | 前置条件 | 执行步骤 | 预期结果 | 失败判定 | 覆盖锚点 |
|---|---|---|---|---|---|
| **S1 浏览器进程意外退出** | 运行中任务 | kill renderer → 观察 worker | 心跳超时→标记可疑→接管→`BROWSER_CRASH→relaunch→queue.crash→retry` | 任务永久悬挂 / 无接管 | `test-worker.js` **18**、`test-browser-session.js` **20**、`probe-automation-smoke.js` **24/24** |
| **S2 连接中断** | session 已连 CDP | 断连/导航失效 → 恢复 | `stale-context` 自愈重试；连续 5 次 `RECOVERABLE_SESSION` → worker `abort()` 自停 | 无自愈 / 静默失败 | `test-browser-session.js` **20**、`test-worker.js` **18**；`troubleshooting.md` §5 #25 |
| **S3 页面长时间无响应** | 页面卡死 | run → 等 per-task timeout | 终态 TIMEOUT；trace 产出；worker 不整体卡死 | 全局悬挂 / 无兜底 | `test-script-runner.js` **31**、`test-forensics.js` **12** |
| **S4 脚本死循环** | `while(true)` 脚本 | run | per-task timeout 兜底 kill；vm 内不查 `signal` 的硬 hang 如实标注（ceiling） | 无兜底 / 误标 PAUSED | `test-script-runner.js` **31**；`acceptance.md` §3.2（诚实 ceiling） |
| **S5 日志洪水** | 脚本狂打日志 | run | `MAX_LOGS` 截断；审计 ring 上限；JSONL 落盘不爆 | 内存暴涨 / 无上限 | `test-script-runner.js` **31**（MAX_LOGS）、`test-audit-log.js` **9**（ring 上限） |
| **S6 任务集中启动** | 100+ 项 × 多 profile | 一次性入列 | 零丢失、并发 ≤ cap、心跳存活、`list p99<500ms`（队列级）；真窗档 N=10/20/30/50 零丢失 | 丢项 / 超帽 / 心跳断 | `test-stress.js` **2**、`probe-real-stress.js` **8/8 ×4** |
| **S7 重复提交** | 同任务重复入列 | 重复 enqueue | 幂等键去重（crash recovery 步 3）；不产生重复执行 | 重复执行 / 双写 | `test-task-queue.js` **22**、`test-automation-manager.js` **11**（并发上限 fail-fast） |
| **S8 执行期退出程序** | 服务运行中 | `SIGINT`/`SIGTERM` | 优雅停机：停 worker、关端口、双 stop 安全 | 端口残留 / 进程不退 | `test-serve.js` **9**、`test-worker.js` **18**（shutdown） |
| **S9 磁盘不足** | 只读/满盘目录 | store/audit 落盘 | 坏路径降级不崩；写入失败可观测 | 崩溃 / 静默丢数据 | `test-audit-log.js` **9**（坏路径降级）；store 写失败为**待测项**（见 §4 缺口） |
| **S10 依赖安装失败** | 无第三方运行时依赖 | 启动 | 内置 `node:vm` 可用；Monaco 缺席回退 textarea；Playwright 缺席不影响进程内 SDK | 启动即依赖第三方 | `test-forensics.js`/`test-script-runner.js`；`acceptance.md` §5（Monaco waive）；`testing.md` §3（playwright 未 vendored） |

---

## 4. 性能测试（**只给测量方法，不编造数据**）

> 采集工具统一：`app.getAppMetrics()`（`workingSetSize` / `percentCPUUsage` / `byType`）+ worker 心跳载荷 + launcher 窗口数 + 进程树采样。**禁止**用投影值冒充实测；已采集的基线**引用** `testing.md` §5，不在此新造。

| 指标 | 负载/场景 | 采集方法 | 基线来源 |
|---|---|---|---|
| 冷启动 | 空机首启 Electron 主进程 | 从进程创建到 `app.ready` + 首个窗口 `did-finish-load` 的 wall time（多轮取中位） | **待测** |
| 热启动 | 已加载资源后重开窗口 | 同上，复用已热 code cache | **待测** |
| 单实例开销 | 1 profile / 1 窗口 | `getAppMetrics()` 单窗 workingSet + 进程数（Browser/Tab/GPU） | `probe-real-stress.js` N=10 档：工作集 1.83→2.11→0.36 GB、`Tab`=10（`testing.md` §5） |
| 并发 CPU/内存 | N 真窗（N=10/20/30/50） | 逐档采样峰值 workingSet + `Tab` 进程数 + teardown 归零断言 | `testing.md` §5：2.11 / 3.94 / 5.78 / **9.42 GB**；Tab=10/20/30/50；**100 档未跑**（投影 ≈18–19 GB > 空闲 9.48 GB，`FP_STRESS_N=100` 可切） |
| 日志写入 | MAX_LOGS 满负载 | 单位时间 JSONL 追加吞吐 + 主线程阻塞采样 | **待测** |
| 调度延迟 | cron/interval 触发 | `schedule-fire` 审计时间戳 − 计划槽时间，取 p50/p99 | **待测** |
| 长时内存变化 | 连续 run 数小时 | 周期性 `getAppMetrics()` workingSet 斜率 + GC 后回归线 | **待测** |

**换算基线（引用，非新造）**：`testing.md` §5 由 N=10/20/30/50 反推 ≈165–197 MB/渲染器；100 档投影 ≈18–19 GB。此为**已记录换算**，非本文件新测。

---

## 5. 安全测试用例

| 用例 | 前置条件 | 执行步骤 | 预期结果 | 失败判定 | 覆盖锚点 |
|---|---|---|---|---|---|
| **SEC1 未授权调用浏览器控制接口** | 无/错 token | 调 HTTP/CDP/IPC 控制面 | 401/403/404 三门；CDP 拒绝 `Browser.close`/`Target.createTarget` | 任一未鉴权放行 | `test-http-api.js` **27**、`test-core.js` **16**（allowlist）、`test-ipc-bridge.js` **18** |
| **SEC2 跨 profile 访问** | 两 profile，A 令牌访问 B | 以 A 身份读/写 B 资源 | `assertOwned` 拒；同 profile 串行；审计留痕 | 越权成功 | `test-profile-manager.js` **17**（ACL）、`test-task-queue.js` **22** |
| **SEC3 越权本地文件** | 授权目录外路径 | upload/download 越界路径 | `checkPath` → `PermissionError` retriable=false；null/无围栏一律 deny | 越界读写成功 | `test-browser-api.js` **14**（围栏块，含异步拒绝形） |
| **SEC4 未授权子进程** | capability 未授 trusted | 脚本 `require('child_process')`/`process` | 默认 deny；即使 permission 位 true 也须 `trusted===true` | 未授权起进程 | `test-script-runner.js` **31**；`troubleshooting.md` §3 #16 |
| **SEC5 恶意脚本** | 逃逸尝试（`eval`/`new Function`/prototype 污染） | 提交并执行 | vm 沙箱 deny、codegen 关、T3 清洗；逃逸=同进程 ceiling 已声明 | 逃逸成功 / 未声明边界 | `test-script-runner.js` **31**；`script-sandbox.md` §4 |
| **SEC6 敏感参数泄露** | 含 secret 的脚本 | 跑 + 查日志/审计/导出 | 名+值双 scrub（含 stack）；token/签名不入 audit；门口二次脱敏 | 任一入口可 grep 到 secret | `test-script-runner.js` **31**、`test-audit-log.js` **9**、`test-http-api.js` **27** |
| **SEC7 IPC 权限绕过** | 伪造 sender / webview | 发非白名单通道或伪造 sender | 50 通道白名单 + sender URL/webview 拒；`ipc-deny` 审计；args 不入 audit | 非白名单通道放行 | `test-ipc-bridge.js` **18**；`troubleshooting.md` §3 #14 |
| **SEC8 依赖风险** | 无第三方运行时依赖 | 审计依赖面 | 运行时仅 `node:vm` 内置；Monaco 可选且离线回退；**禁 npx** | 引入未审计第三方 | `acceptance.md` §5；`AGENTS.md` §2 |
| **SEC9 强制终止有效性** | 运行中任务 | `abortItem` / `AbortSignal` / taskTimeout | 中程在 `step()` 边界收敛；硬 hang 由 per-task timeout 兜底 | 取消无效 / 悬挂 | `test-script-runner.js` **31**、`test-worker.js` **18**；`acceptance.md` §3.2 |

---

## 6. 验收标准（对齐 user spec §12 验收条件）

> user spec §12（验收条件）在仓内以 `acceptance.md` 的 **§41 30 条 → 34 行矩阵**落地（✅ 34 / 🔶 0 / ⛔ 0，另 §5 waive 2 项）。下表按 §12 的验收主题归纳，逐项绑**可复核证据**（非意图）。

| 验收主题 | 判定条件 | 证据锚点 | 对应 §41 行 |
|---|---|---|---|
| 脚本资产 | 创建/编辑/版本/参数/执行/停止/暂停恢复 全通 | store 13 / manager 11 / runner 31 / cli 23 / integration 8 | 1–7 |
| 可观测 | 实时日志 + 错误分类 + 截图/取证 + 日志结果查询 | runner 31 / forensics 12 / audit-log 9 / metrics 9 / ws 6 / wire 10 | 8–10 |
| 浏览器控制 | profile 连接 + page ops + cookies/storage/upload/download/network/wait | smoke 24/24 / script-e2e 17/17 / real-site 12/12 / browser-api 14 | 11–18 |
| 调度与并发 | 批量 profile + 并发控制 + 重试 + cron | scheduler 11 / worker 18 / queue 22 / stress 2 / real-stress 8/8×4 | 19–22 |
| 接口面 | HTTP API + CLI 同 Service Layer | serve 9 / http 27 / cli 23 | 23–24 |
| 外部接入 | Playwright/Puppeteer 经 CDP 可接 | cdp-ws-client 11/11 / cdp-server 10/10 / cdp-ws 20 | 25 |
| 安全与沙箱 | 权限控制 + 沙箱 + 审计 + 中央收集器 | runner 31 / jwt-claims 21 / audit-log 9 / ipc-bridge 18 | 26–28 |
| 韧性 | 崩溃记账闭环 + 进程自愈 relaunch | worker 18 / queue 22 / smoke 24/24 | 29–30 |
| 完整性 | 完整测试 + 三层 + 完整文档 + 不变量（指纹/隔离/稳定性） | 475 PASS / integration 8 / stress 2 / docs 21 份 / fingerprint 静态闸 | 31–34 |
| waive（不跟踪） | Monaco bundle 形态、templates/marketplace 专册 | `acceptance.md` §5 | — |

**判定门（全部满足才算通过）**：Unit 33 套 `FAIL=0` 且 exit 全 0；Integration/E2E/Stress 各层基线全绿；`Client/test-packaged-automation.js` 12 检查全过；`fingerprint/scripts/check.py` exit 0；面板三测（panel/bridge/degrade）全绿。**任一红灯即验收不通过**，不得以注释断言/降标准方式放行（`AGENTS.md` §2 铁律）。

---

## 7. 与 `docs/automation` 的关系（delta）

| 类别 | 内容 |
|---|---|
| **NEW（本包新增）** | ① 把分散在 `testing.md` §2–§5 的实跑数字**收敛为分层运行入口表**（§1）；② **功能/稳定性/性能/安全四类用例**的「前置/步骤/预期/失败判定」四段式模板（`docs/automation` 只给 PASS 清单，无失败判定列）；③ 性能测试**只列测量方法、显式拒绝预估值**（`docs/automation` 未单列性能方法论）；④ user spec §12 验收主题 → §41 行号映射表（§6）。 |
| **MODIFIED（口径对齐）** | 运行入口数字以 `testing.md`（2026-09-28）为准：面板 panel **19** / bridge **6** / degrade **5** / packaged **12 检查** / copy-sync **21/21**（`docs/automation` 旧处曾记 14/14、20 等，已按最新收敛）。 |
| **DEPRECATED（不再引用）** | ① `acceptance.md` §2 中「100 档待内存余量」保留为**诚实边界**，不作为待办阻塞；② `testing.md` §2.2 的「面板 20 PASS」旧值以本包 §1 表为准。 |
| **不变（复用）** | 全部 PASS 数、探针计数、stress 资源表**逐字复用** `testing.md`/`acceptance.md`，未新增任何数字。 |
