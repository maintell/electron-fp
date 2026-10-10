# Automation 数据库设计（SQLite 先行）

> 输入：`docs/automation/automation-gap-analysis.md` §DB（B4：SQLite 先行、按 100k executions / 1M logs 预留索引）；
> 现状锚点：`Client/main.js:26-38` flat `profiles.json`（无 DB，读写全量覆盖）；
> `MClient/agent/engine.js:78-111` jsonl 日志（`runs/<runId>.jsonl` append、无分级、无 execution 关联）。
> 核心不等式：**Script ≠ Task**——Script 是可复用可版本化程序，Task 是 Script × Profile 集合的执行计划；
> Execution 挂 BrowserSession + ProfileContext + 三级日志。

## 0. 选型与全局约定

- **SQLite 先行**：单文件 `automation.db`，WAL 模式（`PRAGMA journal_mode=WAL; synchronous=NORMAL; foreign_keys=ON`），local-first；remote worker 只留接口，不换库。
- 全表统一列：`id TEXT PK`（`<prefix>_<ulid>`，如 `scr_`/`ver_`/`exe_`/`tsk_`）、`created_at TEXT`（ISO8601 UTC）、`updated_at TEXT`。
- 软删除：`deleted_at TEXT NULL`（NULL=有效）；唯一约束一律为**条件唯一**（`WHERE deleted_at IS NULL` 的 partial unique index），避免软删除行占位。
- 乐观锁：`version INTEGER NOT NULL DEFAULT 1`（更新时 `SET version=version+1 WHERE version=?`）。
- 状态列：`status TEXT NOT NULL`，取值见各表；一律加 `CHECK(status IN (...))`。
- 外键一律 `ON DELETE RESTRICT`（日志/审计永不级联删）；子表查询键一律建索引。
- 时间/枚举存 TEXT，金额/计数存 INTEGER，JSON 存 TEXT（JSON1），secret **只存密文引用**（见 §3）。
- 规模预案：100k executions / 1M logs 下列表页 <500ms，靠 §4 索引 + 归档；logs 独立表 + `execution_id` 索引（见 §4）。

## 1. scripts（脚本本体，可复用程序）

Script = 代码资产（JS + RPA→AST 同一运行时），与 Task（执行计划）严格区分。

| 约束 | 定义 |
|---|---|
| PK | `id` |
| Unique | `name WHERE deleted_at IS NULL` |
| Index | `status`, `updated_at` |
| FK | 无（被 versions/params/templates/executions/tasks 引用） |
| SoftDelete | `deleted_at` |
| Version | `version`（行级乐观锁；语义版本另见 script_versions） |
| Status | `draft / published / archived` |
| CreatedAt/UpdatedAt | 有 |

关键列：`name TEXT`、`description TEXT`、`runtime TEXT CHECK(runtime IN ('js','rpa_ast'))`、`entry TEXT`（入口函数/节点）、`marketplace_name/icon/author TEXT`（reserved，占位不实现市场逻辑）。

```sql
CREATE TABLE scripts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  runtime TEXT NOT NULL DEFAULT 'js' CHECK(runtime IN ('js','rpa_ast')),
  entry TEXT NOT NULL DEFAULT 'main',
  marketplace_name TEXT, marketplace_icon TEXT, marketplace_author TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE UNIQUE INDEX ux_scripts_name ON scripts(name) WHERE deleted_at IS NULL;
CREATE INDEX ix_scripts_status ON scripts(status);
```

## 2. script_versions（不可变版本快照）

执行必须绑定 version；回滚 = 新建指向旧快照的版本行，不改历史行。

| 约束 | 定义 |
|---|---|
| PK | `id` |
| Unique | `(script_id, version_no) WHERE deleted_at IS NULL` |
| Index | `(script_id, created_at)` |
| FK | `script_id → scripts(id)` |
| SoftDelete | `deleted_at`（一般不删，只归档） |
| Version | `version`（行锁）+ `version_no INTEGER`（语义序号 v1/v2…） |
| Status | `draft / published / deprecated` |
| CreatedAt/UpdatedAt | 有 |

关键列：`code TEXT NOT NULL`（不可变快照）、`code_sha256 TEXT NOT NULL`、`ast_json TEXT`（RPA→AST 产物）、`dts_hash TEXT`（`automation.d.ts` 版本锚定）。

