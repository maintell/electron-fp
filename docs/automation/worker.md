# Automation Worker（本地执行器）

> 性质：Phase 4 设计文档。上游：`architecture.md` §6（Queue→Worker→Runtime）、`task.md`（队列状态机/重试语义）、`database.md` §10（workers 表）、`runtime.md` §5（崩溃恢复七步语义）+ §6.2（semaphore 占位）、`automation-gap-analysis.md` 附录 B/C。实现锚点：`automation/task-queue.js`（claim/fail/crash/timeout 入口）、`automation/test-worker.js`（§7 断言清单）。

---

## 1. 架构与接口

```
Automation Manager → Task Queue → Worker → BrowserSession
                          ▲           │
                          └── heartbeat┘
```

- **Local Worker 先行**：与 Queue 同进程（main），函数调用直达。
- **接口允许 Remote Worker**：`claim / ack / fail / crash / timeout / heartbeat` 全部经结构化消息（同一批方法签名 + 传输层），remote 只换 transport 不换语义——`database.md` `automation_workers.kind ∈ {local,remote}` + `endpoint` 预留即此。ponytail：remote 传输 Phase 4 不实现，无调用方，留接口点即可。
- Worker 不直调 Manager：认领 Item、驱动 BrowserSession、把结果写回 Queue；状态机合法性由 `task.md` §3 的迁移函数裁决，Worker 只发意图。

---

## 2. 生命周期

```
start() → running ⇄ paused
            │  ↑       │
            │  └───────┤ resume()
            ↓          ↓
    stop()/abort() → stopped
```

| 方法 | 语义 |
|---|---|
| `start()` | 开始 poll 认领；注册 workers 表行（`status='online'`） |
| `stop()` | 停止认领 + 等待在跑任务自然结束（draining，对应表状态 `draining`）；超时兜底转 `abort()` |
| `pause()` | **仅停止认领**，在跑任务不中断（见 §6 ceiling）；表状态切 `draining` |
| `resume()` | 恢复认领，回 `running` |
| `abort()` | 硬停：对在跑任务发 `queue.timeout`/cancel 同路径，状态 `stopped`（`worker.js:75-81`） |

状态集合：`running / paused / stopped`（运行时态，`worker.js:30`）；持久层对应 `online / offline / draining`（`database.md` §10，`offline` 由心跳超时判定，不主动设）。

### heartbeat 载荷

实现现状（`worker.js:9 heartbeatMs=5000` 定时 tick；`status()` 返回运行视图）：心跳语义 = `setInterval` 周期性 `scheduleTick` 驱动轮询 + `worker-exec`/`worker-abort`/`worker-recover` 审计事件；`database.md` §10 的 `last_heartbeat_at` + `ix_workers_hb` 轮询键是落库形态，内存实现无 workers 表行。以下载荷是 DB 落地后的目标形状：

```js
{
  workerId,            // automation_workers.id
  ts,                  // ISO8601，判活基准 → last_heartbeat_at
  status,              // 'running' | 'paused' | 'draining'
  running,             // 当前在跑 item 数
  capacity,            // semaphore 上限（表 capacity 列）
  inflight: [{ itemId, taskId, startedAt, executionId }]  // crash 接管的对账清单
}
```

心跳周期默认 5s（实现 `worker.js:9`）；crash recovery 第 1 步（附录 B）以 `last_heartbeat_at` 超时（默认 30s）标可疑——该判定是 DB 落地形态，内存实现靠 `queue.claim` 异常路径的 `worker-recover` 审计（`worker.js:197-199`）。心跳更新走 `ix_workers_hb` 轮询键（落库后）。

---

## 3. 执行循环

```
loop:
  1. poll      queue.claim()             → item | null（null → 等下一拍，指数空转退避封顶 2s）
  2. gate      semaphore.acquire()           → 满则 item 回队（不占坑空转）
  3. bind      profileId → partition=persist:auto-{profileId}（task.md §6）
               查同 profile 有无 STARTING/RUNNING → 有则 skip 回队（同身份不并行写）
  4. run       BrowserSession + Execution 开跑
               per-task timeout 定时器（Task retry_policy 或默认 60s，`worker.js:10 taskTimeoutMs=60000`）
  5. settle    三通道之一：
               ├─ 正常结束      → queue.complete(item, result)（RUNNING→SUCCESS；失败类走 queue.fail 按 retriable 判定）
               ├─ timeout 触发  → queue.timeout(item) + cancelFn（→TIMEOUT，retriable 走 RETRYING）
               ├─ err 显式抛出  → queue.fail(item, err)      （读 err.retriable 定 RETRYING vs FAILED）
               └─ BROWSER_CRASH → queue.crash(item)          （→CRASHED，见 §5）
  6. release   semaphore.release()（finally，任何 settle 路径都释放）
  7. goto 1
```

