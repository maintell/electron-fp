# Automation Task（任务与队列）

> 性质：Phase 4 设计文档。上游：`architecture.md` §6（Scheduler→Queue→Worker）、`database.md` §7–§8（tasks/task_items 表）、`automation-gap-analysis.md` §1.8 + 附录 A/B、`script-sandbox.md` 错误类注入（error taxonomy）。实现锚点：`automation/task-queue.js`（状态机 + 队列语义）、`automation/runtime/automation-manager.js`（Phase 4 前的 fail-fast 内联执行，升级路径见 §4）。

---

## 1. 概念表：AutomationTask vs Script vs TaskItem

| 概念 | 定义 | 类比 | 存储 |
|---|---|---|---|
| **Script** | 可复用、可版本化的程序（JS 资产 / RPA→AST），绑定 ScriptVersion 不可变快照 | 函数定义 | `scripts` + `script_versions` |
| **AutomationTask（Task）** | Script × Profile 集合的**一次执行计划**：钉选一个 script_version、一组 profile、并发上限、重试策略、params 快照 | 一次批量调用 | `automation_tasks` |
| **TaskItem** | Task 按 profile 展开后的**单 profile 执行单元**；队列认领（claim）的最小粒度 | 循环体的一次迭代 | `automation_task_items` |

核心不等式（承 database.md）：**Script ≠ Task**。改 Script 不影响已建 Task（Task 钉选 `script_version_id`）；一个 Script 可有无数 Task；一个 Task 有 N 个 Item（N = profile 数）。

---

## 2. 单 / 批量模型

```
                 Script X（version v3 已发布）
                        │  一次 Task 引用
                        ▼
              AutomationTask T（batch）
   concurrency=2, profile_ids=[A,B,C], retry_policy
        │            │             │
        ▼            ▼             ▼
   Item(T,A)     Item(T,B)     Item(T,C)      ← 队列认领单元
        │            │             │
        ▼            ▼             ▼
  Execution_1   Execution_2   Execution_3     ← 每 item 至多 1 活跃 execution
  partition=    partition=    partition=
  persist:auto- persist:auto- persist:auto-
  {A}           {B}           {C}
```

- **单跑**（手动执行一个脚本一个 profile）= N=1 的退化情形：可直接建 Task，或经 automation-manager 内联路径（`task_item_id` 为空，database.md §5）。
- **批量** = fan-out：Task 创建时同步展开全部 Item（`profile_ids_json` 与 items 一一对应，唯一约束 `(task_id, profile_id)`）。
- Item 之间**无数据依赖**（spec 假设：独立 profile 并行）；有依赖的需求用编排在 Script 内表达，不进队列语义。
- **状态口径（本节 canonical）**：内存 `task-queue.js` 用大写 12 态（`TRANSITIONS` §3/实现 `task-queue.js:10-23`）；`database.md` §7–§8 用小写 6 态持久态；`script_executions` 用 `SUCCESS` 大写（`database.md` §5）。**`PAUSED` 语义**：`RUNNING→PAUSED` 合法（实现 `task-queue.js:14` + 测试 `test-task-queue.js:206-211`）；pause 仅置状态，worker 在跑任务是否中断由 `interrupt` 标志决定（`worker.md` §6）。`task.md` §3.1 脚注 ¹ 的"RUNNING→PAUSED 不合法"旧表述已作废。

---

## 3. 状态机（spec §34 全集 + 合法迁移表）

状态全集（12）：

```
CREATED  QUEUED  STARTING  RUNNING  PAUSED  STOPPING  RETRYING
SUCCESS  FAILED  CANCELLED  TIMEOUT  CRASHED
```

分组：

- **非终态**：`CREATED` `QUEUED` `STARTING` `RUNNING` `PAUSED` `STOPPING` `RETRYING`
- **尝试级终态**（本次尝试结束；retriable 且未达 maxAttempts 时可进 `RETRYING`）：`FAILED` `TIMEOUT` `CRASHED`
- **终态**（本次尝试结束；可经 `retryNow` 回 `QUEUED` 重入）：`SUCCESS` `CANCELLED`

### 3.1 合法迁移表

