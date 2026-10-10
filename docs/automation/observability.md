# Automation 可观测性（三级日志 + Metrics + Timeline）

> 性质：现状 + 规格对齐文档。上游：user spec §26（三级日志）/ §35（问题→查询）、`automation-gap-analysis.md` 附录 C（observability 必答题）、`database.md` §6/§12（logs/audit 表）、`worker.md` §7（心跳→metrics）。实现锚点：`automation/runtime/metrics.js`（createMetrics）、`automation/test-metrics.js`（9 断言实跑）。
> 诚实声明：当前为 mock/内存级实现——无真实 CDP 截图、无 Playwright Trace、metrics 不落库。各节如实标注 ceiling 与升级路径。

---

## 1. 三类日志（spec §26）

| 级别 | 内容 | 当前实现 | 持久化目标（database.md） |
|---|---|---|---|
| **Execution Log** | 脚本逐步日志，per-execution | `script-runner.js` `record.logs`，`MAX_LOGS = 1000`（超限静默丢弃新行）；字段 `{ ts, level, args }` | `script_execution_logs` 表（§6），worker 每 200 条/1s flush；`(execution_id, seq)` 分页 |
| **System Log** | worker 启动/崩溃/CDP 事件等运行时事件 | 中央收集器 `audit-log.js` 同流承载：`worker-abort` / `worker-recover` / `worker-exec`（`worker.js`）、`cdp-deny` / `cdp-call`（`browser-session.js`）、`api-error`（`http-api.js`）；`GET /api/audit` + `automation:audit:query` 可查 | 落 `automation_audit_logs`（§12，SQLite P9）；独立 system 表未建（audit 已覆盖，真需要分离时再拆） |
| **Audit Log** | who / what / when，append-only | 各 runtime 模块直调注入的 `audit` 回调；无中央表，测试注入数组断言 | `automation_audit_logs`（actor/action/entity/entity_id/detail_json/created_at，`ix_audit_entity` 3 跳串联） |

### 1.1 Audit 事件类型全集（实测自代码，非设计稿）