- **claim 语义**：at-least-once（`task.md` §4）；claim 即 `QUEUED→STARTING` 合法迁移 + 绑定 `worker_id`，迁移非法（并发双领）→ 抛错拒绝 + 审计行。
- **timeout 路径**：`queue.timeout` 是独立入口（不是 fail 的别名）——终态是 `TIMEOUT` 不是 `FAILED`，`error_code='TIMEOUT'`；cancelFn 走 runner 的 pre-start cancel + best-effort settle（同 `automation-manager.js` cancel 路径）。
- **fail vs crash**：脚本/网络/超时类错误 → `queue.fail`（进程还活着，可按 taxonomy 重试）；renderer/browser 进程死 → `queue.crash`（需 §5 恢复编排，重试前必须先有可用 session）。
- 并发上限 = Worker 级 semaphore（`runtime.md` §6.2 接口点，Phase 4 由 worker 持有 limit = `capacity`）；Task 级 `concurrency` 在 claim 时按 task 维度过滤。

---

## 4. 崩溃恢复（gap 附录 B 七步 → 本层映射）

| # | 附录 B 步骤 | Phase 4 实现归属 | 状态 |
|---|---|---|---|
| 1 | 心跳超时标可疑 | Queue 侧轮询 `ix_workers_hb`，超时 → 标记该 worker 的 STARTING/RUNNING item 待处理 | ✅ 实现到判定 |
| 2 | 接管 RUNNING task + 排他锁 | `queue.crash` 对 inflight item 置 `CRASHED`，锁 = claim 时的 worker 绑定 + 迁移检查（非法迁移拒绝即锁） | ✅ |
| 3 | 按幂等键去重 | `execution.idempotency_key` 唯一索引（database.md §5），重投前查重 | ✅（键生成在 Execution 创建路径） |
| 4 | retriable 回 QUEUED（backoff），非 retriable 置 FAILED | `task.md` §5 分类 + 退避公式；CRASHED 默认 retriable=true | ✅ `queue.crash` + retry |
| 5 | 重放 audit 补 logs 空洞 | 读 `automation_audit_logs(entity='task_item')` 对账 | ⚠️ 设计就绪，对账重放器未建 |
| 6 | session 重连（disconnect-not-close） | **按 partition relaunch 残留进程 → re-attach CDP**（`runtime.md` §5.2 步 2–4：kill residual → relaunch → attachToTarget flatten） | ⛔ P1 Electron glue 接线缺口：Phase 4 实现到 `queue.crash` + 重试为止；relaunch/reattach 依赖 BrowserSession 恢复流真实接线（`test-browser-session.js` 目前 mock 级 `recover()`），本层只保证"重试不会把 item 投给不存在的 session"（claim 时 session 不可用 → 拒绝认领回队） |
| 7 | 告警 + observability 打点 | §6 metrics + audit 事件 | ⚠️ 打点字段就绪，面板/告警通道归 P10 |

**诚实缺口一句话**：Phase 4 交付 = 检测→记账→幂等→重试闭环（步 1–4）；**进程级自愈（步 6 relaunch/reattach）是 Electron glue 接线活，未做**——崩溃恢复目前的净效果是"item 不丢、不双跑，但需要外部有可用 BrowserSession 才能真正重启"。

---

## 5. queue 入口签名（与 task.md 状态机对齐）

```js
queue.claim()                 // QUEUED→STARTING；无货或 profile 冲突 → null
queue.complete(itemId, result) // RUNNING→SUCCESS（成功 settle）
queue.fail(itemId, err)    // 走 taxonomy 判定 SUCCESS 不经此；FAILED 或 RETRYING（err.retriable 覆盖优先）
queue.timeout(itemId)      // →TIMEOUT；retriable→RETRYING
queue.crash(itemId)        // →CRASHED；默认 retriable→RETRYING（backoff）；进程残留交 §4 步 6
queue.retryNow(itemId)     // RETRYING→QUEUED 手动插队（task.md §5.2）
```

全部非法迁移 → 拒绝 + 审计（`action:'state-deny'`，`task-queue.js:52`）。