```sql
CREATE TABLE script_versions (
  id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL, code TEXT NOT NULL, code_sha256 TEXT NOT NULL,
  ast_json TEXT, dts_hash TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','deprecated')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE UNIQUE INDEX ux_sver_no ON script_versions(script_id, version_no) WHERE deleted_at IS NULL;
CREATE INDEX ix_sver_script ON script_versions(script_id, created_at);
```

## 3. script_parameters（typed params，secret 遮蔽）

| 约束 | 定义 |
|---|---|
| PK | `id` |
| Unique | `(script_version_id, name) WHERE deleted_at IS NULL` |
| Index | `(script_version_id)` |
| FK | `script_version_id → script_versions(id)` |
| SoftDelete | `deleted_at` |
| Version | `version` |
| Status | 无（跟随版本；用 `required INTEGER 0/1` 代替） |
| CreatedAt/UpdatedAt | 有 |

关键列：`name TEXT`、`ptype TEXT CHECK(ptype IN ('string','number','boolean','select','multi-select','secret','file','textarea','JSON'))`（9 种，与 `script-store.js PARAM_TYPES` / `automation.d.ts ParamType` 对齐，`JSON` 大写为 canonical；`select / multi-select` 才允许 `options_json`）、`default_json TEXT`、`options_json TEXT`（select 候选）、`secret_ref TEXT NULL`（secret 只存 vault 引用，**永不存明文**；日志脱敏 `***`，observability 必答题第 3 题验收）。

```sql
CREATE TABLE script_parameters (
  id TEXT PRIMARY KEY, script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE RESTRICT,
  name TEXT NOT NULL, ptype TEXT NOT NULL CHECK(ptype IN ('string','number','boolean','select','multi-select','secret','file','textarea','JSON')),
  required INTEGER NOT NULL DEFAULT 0, default_json TEXT, options_json TEXT, secret_ref TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE UNIQUE INDEX ux_sparam ON script_parameters(script_version_id, name) WHERE deleted_at IS NULL;
```

## 4. script_templates（含 marketplace metadata reserved）

模板 = 预填参数的一键克隆源；市场字段先占位、不建逻辑。

| 约束 | 定义 |
|---|---|
| PK | `id` |
| Unique | `name WHERE deleted_at IS NULL` |
| Index | `script_id` |
| FK | `script_id → scripts(id)`，`script_version_id → script_versions(id)`（可空，空=跟随最新 published） |
| SoftDelete | `deleted_at` |
| Version | `version` |
| Status | `active / archived` |
| CreatedAt/UpdatedAt | 有 |

关键列：`params_preset_json TEXT`（参数预填）、`doc_md TEXT`、`marketplace_*` 四列 reserved。

```sql
CREATE TABLE script_templates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE RESTRICT,
  script_version_id TEXT REFERENCES script_versions(id) ON DELETE RESTRICT,
  params_preset_json TEXT NOT NULL DEFAULT '{}', doc_md TEXT DEFAULT '',
  marketplace_name TEXT, marketplace_icon TEXT, marketplace_version TEXT, marketplace_author TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE UNIQUE INDEX ux_tmpl_name ON script_templates(name) WHERE deleted_at IS NULL;
```

## 5. script_executions（执行，一次运行实例）

Execution → BrowserSession + ProfileContext + logs：`session_id`（持久 session，disconnect-not-close）、`profile_id`（显式 `profiles.get(id)` 语义）、`params_snapshot_json`（执行时参数冻结，observability 3 跳定位之二）。

> 分层说明：本表是 **Execution 层 7 态**（`SUCCESS` canonical）；队列层 12 态见 `task.md` §3，Task/Item 汇总层小写 6 态见 §7–§8，映射见 `task.md` §8。