| 从 \ 到 | CREATED | QUEUED | STARTING | RUNNING | PAUSED | STOPPING | RETRYING | SUCCESS | FAILED | CANCELLED | TIMEOUT | CRASHED |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **CREATED** | — | ✓ enqueue | | | | | | | | ✓ cancel | | |
| **QUEUED** | | — | ✓ claim | | | | | | | ✓ cancel | | |
| **STARTING** | | | — | ✓ ready | | ✓ stop | ✓ retry | | ✓ fail | ✓ cancel | ✓ timeout | ✓ crash |
| **RUNNING** | | | | — | ✓ pause | ✓ stop | ✓ retry | ✓ done | ✓ fail | ✓ cancel | ✓ timeout | ✓ crash |
| **PAUSED** | | | | ✓ resume | — | ✓ stop | ✓ retry | ✓ done | ✓ fail | ✓ cancel | ✓ timeout | ✓ crash |
| **STOPPING** | | | | | | — | ✓ retry | ✓ finished-before-kill | ✓ fail | ✓ cancel | ✓ timeout | ✓ crash |
| **RETRYING** | | ✓ backoff elapsed | | | | | — | | | ✓ cancel | | |
| **SUCCESS** | | ✓ retryNow | | | | | | — | | | | |
| **FAILED** | | ✓ retryNow | | | | | | | — | | | |
| **CANCELLED** | | ✓ retryNow | | | | | | | | — | | |
| **TIMEOUT** | | ✓ retryNow | | | | | ✓ retriable | | | | — | |
| **CRASHED** | | ✓ retryNow | | | | | ✓ retriable | | | | | — | |

- ¹ `RUNNING→PAUSED` 合法（实现 `task-queue.js:14` + 测试断言）；pause 仅置状态，是否中断在跑任务由 `worker.md` §6 `interrupt` 标志决定。旧表述"`RUNNING→PAUSED` 不合法 / pause 只作用于 `QUEUED`"已作废。
- ² `RUNNING→CANCELLED` 合法（实现 `task-queue.js:14`）；`STOPPING` 是优雅收尾路径（worker 中止后再 settle），非取消的必经中转。
- `FAILED/TIMEOUT/CRASHED → RETRYING` 的前提是 `err.retriable === true` 且 `retryCount < maxAttempts`；否则停留尝试级终态即整体终态。

### 3.2 非法迁移拒绝 + 审计

- 迁移函数是唯一入口：`canTransition(from,to)` 不通过 → **抛错拒绝，状态不变**。
- 每次拒绝记一行 audit：`{ action:'state-deny', id, from, to, at }`（实现 `task-queue.js:52`；database.md §12 审计表 append-only，落库时归一）。
- 合法迁移同样记审计（`{ action:'state', id, from, to, at }`，实现 `task-queue.js:57`），保证 crash recovery 附录 B 第 5 步可重放补洞。

---

## 4. 队列语义

| 语义 | 规则 |
|---|---|
| **排序** | FIFO：`(priority DESC, created_at ASC, id ASC)`；priority 为 Task 级整数（默认 0），手动触发可插队（priority+10） |
| **认领单位** | TaskItem（单 profile）；claim 置 `STARTING` 并绑定 `worker_id` |
| **投递保证** | **at-least-once**：worker 崩溃后 item 经 crash recovery 回 `QUEUED` 重投；消费者（Execution）靠 `idempotency_key` 去重（database.md §5） |
| **并发上限** | 双层：① Task 级 `concurrency`（同 Task 最多同时运行的 item 数）② Worker 级 semaphore（全局上限，worker.md §4）。**"同一身份不并行写"**：同 `profile_id` 的 item 天然串行（唯一 `(task_id,profile_id)` + partition 隔离，见 §6） |
| **fail-fast 现状** | `automation-manager.js:24`：超过 `maxConcurrent` 直接 throw，**不排队**——这是 Phase 4 前的临时形态 |
| **升级路径** | fail-fast → 持久化队列：throw 改为 `enqueue`（同文件注释已标）。Phase 4 queue 落地后 automation-manager 只做簿记，认领/重试/超时全部移交 `task-queue.js`；持久化（SQLite 表回写）归 **Phase 6**（见 §8） |

---

## 5. 重试（retry taxonomy + backoff）

### 5.1 可重试分类

| 类别 | 错误 | 默认 retriable |
|---|---|---|
| **可重试** | `NetworkError`（网络/断连）、`TimeoutError`（等待/操作超时）、`DownloadError`、`UploadError` | true |
| **永久** | `BrowserError`（窗口/session 故障）、`PermissionError`（RBAC/ACL/围栏）、`ScriptError`（脚本逻辑/参数校验）、`ProfileError`（隔离/get 失败）、`SelectorError`（选择器不匹配） | false |

- **`err.retriable` 显式覆盖优先**：任何错误实例上显式设置的 `retriable` 布尔值 > 类默认值 > 分类表兜底。队列判定只读最终 `err.retriable`（`task-queue.js:60-65 classify`），不自己重推导。注意：`task-queue.js:26 RETRIABLE_NAMES` 另含 `BrowserError=true`（历史宽口，与上表不一致时以运行时实例值为准；分类基线以上表为准）。
- 注意：`script-runner.js` 当前类默认中 `BrowserError`/`DownloadError` 构造为 `retriable=false`（实现比上表保守）——以运行时错误实例上的最终值为准，上表是 Task 层的分类基线；两者冲突时 err.retriable 覆盖，并以 runner 实跑为审计依据。
- non-retriable 直接尝试级终态（`FAILED`），不进 `RETRYING`（gap 附录 A）。

### 5.2 退避公式