| 来源 | 类型 | 载荷要点 |
|---|---|---|
| `http-api.js:281` | `api` | `{ method, path, status }`——**永不记** token / Authorization / body |
| `http-api.js:268` | `api-error` | 同上 + status=500 |
| `http-api.js:233` | `rate-limit` | 超限请求 status=429 |
| `http-api.js` | `auth-jwt` | JWT 校验结果 `{ sub?, ok, reason? }`（reason 短枚举：malformed/bad-header/bad-payload/bad-alg/bad-typ/bad-signature/expired/not-yet-valid/no-sub/forbidden:<Perm>；永不记 token/签名） |
| `cdp-ws.js` | `cdp-ws-open` / `cdp-ws-close` | CDP-over-WS 连接建立/关闭 `{ profileId }` |
| `cdp-ws.js` | `cdp-ws-deny` | CDP 桥拒绝 `{ reason }`（token/Host/未知 profile/非白名单方法 -32601） |
| `electron/recorder.js` | `recorder-start` / `recorder-stop` | 实时录制会话开始/结束（注入/冲刷+卸载） |
| `electron/recorder-controller.js` | `recorder-session-start` / `recorder-session-stop` | 控制面会话 `{ sessionId, profileId, url }` / `{ sessionId }`（多会话 Map，审计同源） |
| `script-runner.js` | `script-exec` | `{ status: SUCCESS/FAILED/CANCELLED, … }` |
| `automation-manager.js` | `execution` | `{ scriptId, profileId, status }` 终态一行 |
| `scheduler.js` | `schedule-fire` | `{ id, ctxCount }`（`fire()` 发；`triggerNow` 同样经 `fire()` 记账，不另记 `schedule.trigger_now`） |
| `scheduler.js` | `schedule-skip` | 仅 interval 错过 >2×everyMs 时记一行（无 `missed/kept` 明细；cron/once 错过不记——`scheduler.md` §5 resume 直接重算未来槽） |
| `task-queue.js` | `state-deny`（action） | 非法迁移 `{ id, from, to }` |
| `task-queue.js` | `state`（action） | 每次合法迁移 `{ id, from, to }` |
| `task-queue.js` | `shutdown`（action） | 队列关停 |
| `browser-session.js` | `cdp-deny` | `{ method, reason? }`——含 `fp carrier scrub` |
| `browser-session.js` | `cdp-call` | 放行的 CDP 方法（防"全拒"假通过的对侧证据） |
| `worker.js` | `worker-abort` | 硬停 |
| `worker.js` | `worker-recover` | 执行异常恢复 `{ id?, error }` |
| `worker.js` | `worker-exec` | `{ id, status } |

- 注意字段名不统一：queue 用 `action`（`state`/`state-deny`/`shutdown`），其余用 `type`——现状如实记录，P9 落 audit 表时归一为 `automation_audit_logs.action`（`database.md` §12）。
- `worker.md` §7 已同步为实际事件名；实现期实际发的是 `worker.js doAudit({type})`（`worker-abort/worker-exec/worker-recover/worker-relaunch[-fail]`）+ queue 的 `state/state-deny`。以本表为准。
- secret 永不入 `detail_json`/日志（`database.md` §3 `secret_ref` + runner 脱敏；observability 必答题第 3 题）。

### 1.2 三题硬验收（gap 附录 C）

| 必答题 | 现状答案 | 证据 |
|---|---|---|
| execution 3 跳定位 version + params + worker？ | ⚠️ 部分：内存 record 有 `scriptId/scriptVersion/profileId`（`automation-manager.js:31-46`）；`params_snapshot`/`worker_id` 归 DB 落地（`database.md` §5 列已设计） | mock 级 |
| secret 任一级日志可 grep？ | 应为否——runner 注入 deny-proxy、audit 只记 method/path/status；全链路归 P9 | `test-http-api.js` 断言 TOKEN 不入 audit sink |
| crash 7 步每步有审计行？ | ⚠️ 步 1–4 有（`state`/`worker-*`）；步 5 对账重放器未建、步 6 Electron glue 缺口——见 `worker.md` §4 | 如实不勾 |

---

## 2. §35 问题 → 查询映射（createMetrics API）

实现：`automation/runtime/metrics.js`，`createMetrics({ capacity = 10000, now })` 返回下表 API。写入：`record(exec)`（补 `startedAt`/`site`，ring 满丢最旧）。
**通链（2026-09-26）**：`createAutomationManager({ metrics })` 每条终态执行喂一条 record；`serve.js` 默认建 metrics 并贯通；查询出口 = `GET /api/metrics`（viewer 可读、支持 `?scriptId=`）、CLI `metrics [--json]`、IPC `automation:metrics`。`filtered()` 统一承载 `sinceMs/untilMs/scriptId`（曾漏 scriptId，Wave15-A 修复）。

| 问题（spec §35） | API | 语义要点 |
|---|---|---|
| 哪个脚本失败最多 | `topFailures('script', limit?)` | 按 `scriptId` 分组，`failures` 降序；返回 `{ key, failures, total, rate }` |
| 哪个 profile 失败最多 | `topFailures('profile')` | 按 `profileId` 分组，同上 |
| 哪个站点失败最多 | `topFailures('site')` | `currentUrl` 取 hostname，无 URL → `unknown` 桶 |
| avg / P95 时长 | `durationStats({ scriptId?, sinceMs?, untilMs? })` | **仅 SUCCESS** 计入；`{ count, avgMs, p50Ms, p95Ms, maxMs }`，nearest-rank 分位；空集全 0 |
| 失败率 | `failureRate({ scriptId?, sinceMs?, untilMs? })` | 仅终态计入（`metrics.js TERMINAL` = SUCCESS/FAILED/TIMEOUT/CANCELLED/CRASHED）；`{ failures, total, rate }` |
| crash 率 | `crashRate(opts)` | `CRASHED / 终态`（终态分母；RUNNING/QUEUED 不计入——原 ceiling 已关闭，`metrics.js` + `test-metrics.js` 同步） |
| 热点失败步骤 | `hotSteps(limit?, opts)` | 仅 FAILED/TIMEOUT 且 `currentStep` 非空；`[{ step, count }]` 降序 |
| 24h 量 | `volume({ bucketsMs=1h, lastMs=24h })` | 对齐小时桶 `{ ts, started, succeeded, failed }`；**只出非空桶**（零填充网格等图表需要时再加） |
| 总览 | `summary(opts)` | `{ total, byStatus, running, window }` |
| — | `reset()` | 清 ring |

终态集合（`metrics.js` `TERMINAL`）：`SUCCESS FAILED TIMEOUT CANCELLED CRASHED`（`SUCCESS` canonical）；失败集合 `FAILED_SET`：`FAILED TIMEOUT CRASHED`。

### 2.1 存储 ceiling（诚实）

- **当前**：内存 ring，`capacity = 10000` 条，进程重启即空。
- **升级路径**：SQLite 落地后（`database.md`）改为 SQL 滚动聚合——`ix_exe_status`/`created_at` 索引上做 group-by；100k executions 预案见 §0/§4；**日志独立表 + 分页**（1M logs 按月分库预案在 §6），metrics 不进 logs 表。
- ponytail：ring O(n) 扫描在 10k 条件下足够；超容量或需要跨重启历史时再换 SQL rollup。

### 2.2 测试锚点：`automation/test-metrics.js`（2026-09-24 实跑 9 PASS / 0 FAIL，exit=0，Idle）

| # | 断言 |
|---|---|
| 1 | `summary` byStatus + running 计数；window 过滤剔除窗外记录 |
| 2 | `failureRate` 2 FAILED + 1 TIMEOUT / 5 终态 = 0.6；`scriptId` 过滤；非终态剔除 |
| 3 | `topFailures` script 排序 + rate；profile；site 取 hostname、无 URL → `unknown` |
| 4 | `durationStats` 仅 SUCCESS，avg/p50/p95/max 精确值；空集零对象 |
| 5 | `crashRate` 1/10 = 0.1；空集 = 0 |
| 6 | `hotSteps` login 3 次居首、checkout 1；SUCCESS 步不计 |
| 7 | `volume` 两个时刻 → 2 个对齐小时桶，started/failed 计数正确 |
| 8 | ring `capacity=3` 推 5 条 → total=3，最旧丢弃 |
| 9 | `reset` 清空 |

---

## 3. Screenshot / Trace 现状（2026-09-26 修订）

| 项 | 现状 | 剩余 |
|---|---|---|
| 真实 CDP 截图 | ✅ 已落地：`electron/glue.js` / `page.js` 经 `Page.captureScreenshot`（探针真机 2310 / 9929 bytes）；runner 失败时抓 `record.artifacts[]`（`kind:'screenshot'`，抛错记 error-artifact、不拖记录） | 落盘 `screenshot_path` 列待 SQLite 化 |
| 失败取证（§16） | ✅ 已落地：`record.trace` = DOM/HTML（≤262144 B 硬截断）+ 网络尾部 50 + URL + `sources{}` 标志；**生产 facade 路径已证**（`page.js` 导出 `evaluate`/`getCurrentUrl`、`browser-api.js` 条件透传、`network.enable` 已接）；`test-forensics` 12 PASS、`probe-script-e2e` **17/17** | 落盘 `trace_path` 列待 SQLite 化 |
| Playwright Trace（zip 形态） | ⛔ 无：不 vendored `playwright`，未接 CDP `Tracing` 域 | 需要时接 trace events 或 `Tracing`（不在白名单，启用需过 §3 CDP 门控） |
| Timeline（UI） | ✅ 面板执行详情由日志派生（ts + level + text，最近 40 行） | — |

失败现场现在可见：错误栈 + 日志 + 步骤/URL + **截图 + DOM/HTML + 网络**；"失败无现场可查"的旧表述已不成立。

---

## 4. Timeline 概念

- **已存字段**（`automation-manager.js:31-46` record）：`createdAt / startTime / endTime / durationMs / status / error / currentStep / currentUrl`。
- 时间轴 = 同一 execution 上 `startTime → endTime` 区间 + `currentStep` 标注失败点；跨执行的排队时长 = item `created_at → claim`（`worker.md` §7）。
- **UI 时间轴归 P10** `automation-panel` Executions 扩展：`panel.js` 已消费 `startTime/endTime/duration/currentStep/currentUrl` 的 mock 形状（`panel.js:735-737`），接真数据只换数据源不换渲染契约。
- ceiling：`durationMs` 在 finish 时一次性算出（`automation-manager.js:58-60`），running 中为 null——实时进度条需要另接 tick，YAGNI 未做。

---

## 5. Metrics 存储与升级

```
现在（P0–P8）                    目标（P9+ SQLite）
─────────────────                ──────────────────
createMetrics ring               SQL 滚动聚合
capacity=10000 条                ix_exe_status + created_at
进程内存，重启清零                script_executions 行级 + 定期 rollup 表
O(n) 线性扫描                     group-by 走索引（<500ms 门槛，database.md §0）
```

- 与 `database.md` 规模预案对齐：100k executions / 1M logs；**日志分表**（§6 已定 `(execution_id, seq)` 索引 + 90 天归档 + 按月 ATTACH 分库），metrics 聚合只读 executions，不扫 logs。
- 升级触发条件（ponytail ceiling）：跨重启历史需求出现，或 ring 内查询 >50ms——满足其一再换，不预建 rollup 表。

---

## 6. 状态

2026-09-26。metrics 引擎（9 PASS）+ **§35 通链**（manager 终态喂养 → service 组 → `GET /api/metrics` / CLI `metrics` / IPC；`serve.js` 默认启用）；截图与失败取证已落地（§3，含生产 facade 路径实证）。剩余：SQLite 落盘列（`screenshot_path`/`trace_path`）、Playwright Trace zip、聚合仪表盘 UI（面板已有 Executions/Tasks/Schedules 视图，图表未做）。