| 约束 | 定义 |
|---|---|
| PK | `id` |
| Unique | `idempotency_key WHERE deleted_at IS NULL`（crash recovery 去重用） |
| Index | `(status)`、`(task_item_id)`、`(script_version_id)`、`(created_at)`、`(worker_id, status)` |
| FK | `script_version_id → script_versions(id)`，`task_item_id → automation_task_items(id)`（可空，手动单跑时为空），`worker_id → automation_workers(id)` |
| SoftDelete | `deleted_at`（通常保留，靠归档而非删除） |
| Version | `version` |
| Status | `CREATED / QUEUED / RUNNING / SUCCESS / FAILED / CANCELLED / RETRYING`（附录 A 状态机；仅 retriable 进 RETRYING；`SUCCESS` 为 canonical——实现 `script-runner.js` / `task-queue.js` / `metrics.js TERMINAL` / `automation.d.ts ExecutionStatus` 全用 `SUCCESS`） |
| CreatedAt/UpdatedAt | 有 + `started_at / finished_at / retry_count / error_code / retriable` |

```sql
CREATE TABLE script_executions (
  id TEXT PRIMARY KEY, script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE RESTRICT,
  task_item_id TEXT REFERENCES automation_task_items(id) ON DELETE RESTRICT,
  worker_id TEXT REFERENCES automation_workers(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL, profile_id TEXT NOT NULL,
  params_snapshot_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT, retriable INTEGER NOT NULL DEFAULT 0,
  screenshot_path TEXT, trace_path TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK(status IN ('CREATED','QUEUED','RUNNING','SUCCESS','FAILED','CANCELLED','RETRYING')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, deleted_at TEXT
);
CREATE UNIQUE INDEX ux_exe_idem ON script_executions(idempotency_key) WHERE deleted_at IS NULL AND idempotency_key IS NOT NULL;
CREATE INDEX ix_exe_status ON script_executions(status, created_at);
CREATE INDEX ix_exe_worker ON script_executions(worker_id, status);
```

## 6. script_execution_logs（三级日志之执行级，独立表）

jsonl（`MClient/agent/engine.js:107-109`）降为 worker 本地缓冲格式，flush 入此表；系统/审计另见 variables（系统配置）与 audit 表。

| 约束 | 定义 |
|---|---|
| PK | `id`（`log_` 前缀；写多读多，ULID 保证 `created_at` 粗有序） |
| Unique | 无（只追加） |
| Index | `(execution_id, seq)`（核心关联索引）、`(level, created_at)` |
| FK | `execution_id → script_executions(id)` |
| SoftDelete | 无（靠 retention 归档删除，见下） |
| Version | 无（不可变，只 INSERT） |
| Status | 无；用 `level TEXT CHECK(level IN ('debug','info','warn','error'))` |
| CreatedAt/UpdatedAt | `created_at` 有，`updated_at` 无（不可变行不需要） |

关键列：`seq INTEGER`（per-execution 自增，补空洞检测用）、`message TEXT`（secret 已脱敏）、`meta_json TEXT`。
**100k / 1M 性能注记**：写走 WAL + 批量 INSERT（worker 每 200 条或 1s flush）；读走 `(execution_id, seq)` 覆盖分页（`LIMIT 200`）；retention：`finished_at > 90 天` 的 SUCCESS/CANCELLED 日志归档为 parquet/gz 后按 `created_at` 按月分批删（`DELETE … LIMIT 5000` 循环，避免长锁）；1M 行以上考虑按 `created_at` 月份做 ATTACH 分库（`logs_YYYYMM.db`），查询层按月份路由。

```sql
CREATE TABLE script_execution_logs (
  id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES script_executions(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL, level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('debug','info','warn','error')),
  message TEXT NOT NULL, meta_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX ix_logs_exe ON script_execution_logs(execution_id, seq);
CREATE INDEX ix_logs_level ON script_execution_logs(level, created_at);
```

## 7. automation_tasks（Task = Script × Profile 集合的执行计划）

| 约束 | 定义 |
|---|---|
| PK | `id` |
| Unique | `name WHERE deleted_at IS NULL` |
| Index | `(status)`、`(schedule_id)` |
| FK | `script_version_id → script_versions(id)`，`schedule_id → automation_schedules(id)`（可空） |
| SoftDelete | `deleted_at` |
| Version | `version` |
| Status | `queued / running / done / failed / cancelled / paused`（queue states，§13–§15） |
| CreatedAt/UpdatedAt | 有 |

关键列：`concurrency INTEGER`（批量并发上限）、`profile_ids_json TEXT`（目标 profile 集合，与 items 展开一致）、`retry_policy_json TEXT`（backoff：`{max, base_ms, factor, retriable_only}`）。

