# Automation Scheduler（调度器）

> 性质：Phase 6 设计+实现文档。上游：`architecture.md` §6（Scheduler→Queue→Worker→Runtime）、`database.md` §9（automation_schedules 表）、`task.md` §4/§5/§7（队列/重试语义与 Schedule 桩）、`worker.md` §3（同 profile 串行）。实现锚点：`automation/runtime/scheduler.js`（已落地，2026-09-24）、`automation/test-scheduler.js` 实跑 11 PASS / exit=0。

---

## 1. 定位

调度是产生 Task 的源头之一：

```
立即执行 = API / IDE 手动触发 ──┐
                               ├──→ Schedule → fan-out TaskItem → Queue → Worker → BrowserSession
定时执行 = Schedule 到期触发 ───┘
```

- Schedule 到期 → 对每个 profileContext 扇出一次入队（fan-out），下游排队、认领、重试全部归 `task.md`，本文**不重复**队列与重试语义（排序/at-least-once/退避 → `task.md` §4、§5；并发兜底 → `worker.md` §4 semaphore）。
- Scheduler 只做三件事：**算何时触发（nextRunAt）→ 到期扇出（onFire）→ 记账（lastFiredAt / audit）**。

---

## 2. Schedule 模型

字段表（对齐 `database.md` §9 automation_schedules + runtime `add()` 规格）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT | ULID 主键（`<prefix>_<ulid>`，database.md §0） |
| `name` | TEXT | 唯一（`WHERE deleted_at IS NULL`） |
| `scriptId` | TEXT | 目标脚本（经 script_version 钉选，见 task.md §1） |
| `version` | INTEGER | 行级乐观锁 + 脚本版本锚定 |
| `params` | object | 触发时冻结进 Task 的参数快照（secret 只存引用，database.md §3） |
| `profileContexts` | TEXT[] | 目标 profile 集合——**即 Profile Pool**（见 §4） |
| `type` | `once \| interval \| cron` | 触发类型，三选一（§3） |
| `atMs` | number? | `type=once` 的触发时刻（epoch ms） |
| `everyMs` | number? | `type=interval` 的间隔（≥1000） |
| `cron` | string? | `type=cron` 的 5 字段表达式（§3.3） |
| `enabled` | boolean | 关闭后不再触发（≠ 删除） |
| `state` | `active \| paused \| done` | 生命周期：`once` 触发完 → `done`；手动暂停 → `paused` |
| `lastFiredAt` | number? | 上次实际触发时刻（epoch ms） |
| `nextRunAt` | number? | 下次应触发时刻（轮询键，见 §7） |
| `maxAttempts` | number | 本次触发生成 Task 的重试上限（透传 `retry_policy_json.max`，task.md §5.2） |
| `priority` | integer | 入队优先级（默认 0，task.md §4 排序键） |

校验（`add()` 入口，失败即拒绝不落库）：

- `type=once` → 必有 `atMs`；`interval` → `everyMs ≥ 1000`；`cron` → `parseCron` 通过。
- `profileContexts` 非空；`maxAttempts ≥ 1`；未知字段拒绝。

---

## 3. 触发类型

### 3.1 once（一次性）

| 语义 | 规则 |
|---|---|
| 触发 | `now >= atMs` 且 `state=active && enabled` → fire 一次 → `state=done`、`nextRunAt=null` |
| 过期行为 | 创建时 `atMs` 已过期 / 暂停期间错过 → 按 §5 resume 规则补发（立即一次），**不按过期次数累乘** |
| 重复触发 | 禁止：`done` 后任何 tick 不再命中 |

### 3.2 interval（固定间隔）

| 语义 | 规则 |
|---|---|
| 下次触发 | `nextRunAt = lastFiredAt + everyMs`（≥1s） |
| catch-up（防雪崩） | 停机/暂停恢复后已错过的槽**丢弃不回填**（`reschedule` 直接跳到下一未来槽）——防止重启后瞬间扇出 N×\|profiles\| 个 Task 压垮 Queue；错过 > 2×`everyMs` 时记 audit `schedule-skip`（`scheduler.js:246-248`，形状 `{ type, id, ctxCount }`，无 `missed/kept` 明细，见 §7.1） |
| 漂移 | 槽对齐锚 `lastFiredAt`，不累计补时（丢槽即重锚） |

### 3.3 cron（5 字段子集）

支持的表达式子集（分 时 日 月 周，空格分隔）：

| 位置 | 字段 | 范围 | 支持语法 |
|---|---|---|---|
| 1 | 分 | 0–59 | `*` `n` `a-b` `*/n` `a,b,c` |
| 2 | 时 | 0–23 | 同上 |
| 3 | 日 | 1–31 | 同上 |
| 4 | 月 | 1–12 | 同上 |
| 5 | 周 | 0–6（0=周日） | 同上 |

