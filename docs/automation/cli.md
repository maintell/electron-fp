# Automation CLI（命令行入口）

> 性质：接口契约文档。上游：`architecture.md` §7（CLI 与 HTTP/WS 同一 Service Layer）、`api.md`（端点语义镜像）、`scheduler.md`/`task.md`（与调度/队列链路关系）、`script-sandbox.md`（沙箱边界）。user spec 对应：§22（CLI）。
> 实现锚点：入口 `automation/runtime/cli.js`，导出 `runCli(argv, service)`；测试 `automation/test-cli.js`（实跑 23 PASS / exit=0）。

---

## 1. 定位

- **与 HTTP 同一 Service Layer**：`runCli(argv, service)` 接收已构造的 `createAutomationService` 实例，命令即 service 方法调用，**零复制业务逻辑**（`http-api.js` 同款薄壳模式）。
- **本地直连，不走 HTTP**：CLI 在宿主进程内直接调 service，不经网关、不需要 Bearer——当前阶段无传输层。
- 所有输出走统一信封（同 `api.md` §3）：默认人读表格/文本，`--json` 输出 `{ok,data,error}`。

```
argv → runCli → service.scripts/run/tasks/schedules/status → 信封 → stdout + exit code
```

---

## 2. 命令树全表

### 2.1 script

| 命令 | 说明 | 退出码 |
|---|---|---|
| `script list` | 脚本列表（无 code） | 0 |
| `script get <id>` | 详情（含 versions） | 0 / 3 |
| `script run <id>` | 同步执行；支持 `--param k=v`（可重复）、`--version`、`--profile` | 0 成功 / 1 执行失败 / 3 |
| `script stop <executionId>` | 取消执行（对应 service `run.stop`） | 0 / 3 / 2（不可取消→CONFLICT 视为用法/状态错误，见 §3） |
| `script export <id>` | 导出 fp-script 包到 stdout | 0 / 3 |
| `script import <file>` | 从文件导入（fresh uuid） | 0 / 2 |

### 2.2 task

| 命令 | 说明 | 退出码 |
|---|---|---|
| `task list` | 队列条目；`--status` 过滤；打印 rows 表 + `total: N` 尾行 | 0 |
| `task run <scriptId>` | 入队（enqueue，HTTP `POST /tasks` 同语义）；支持 `--param k=v`（可重复）、`--version`、`--profile` | 0 / 2 / 3 |
| `task cancel <id>` | → CANCELLED | 0 / 3 |
| `task retry <id>` | retryNow 回 QUEUED | 0 / 3 |

（pause/resume 语义见 `api.md` §4.4，其余走 HTTP/IDE——ponytail：无调用方的子命令不预建；`task run` 为 spec §22 明列项。）

### 2.3 profile（已接线）

| 命令 | 说明 | 退出码 |
|---|---|---|
| `profile list` / `profile start <id>` / `profile stop <id>` | service `profiles` 组直连（list 打印/start 未知 id→3）；无 manager 时回退 honest 501 → **exit 2** | **0 / 2 / 3** |
| `profile fingerprint <id> --config '{...}' [--bearer tok]` | Broker 更新（stopped profile；running → CONFLICT 提示用 rotate） | 0 / 1 / 2 / 3 |
| `profile rotate <id> --config '{...}' [--bearer tok]` | Broker 旋转（stop→update→start 一 call；H2 冻结预检） | 0 / 1 / 2 / 3 |
| `script trust <id> --signature <hex> [--actor name]` | trust 签发（CLI 宿主信任域直调；HTTP 侧需 Admin-JWT） | 0 / 1 / 2 / 3 |
| `script untrust <id>` | trust 撤销 | 0 / 2 / 3 |

### 2.4 metrics

| 命令 | 说明 | 退出码 |
|---|---|---|
| `metrics [--json]` | §35 聚合：topFailures（脚本/Profile/站点）、avg·P95、失败率、crash 率、热点步骤、24h 量 | 0；metrics 未接线 → 2 |

### 2.5 全局

| 命令/flag | 说明 |
|---|---|
| `status` | 同 `GET /api/automation/status` |
| `--help` | 命令树帮助，退出 0 |
| `--json` | 信封 JSON 输出（脚本消费） |
| `--param k=v` | run 的参数（可重复；值按 store typed params coerce） |
| `--version <v>` | run 钉选脚本版本 |
| `--profile <id>` | run 的 profileContext id（单机阶段仅传 id，不查 profile 实体） |
| `--version`（顶层，可选） | 打印 CLI 自身版本——与 `--version <v>` 作用域不同：跟在 `script run <id> --version` 后属脚本版本；独立子命令 `version` 打印工具版本（实现二选一时以 `version` 子命令为准，避免歧义） |

---

## 3. 退出码