```sql
CREATE TABLE automation_tasks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE RESTRICT,
  schedule_id TEXT REFERENCES automation_schedules(id) ON DELETE RESTRICT,
  concurrency INTEGER NOT NULL DEFAULT 1, profile_ids_json TEXT NOT NULL DEFAULT '[]',
  retry_policy_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed','cancelled','paused')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE UNIQUE INDEX ux_tasks_name ON automation_tasks(name) WHERE deleted_at IS NULL;
CREATE INDEX ix_tasks_status ON automation_tasks(status, created_at);
```

## 8. automation_task_items（Task 展开后的单 profile 子项）

| 约束 | 定义 |
|---|---|
| PK | `id` |
| Unique | `(task_id, profile_id) WHERE deleted_at IS NULL` |
| Index | `(task_id, status)`、`(profile_id)` |
| FK | `task_id → automation_tasks(id)` |
| SoftDelete | `deleted_at` |
| Version | `version` |
| Status | 同 tasks（`queued / running / done / failed / cancelled / paused`） |
| CreatedAt/UpdatedAt | 有 |

关键列：`profile_id TEXT`（显式 profile 引用）、`params_override_json TEXT`（相对 task 的单项覆盖）、`execution_id TEXT`（当前/最后一次 execution，快捷定位）。

```sql
CREATE TABLE automation_task_items (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES automation_tasks(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL, params_override_json TEXT NOT NULL DEFAULT '{}', execution_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed','cancelled','paused')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE UNIQUE INDEX ux_items_tp ON automation_task_items(task_id, profile_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_items_task ON automation_task_items(task_id, status);
```

## 9. automation_schedules（cron 调度）

| 约束 | 定义 |
|---|---|
| PK | `id` |
| Unique | `name WHERE deleted_at IS NULL` |
| Index | `(status, next_run_at)`（调度轮询键） |
| FK | `task_id → automation_tasks(id)`（模板任务，可空=只定义计划未实例化） |
| SoftDelete | `deleted_at` |
| Version | `version` |
| Status | `enabled / paused`（暂停≠删除；手动触发不改 status） |
| CreatedAt/UpdatedAt | 有 + `type TEXT CHECK(type IN ('once','interval','cron'))`、`at_ms INTEGER`、`every_ms INTEGER`、`cron TEXT`、`timezone TEXT`（时区感知；本阶段分钟步进按 UTC 实现，多时区 reserved）、`overlap TEXT CHECK(overlap IN ('skip','queue','parallel'))`（reserved，本阶段不实现；错过槽丢弃不回填，见 `scheduler.md` §3.3/§7.1）、`next_run_at / last_run_at TEXT` |

```sql
CREATE TABLE automation_schedules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, task_id TEXT REFERENCES automation_tasks(id) ON DELETE RESTRICT,
  type TEXT NOT NULL DEFAULT 'cron' CHECK(type IN ('once','interval','cron')),
  at_ms INTEGER, every_ms INTEGER,
  cron TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'UTC', overlap TEXT NOT NULL DEFAULT 'skip' CHECK(overlap IN ('skip','queue','parallel')),
  status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','paused')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, next_run_at TEXT, last_run_at TEXT, deleted_at TEXT
);
CREATE UNIQUE INDEX ux_sched_name ON automation_schedules(name) WHERE deleted_at IS NULL;
CREATE INDEX ix_sched_poll ON automation_schedules(status, next_run_at);
```

> `status` 落库说明：内存实现用 `state(active/paused/done，once 终态)` + `enabled` 布尔双字段；`done→enabled 但 next_run_at=null`（轮询天然不命中），见 `scheduler.md` §7.1。

## 10. automation_workers（local 先行，remote 只留接口）

| 约束 | 定义 |
|---|---|
| PK | `id` |
| Unique | `name WHERE deleted_at IS NULL` |
| Index | `(status, last_heartbeat_at)`（crash recovery 第 1 步轮询键） |
| FK | 无 |
| SoftDelete | `deleted_at` |
| Version | `version` |
| Status | `online / offline / draining` |
| CreatedAt/UpdatedAt | 有 + `kind TEXT CHECK(kind IN ('local','remote'))`、`endpoint TEXT`（remote 预留）、`capacity INTEGER`、`last_heartbeat_at TEXT` |