- **不支持**：秒字段、`L`/`W`/`#` 扩展——`parseCron` 遇到直接**拒绝**（抛错，不静默降级）。便利宏 `@daily`/`@hourly`/`@weekly` 由 `scheduler.js:6 MACROS` 展开（`@daily`→`0 0 * * *` 等），实现与测试均覆盖（`test-scheduler.js:56-57`）——宏在解析层展开，不进 cron 语义。
- dom/dow 同时给出非 `*` 值时为 **OR 语义**（标准 cron 行为：当天匹配日或匹配周即触发）。
- `nextCronAt`：从 `from` 起**分钟粒度步进**，在 366 天窗内找下一个匹配槽；窗内无匹配 → **抛错**（`cron matches nothing within 366 days`，实现 `scheduler.js:91`；测试 `test-scheduler.js:98`），上层（`reschedule`）调用路径保证 cron 输入合法，不把"无匹配"当 `done` 静默吞掉。
- 重叠（同 cron 连击上一发还没跑完）由下游并发兜（`worker.md` §4 semaphore + 同 profile 串行），Scheduler 不加 overlap 策略开关（database.md §9 的 `overlap` 列 reserved，本阶段不实现）。

---

## 4. 批量 fan-out

```
一个 Schedule × N profileContexts
        │  到期 onFire(schedule, ctx) × N
        ▼
   enqueue × N  →  Queue（task.md §4 排序/认领）
        ▼
   Worker maxConcurrent 兜底并发（worker.md §4 semaphore）
```

- 每次触发对每个 `ctx ∈ profileContexts` 各调一次 `onFire(schedule, ctx)` → 各自 `enqueue` 一个 TaskItem 级任务；**扇出在 Scheduler 层，速率在 Queue/Worker 层**。
- **Profile Pool = `profileContexts` 本身**：集合即池，无独立 Pool 实体。本阶段**无 overlap 策略开关**：触发只管扇出，重叠（上一发还没跑完）由下游 `worker.md` §4 semaphore + 同 profile 串行兜底（§3.3）。
- 扇出幂等：同一次 fire 的 N 个入队共享 `scheduleId + lastFiredAt` 锚点，crash 后重放靠 audit 对账（不重复扇出同一槽；at-least-once 细节归 task.md §4）。

---

## 5. pause / resume / triggerNow / recompute 规则表

| 操作 | once | interval | cron |
|---|---|---|---|
| `pause()` | `state=paused`，停 tick | 同左 | 同左 |
| 暂停期间错过 | — | 丢槽（不补） | 丢槽（不补） |
| `resume()` | 错过且未 `done` → **立即补发一次** → `done` | `nextRunAt = now + everyMs` | `nextRunAt = nextCronAt(now)`（取**未来**槽，不回放历史槽） |
| `triggerNow()` | 不改 `state`，立即 fire（once 仍按 fire → `done` 收尾）；`triggerNow` 自身不记 audit（`scheduler.js:210-218` 注释：skip 是 tick 侧 missed-window 信号），记账靠 `fire()` 的 `schedule-fire` | 立即 fire 并重锚 `lastFiredAt=now` | 立即 fire；`nextRunAt` 按原 cron 节奏重算（不跳槽） |
| `recompute()` | `nextRunAt = atMs` | `nextRunAt = lastFiredAt + everyMs`（无 last → `now + everyMs`） | `nextRunAt = nextCronAt(now)` |
| 触发 `add()`/改参后 | 同 recompute；`enabled=false` 时只算不 fire | 同左 | 同左 |

统一不变式：`state=paused ∨ enabled=false` → tick 跳过；`state=done` → 一切入口（除手动 delete）拒绝。

---

## 6. 依赖（明确不做）

Phase 6 **显式不做**跨 Schedule / 跨 Task 的 DAG 依赖：

- 简单 after-fire 链（A 触发完再触发 B）可在 `onFire` 层用回调组合（B 的 Schedule `type=once, atMs=触发时刻` 或直接在 A 的 fire 回调里手动 `triggerNow(B)`），**不持久化依赖边**。
- 持久化 DAG（depends_on、跨 Task 拓扑）归 database 扩展（新表），本阶段不建。
- ceiling 注释：`// ponytail: no cross-schedule DAG; persist edges in database when orchestration demand is real`

不假装支持：`after: [scheduleId]` 这类字段不进模型。

---

## 7. DB 映射与轮询

### 7.1 automation_schedules ↔ scheduler schedule 对象

> `status` 字段说明：`database.md` §9 的 `status CHECK(enabled/paused)` 是落库形态；内存实现用 `state(active/paused/done)`（once 终态）+ `enabled` 布尔双字段承载。`once → done` 后 `enabled` 保持 true、`nextRunAt=null`，轮询天然不命中。落库时按本表映射，`enabled=false` 与 `paused` 为正交门（tick 要求 `state=active && enabled`，`test-scheduler.js:291-304`）。