```
delay(n) = min(cap, base × mult^(n-1)) × jitter
base = 5s, mult = 3, jitter = uniform(0.8, 1.2)（±20%）, cap = 300s
n = 当前 retryCount（第 1 次重试 n=1 → ~5s；n=2 → ~15s；n=3 → ~45s；n=4 → ~135s；n≥5 → 300s 封顶）
```

- `maxAttempts`：取 Task 的 `retry_policy_json = {max, base_ms, factor, retriable_only}`（database.md §7）；缺省 `max=3, base_ms=5000, factor=3, retriable_only=true`。
- 到期前状态停留 `RETRYING`（timer 到 → `RETRYING → QUEUED`）；`maxAttempts` 用尽 → `FAILED`。
- **手动 `retryNow(id)`**：跳过剩余 backoff 立即 `RETRYING → QUEUED`。attempt 计数：`retryNow(id)` 本身**不增加** `attempts`（实现 `task-queue.js:184-190`）；是否"防无限手动续命"由调用方/网关层策略决定（实现层只记审计，不设限）——设计旧表述"默认计一次新 attempt"已按实现更正。

---

## 6. Profile 并发隔离（spec §18）

| 规则 | 内容 |
|---|---|
| partition = identity | 一个 profile 一个 partition，决定 cookie/storage/UA/TLS/H2 作用域（runtime.md §1.2） |
| 命名 | automation 一律 `persist:auto-{profileId}`；重启可恢复 |
| 跨 profile 访问 | **仅显式** `profiles.get(id)` + 双向 ACL；禁止隐式枚举/遍历敏感字段（`script-sandbox.md` §2 profile=self） |
| 并发写隔离 | 同 profile 的 Item 在队列层不并行（claim 时查该 profile 是否有 RUNNING/STARTING item，有则跳过本 item 保序）；不同 profile 自由并行（上限受 Task concurrency + Worker semaphore 双重约束） |
| 违规处理 | 未授权跨 profile → `ProfileError(retriable=false)` → Item 直接 `FAILED`，不重试 |

---

## 7. Schedule（桩，Phase 6）

概念三件：**立即**（手动触发，priority 插队）、**定时**（one-shot `next_run_at`）、**cron**（重复，时区感知；`database.md` §9 的 `overlap` 列 reserved，本阶段不实现——语义见 `scheduler.md` §3.3/§7.1）。

```
Schedule → (到期实例化) → Task → Queue → Worker → BrowserSession
```

Phase 4 只留入口：`Task.schedule_id` 外键可空；Scheduler 进程、轮询、crash 恢复接线归 Phase 6，详见后续 `scheduler.md`。本文不定义 cron 解析与重叠语义。

---

## 8. 与 database.md 字段映射（tasks / items ↔ 队列条目）

| database.md 列 | 队列条目字段（queue item） | 说明 |
|---|---|---|
| `automation_tasks.id` | `taskId` | 认领回写时定位 |
| `automation_tasks.status` | 经映射的状态（`queued→QUEUED, running→RUNNING, done→SUCCESS, failed→FAILED, cancelled→CANCELLED, paused→PAUSED`） | 表 CHECK 约束为小写 6 态（建表成本）；内存状态机为 §34 全集 12 态——**STARTING/STOPPING/RETRYING/TIMEOUT/CRASHED/CREATED 映射**：`STARTING/STOPPING` 归入 `running`，`RETRYING` 归入 `queued`（backoff 后重投），`TIMEOUT/CRASHED` 归入 `failed`（含 `error_code` 区分），`CREATED` 归入 `queued`。持久层只存 6 态 + `error_code/retry_count` 还原细态 |
| `automation_tasks.concurrency` | `taskConcurrency` | Task 级并发上限 |
| `automation_tasks.retry_policy_json` | `retryPolicy {max, base_ms, factor, retriable_only}` | §5.2 |
| `automation_tasks.profile_ids_json` | 展开源 | 与 items 一致性校验 |
| `automation_tasks.schedule_id` | `scheduleId?` | §7 桩 |
| `automation_task_items.id` | `itemId`（claim 主键） | 单 profile 认领单元 |
| `automation_task_items.profile_id` | `profileId` | 隔离 + partition 派生 |
| `automation_task_items.params_override_json` | `paramsOverride` | 与 Task 级 params 快照合并后冻结进 execution |
| `automation_task_items.execution_id` | `executionId?` | 当前/最后一次执行快捷定位 |
| `automation_task_items.status` | 同任务 6 态映射 | item 状态独立于 task 汇总态 |
| `automation_workers.id` | `workerId` | claim 绑定；心跳见 worker.md |
| `script_executions.idempotency_key` | 去重键 | at-least-once 的 exactly-once 落点 |

---

## 状态

Phase 4 设计+实现，日期 2026-09-24；测试：见 `test-task-queue.js` / `test-worker.js` 实跑输出。