---

## 6. 暂停语义（已落地，2026-09-26；原 ceiling 作废）

- **`pause()` = 停止认领**（poll 停），不中断 running（legacy 语义，`test-worker.js` 断言）。
- **`pause({interrupt:true})` / `abortItem(id)` = 协作式中程中断**：调 cancelFn → manager abort → runner signal race 抛 `CancelledError` → queue 收敛 CANCELLED（RUNNING→PAUSED→CANCELLED 经 service `pauseTask(id,{interrupt})`，HTTP body 透传）。vm 内不经过 signal 的硬 hang 仍靠 taskTimeout。
- **queue 执行器**：`createTaskExecutor({manager})`（automation-service.js）把 manager 终态译回 queue 语义，供 worker `execute` 直接使用。
- **崩溃自愈钩**：`createWorker({relaunch})`——`BROWSER_CRASH` 时先 `await relaunch({item,error})` 再 `queue.crash`，抛错记 `worker-relaunch-fail` 不挡重试。生产传 `glue.restartSession` 绑定的窗口工厂（探针已证同 partition 重建 + carried cookie）；无 hook 时行为与旧版一致。
- 旧 ceiling（"RUNNING→PAUSED 非法""只有 pre-start cancel"）已过期：迁移表 RUNNING→PAUSED 合法，runner 全程 signal 化。真暂停语义=收敛 CANCELLED，非 vm 冻结。

---

## 7. 可观测

### heartbeat → metrics（对应 gap 附录 C / spec §35 问题清单）

| 问题 | 取数 |
|---|---|
| 3 跳定位 execution → version + params + worker | `script_executions.(script_version_id, task_item_id, worker_id)` + audit `entity` 索引（database.md §12 `ix_audit_entity`） |
| P99 排队/执行时长、重试率 | item `created_at→claim` 差 = 排队时长；execution `started_at→finished_at` = 执行时长；`retry_count>0` 占比 = 重试率——queue settle 时打点 |
| secret 可 grep？ | 日志 message 脱敏（database.md §3 secret_ref）+ FP scrub；应为否 |
| crash 7 步每步有审计行？ | §4 表"状态"列；步 5–6 缺口如实不勾 |
| 100k/1M 列表 <500ms | `ix_exe_status` / `ix_items_task`（database.md 附录） |

### audit 事件 type 列表（本层发出，实测自代码）

```
queue 层：state / state-deny / shutdown（task-queue.js，用 action 字段）
worker 层：worker-abort / worker-exec / worker-recover / worker-relaunch / worker-relaunch-fail（worker.js，用 type 字段）
```

secret 永不入 `detail_json`。P9 落 `automation_audit_logs` 时归一为 `action`（`database.md` §12）。

---

## 8. 测试锚点：`automation/test-worker.js`（规格 9 条；实跑 18 PASS，PASS/FAIL/SKIP 前缀约定）

| # | 断言 |
|---|---|
| 1 | `claim` 先进先出且绑定 worker_id；并发双领第二人被拒（非法迁移拒绝 + 审计行计数 +1） |
| 2 | semaphore 上限：capacity=1 时第二个 item 不开跑；release 后第三拍接续 |
| 3 | 同 profile 串行：同 profileId 的 RUNNING 存在时，该 profile 新 item 被 skip 回队，异 profile 照常 |
| 4 | 正常结束 → `queue.complete` → SUCCESS，`execution_id` 回写 item |
| 5 | retriable err → `queue.fail` → RETRYING → backoff 到期 QUEUED；attempt 计数递增，达 maxAttempts 停 FAILED |
| 6 | non-retriable err（PermissionError）→ 直接 FAILED，不进 RETRYING |
| 7 | per-task timeout → `queue.timeout` → 状态 TIMEOUT + cancelFn 被调 |
| 8 | 心跳：`onHeartbeat` 收到 `{running,claimed,completed,failed,ts}`（`worker.js:89`；测试断言 `claimed≥1 && completed===0 && failed===0`）；心跳超时（默认 30s）标可疑 + `worker.heartbeat_miss` 审计为 DB 落地形态，内存实现未测 |
| 9 | `pause()` 后 claim 返回 null、在跑任务不受影响；`resume()` 恢复认领（ceiling §6 的行为断言） |

---

## 状态

Phase 4 设计+实现，日期 2026-09-24；测试：见 `test-task-queue.js` / `test-worker.js` 实跑输出。