| database.md §9 列 | schedule 对象字段 | 说明 |
|---|---|---|
| `id` | `id` | ULID |
| `name` | `name` | 条件唯一 |
| `task_id` | —（本规格用 `scriptId` 直接扇出） | `task_id` 为「模板任务」预留；运行对象按 §2 字段集，实例化后回填 `automation_tasks.schedule_id`（task.md §7） |
| `cron` | `cron` / `everyMs` / `atMs` | 三类型参数化存文本/数字；`type` 显式列，对应实现 `add()` 的 `type/atMs/everyMs/cron` 四字段（建表时 `type CHECK(type IN ('once','interval','cron'))` + `at_ms/every_ms/cron` 三列，`timezone` 列已建但本阶段分钟步进按 UTC 实现，多时区 reserved） |
| `timezone` | （隐含本地/UTC） | 列已建；本阶段分钟步进按单一时区实现，多时区切换 reserved |
| `overlap` | — | `database.md` §9 `overlap` 列（skip/queue/parallel）reserved，本阶段不实现。实现现状：cron/interval 错过槽**丢弃不回填**（`reschedule()` 直接跳到下一未来槽），`schedule-skip` 审计仅 interval 错过 >2×everyMs 时记一行（`scheduler.js:246-248`，无 `missed/kept` 明细）；下游并发由 `worker.md` §4 semaphore + 同 profile 串行兜底（§3.3） |
| `status` | `enabled` + `state` | 表 CHECK 为 `enabled/paused` 小写 2 态；对象 3 态 `active/paused/done` 映射：`active→enabled`、`paused→paused`、`done→enabled 但 next_run_at=null`（轮询天然不命中） |
| `next_run_at` | `nextRunAt` | 轮询键 `ix_sched_poll(status, next_run_at)` |
| `last_run_at` | `lastFiredAt` | ISO8601 ↔ epoch ms 转换在读写边界 |
| `version / created_at / updated_at / deleted_at` | 同名 | database.md §0 全局约定 |

### 7.2 tick() 单进程轮询 vs 未来 DB 时间轮询器

- **现状（本阶段）**：`tick()` 单进程内轮询——同进程定时扫 `enabled ∧ next_run_at <= now`，fire 后回写 `lastFiredAt/nextRunAt`。单写者，无锁。
- **升级路径（Remote Worker / 多进程）**：轮询下沉为 DB 时间轮询器（`SELECT … WHERE status='enabled' AND next_run_at <= ?` + 乐观锁 `version` 抢占，database.md §0），多进程 claim 同一槽靠 `SET version=version+1 WHERE version=?` 互斥——Scheduler 语义不变，只换调度权归属。与 worker.md §1 remote 接口点同批升级。

---

## 8. 测试锚点：`automation/test-scheduler.js`

> 实现 `automation/runtime/scheduler.js` 已落地，实跑 11 PASS / exit=0。PASS/FAIL/SKIP 前缀约定同 `worker.md` §8。

| # | 断言 |
|---|---|
| 1 | `parseCron`：接受 `*/15 * * * *`、`0 9 a-b * *`、`0,30 8-10 * * 1-5`；拒绝秒字段 `* * * * * *`、坏宏、越界值（抛错不静默） |
| 2 | `nextCronAt`：分钟步进命中下一槽；dom/dow 双非 `*` 为 OR；366 天窗无匹配抛错 |
| 3 | once：`atMs` 未到不 fire；到点 fire 一次 → `state=done`、`nextRunAt=null`；再次 tick 不 fire |
| 4 | interval catch-up：伪造停机错过 5 槽 → resume 只补 1 次 + audit `schedule-skip` 恰 1 行（missed 槽丢弃不回填） |
| 5 | cron fan-out：1 Schedule × 3 profileContexts → `onFire` 恰 3 次、enqueue 恰 3 条，`scheduleId` 一致 |
| 6 | pause→resume：once 错过 → resume 立即补发；cron → `nextRunAt` 为未来槽（> now）；interval → `now+everyMs` |
| 7 | `triggerNow`：三类型均立即 fire 一次且不破坏后续节奏（once→done；interval/cron 的 `nextRunAt` 合法） |
| 8 | validation：缺 `atMs`/`everyMs<1000`/空 `profileContexts`/坏 cron → `add()` 拒绝，不落库 |
| 9 | stats：`lastFiredAt/nextRunAt/enabled/state` 在 fire 前后回写正确；`enabled=false` 时 tick 零副作用 |

## 9. 与 UI

- Schedule 列表、启停、手动触发入口归 **automation-panel** 的 Executions/Tasks 视图扩展（P7+），与 `task.md` 的 Task 列表同页签呈现。
- 本阶段（Phase 6）**无 UI**：只提供 runtime API（`add/pause/resume/triggerNow/recompute/tick`），UI 接线点留 Service Layer（`architecture.md` §7）。

---

## 状态

Phase 6 落地，日期 2026-09-24；`automation/runtime/scheduler.js` 已实现（271 行），`test-scheduler.js` 实跑 11 PASS / exit=0（含 cron 解析/nextCronAt/once/interval catch-up/cron 扇出/pause-resume/triggerNow/校验/分页/enabled 门控）。