```sql
CREATE TABLE automation_workers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'local' CHECK(kind IN ('local','remote')),
  endpoint TEXT, capacity INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'online' CHECK(status IN ('online','offline','draining')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_heartbeat_at TEXT, deleted_at TEXT
);
CREATE UNIQUE INDEX ux_workers_name ON automation_workers(name) WHERE deleted_at IS NULL;
CREATE INDEX ix_workers_hb ON automation_workers(status, last_heartbeat_at);
```

## 11. automation_variables（变量/系统级配置 KV）

secret 落库加密引用；普通变量明文 JSON。

| 约束 | 定义 |
|---|---|
| PK | `key TEXT`（KV 主键，非 ULID） |
| Unique | PK 即唯一 |
| Index | `updated_at` |
| FK | 无 |
| SoftDelete | 无（删=直接 DELETE；需审计则查 audit 表） |
| Version | `version` |
| Status | 无；用 `is_secret INTEGER 0/1` 区分 |
| CreatedAt/UpdatedAt | 有 |

关键列：`value_json TEXT`（非 secret 明文）、`secret_ref TEXT`（secret 的 vault 引用）。

```sql
CREATE TABLE automation_variables (
  key TEXT PRIMARY KEY, value_json TEXT, secret_ref TEXT, is_secret INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

## 12. automation_audit_logs（审计，append-only）

crash recovery 7 步每步一行；secret 永不出现明文。

| 约束 | 定义 |
|---|---|
| PK | `id` |
| Unique | 无 |
| Index | `(actor, created_at)`、`(entity, entity_id, created_at)`（3 跳定位：execution→version/params/worker 经此表串联） |
| FK | 无（防删锁：被审计行删除后审计仍保留，故不用 FK） |
| SoftDelete | 无（永不删除，只归档） |
| Version | 无（不可变） |
| Status | 无；用 `action TEXT`（如 `task.enqueue / execution.retry / worker.takeover / session.reconnect / fingerprint.update`） |
| CreatedAt/UpdatedAt | `created_at` 有，`updated_at` 无 |

```sql
CREATE TABLE automation_audit_logs (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
  entity TEXT NOT NULL, entity_id TEXT NOT NULL, detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_audit_actor ON automation_audit_logs(actor, created_at);
CREATE INDEX ix_audit_entity ON automation_audit_logs(entity, entity_id, created_at);
```

## 13. 从 profiles.json 迁移

- 现状（`Client/main.js:28-38`）：`loadProfiles()` 读 `Client/profiles.json` 全量 JSON，缺文件则回退单 `default` profile；`saveProfiles()` 全量覆盖写，无版本、无锁、无审计。
- 迁移路径：`SCHEMA_VERSION INTEGER` 存 `automation_variables(key='schema_version')`，当前值 `1`；启动时 `PRAGMA user_version` 与其对齐，不一致则跑 `migrations/NNN.sql`。
- import：一次性脚本 `scripts/import-profiles.js`（幂等，可重跑）：读 `profiles.json` → 每个 profile 生成 `automation_task_items.profile_id` 引用的目标记录（profile 本体表由 ProfileContext 域另行定义，本文件只保证 `profile_id TEXT` 外键悬空前先 import）→ 写 `automation_audit_logs(action='profile.import')` 一行 → 成功后把原文件重命名 `profiles.json.bak`（不删除，留回滚）。
- jsonl（`MClient/agent/engine.js:107-109`）：`runs/<runId>.jsonl` 按 `runId → execution_id` 映射逐行 INSERT 进 `script_execution_logs`（`seq` 按行号），导完后文件归档不删；新 run 直接双写（先 append 本地缓冲，再批量 flush 入表，保证 crash 后可按 §附录 B 第 5 步重放补空洞）。

## 附录：建表顺序与最小索引清单

顺序（FK 依赖）：`scripts → script_versions → script_parameters / script_templates → automation_schedules → automation_tasks → automation_task_items → automation_workers → script_executions → script_execution_logs → automation_variables → automation_audit_logs`。
P99 列表页 <500ms 必备索引：`ix_exe_status`、`ix_logs_exe`、`ix_items_task`、`ix_sched_poll`、`ix_workers_hb`、`ix_audit_entity`；`EXPLAIN QUERY PLAN` 验收每页查询全走索引，无 `SCAN`。