| 码 | 含义 |
|---|---|
| `0` | 成功（`ok:true`，或无副作用的查询命中） |
| `1` | 执行失败（execution/task 终态为 FAILED/TIMEOUT/CRASHED，或 run 返回业务失败） |
| `2` | 用法错误 / **未实现**（未知命令、缺参数、无 manager 时的 profile、坏 `--param`） |
| `3` | `NOT_FOUND`（id 不存在） |

- `VALIDATION` 归 2（调用方输入错），`CONFLICT` 归 1（状态竞争，非用法错）——映射自 service `error.code`，与 `api.md` §3 同源。
- `--help` 与成功查询恒 0；脚本管道靠退出码分流，不解析 stderr。

---

## 4. 环境变量

| 变量 | 说明 |
|---|---|
| `FP_AUTOMATION_STORE` | store JSON 文件路径（缺省：无持久化，进程内内存态） |
| `FP_AUTOMATION_TOKEN` | **预留给 P8**：CLI 接 HTTP 传输时读取的 Bearer token；当前本地直连 service **不读取、不校验** |

- ponytail：单机阶段 = JSON 文件存储（`script-store.js` 顶部注释同口径）；切 SQLite 的迁移口径见 `database.md` §0/§13，CLI 无感（仍只认 service）。
- CLI 在宿主侧信任域：可 `fs`（读 import 文件、写 store JSON）。**沙箱只约束脚本本体**（`script-sandbox.md`：vm 上下文 deny fs/process）——CLI 不是脚本，不受 capability 模型限制，但也因此不经 token 门控，仅限本机受信用户使用。

---

## 5. 与 CI / 调度集成

```bash
# cron 示例：每日 09:00 本地执行（外部 cron 是"手动定时"；产品内定时归 Schedule）
0 9 * * * FP_AUTOMATION_STORE=/var/lib/fp/automation.json \
  node automation/runtime/cli.js script run $SCRIPT_ID --profile prof-a --param account=a1 --json
```

链路关系（`scheduler.md` §1）：

```
CLI    = 手动入口 ──┐
Schedule = 自动入口 ─┼→ 同一 Task/Queue → Worker → BrowserSession
HTTP   = 程序入口 ──┘
```

- 三入口共队列语义（排序/at-least-once/退避见 `task.md` §4/§5；并发兜底见 `worker.md` §4）。
- CLI `script run` 走 manager 内联路径（`task_item_id` 为空，`database.md` §5）；`task run`（enqueue）类命令才进持久队列。
- CI 注意：exit code 即 verdict；`--json` 字段稳定可断言；store 文件并发写无锁——同一 store 只跑一个 CLI 实例（ponytail ceiling，SQLite WAL 后自然解除）。

---

## 6. 安全注记

- 本地直连 = 宿主信任域，无网络面；**不监听端口、不读 token**。
- 将来切 HTTP 传输（P8+）：token 从 `FP_AUTOMATION_TOKEN` 读，校验逻辑复用网关 `tokenEqual`（常数时间），CLI 不自实现鉴权。
- 输出脱敏沿用全局：secret 参数值恒 `***`，FP 载体（`FP_CONFIG_DATA` 等）不进 stdout/stderr（`security.md` §4/§9）。
- 不提供 `--eval`/任意代码直通；执行的只能是 store 里已存在的 Script 资产。

---

## 7. 测试锚点：`automation/test-cli.js`

> 实现已落地，实跑 23 PASS / exit=0。PASS/FAIL/SKIP 前缀同 `test-scheduler.js`。

| # | 断言 |
|---|---|
| 1 | `status` → exit 0，`--json` 含 `ok:true` 与 `components` |
| 2 | `script list` / `get` / `create` 往返：get 可见、未知 id → exit 3 |
| 3 | `script run` happy path → exit 0，`data.status==='SUCCESS'`；脚本抛错 → exit 1 |
| 4 | `--param k=v` 注入生效；缺 required 参数 → exit 2（VALIDATION），不产生 execution |
| 5 | `script stop` 取消运行中执行 → exit 0；终态再 stop → CONFLICT → exit 1 |
| 6 | `script export` 输出 `format==='fp-script'`；`import` 回灌得新 id（不覆盖） |
| 7 | `task list/run/cancel/retry` 与 service 一致（run=enqueue，flags 映射/裸 spec）；未知 id → 3 |
| 8 | `profile list/start/stop` 真接线（有 manager）；无 manager 时 `NOT_IMPLEMENTED` → **exit 2** |
| 9 | 未知命令 / 缺参 → exit 2 + `--help` 可用；`--json` 下错误亦为信封结构 |
| 10 | `FP_AUTOMATION_STORE` 指向临时文件：写后重跑 CLI 可 list 到（持久化生效） |
