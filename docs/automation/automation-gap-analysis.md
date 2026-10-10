# Automation 缺口分析（现状 vs 目标）

> 范围：Script / ScriptVersion / Parameter / Execution / Log / Schedule / Template + AutomationTask / Queue / Worker + ProfileContext / BrowserSession。
> 方法：现状只写已实测/已读码结论；目标对齐 user spec §3–§36；每域按 `现状 / 目标 / 缺口 / 复用还是新建` 给出。

## 文档状态索引（读前必看）

> `docs/automation/` 混排「目标设计」与「现状」。下表标注每篇口径，**避免把设计当已实现**。口径标注于 2026-10-09；随代码变动以代码为准。

| 文档 | 口径 | 实现状态 |
|---|---|---|
| architecture.md | 目标设计 | — |
| database.md | 设计（SQLite 12 表） | **未实现** — 实际用 `script-store.js` JSON 文件 |
| script-sdk.md | 设计 | 部分 |
| runtime.md | 设计 + 实现注记 | 部分 |
| task.md | 设计 + 实现注记 | 部分（状态机已对齐 `task-queue.js`） |
| worker.md | 设计 + 实现注记 | 部分（超时/状态已对齐 `worker.js`） |
| rpa.md | 规格 + 实现 | 部分（计数已对齐 `rpa-ast.js`） |
| script-sandbox.md | 约束 + 实现状态 | 部分（SSRF allowlist 未落地） |
| security.md | 约束 | 部分（capability 默认值以 `script-store.js` 为准） |
| humanize.md | 规格 + 实现 | 部分 |
| scheduler.md | 设计 + 实现 | **已实现** |
| api.md | 契约 | **已实现** |
| cli.md | 契约 | **已实现** |
| profile-manager.md | 现状实现 | **已实现** |
| observability.md | 现状 + 规格 | **已实现** |
| current-architecture.md | 现状审计（2026-09-24 快照） | 快照 — 未含 `automation/`，部分结论已过时 |
| acceptance.md | 验收状态 | 状态 |
| testing.md | 测试状态 | 状态 |
| troubleshooting.md | 排障 | 状态 |
| competitor-research.md | 外部调研 | — |
| automation-gap-analysis.md | 缺口分析（本文件） | — |

## 0. 现状锚点（全局约束，后文不再重复）

- 存储：`flat profiles.json`，无 DB；`partitions` 为内存态（缺 `persist:` 语义）。
- 双客户端不兼容：Client per-tab vs MClient per-group；proxy 仅 MClient 有；零 cookie-clear API。
- IPC：无 sender-check、无 URL gate、默认 allow-all permissions。
- CDP：默认关闭；`wc.debugger` 无鉴权、全字符串转发。
- 指纹 4 平面：Blink b64（WC > Session，`electron_browser_client.cc:697-709`）+ UA + TLS live + H2 frozen；`fpSplitConfig`（`fp-schema.js:979`）。
- preload 为 invoke-only，可复用；Client↔MClient 约 80% 重复 + fp-schema 三处复制。
- 无 task / queue / worker / scheduler / audit；agent 仅 jsonl 日志。

---

## 1. 分域缺口表

### 1.1 Script（脚本本体）

| 维度 | 内容 |
|---|---|
| 现状 | 无 Script 概念。只有散落的探针脚本 / Client 测试脚本，无版本、无元数据、无 marketplace 字段。 |
| 目标 | §3–§6：Script ≠ Task；Script 为可版本化代码资产（JS + RPA→AST 同一运行时），带 `automation.d.ts` 类型、Monaco IDE 编辑、参数声明。 |
| 缺口 | Script 实体、版本管理、类型定义、IDE 全部缺失。 |
| 复用还是新建 | **新建**：`Automation/Script` manager（main 侧）；**复用**：preload invoke-only 形态、channel 命名习惯。 |

### 1.2 ScriptVersion（脚本版本）

| 维度 | 内容 |
|---|---|
| 现状 | 无版本。改脚本即覆盖，无回滚、无 diff、无发布态。 |
| 目标 | §7：不可变版本（v1/v2…）、草稿→发布流程、执行必须绑定版本、回滚到任意版本。 |
| 缺口 | 版本表、不可变快照、发布状态机缺失。 |
| 复用还是新建 | **新建**：`scripts / script_versions` 表 + 发布状态机。 |

### 1.3 Parameter（参数，含 secret）

| 维度 | 内容 |
|---|---|
| 现状 | 参数靠环境变量硬传：`FP_CONFIG_DATA` / `FP_CONFIG` / `FP_<key>`（仅 27 个 Int/Int64 有效，36 个 String 无效；`FP_CONFIG` 有前导空白陷阱）。无类型、无 secret 遮蔽。 |
| 目标 | §10：typed params（string/number/boolean/secret/file/select），secret 落库加密、日志脱敏、Monaco 表单自动生成。 |
| 缺口 | 参数 schema、secret 通道、脱敏日志全部缺失；且 env 通道默认开启是注入风险面（见 §5）。 |
| 复用还是新建 | **新建**：params 表 + secret vault 接口；**重构**：env 通道默认关闭、改 HMAC 签名信封（见 §5）。 |

### 1.4 Execution（执行）

| 维度 | 内容 |
|---|---|
| 现状 | 无 Execution 实体。脚本跑一次即结束，无状态机、无并发控制、无批量。 |
| 目标 | §12–§18：Automation Runtime 在 main（Automation/Script/Task/Profile/Session managers）；SDK→Adapter→Playwright/CDP/Electron；Browser/Page/Element/Cookie/Storage/Network/Download/Upload/Dialog APIs；smart waits；error taxonomy；screenshot/trace；状态机 CREATED→…→RETRYING（详见附录 A）。 |
| 缺口 | Runtime、Adapter 层、全部 API 面、等待/错误/截图链路缺失。 |
| 复用还是新建 | **新建**：Runtime + Adapter + API 面；**复用**：Browser/Profile/Fingerprint 生命周期、`fpSplitConfig`/validate、MClient proxy+login、mini-browser H2→UA→TLS 顺序。 |

### 1.5 Log（三级日志）

| 维度 | 内容 |
|---|---|
| 现状 | agent jsonl logs only，无分级、无关联 execution、无审计。 |
| 目标 | §30：3-level logs（系统/执行/审计）+ observability 必答题（附录 C）。 |
| 缺口 | 日志分级、execution 关联索引、审计表缺失；100k executions / 1M logs 规模预案缺失。 |
| 复用还是新建 | **新建**：`executions / logs / audit` 表 + 索引；**复用**：jsonl 格式作为 worker 本地缓冲格式。 |

### 1.6 Schedule（cron 调度）

| 维度 | 内容 |
|---|---|
| 现状 | 无 scheduler。定时靠外部 cron 手触发。 |
| 目标 | §20：cron scheduler（时区感知、重叠策略 skip/queue/parallel、手动触发与暂停）。 |
| 缺口 | scheduler 进程、schedules 表、重叠语义、crash 恢复（附录 B 7 步）缺失。 |
| 复用还是新建 | **新建**：scheduler + `schedules` 表；恢复语义复用 worker 心跳接口（见 1.8）。 |

### 1.7 Template（含 marketplace metadata reserved）

| 维度 | 内容 |
|---|---|
| 现状 | 无模板。探针脚本不可复用为模板（无参数声明、无文档字段）。 |
| 目标 | §31–§32：templates（一键克隆、参数预填）+ marketplace metadata reserved（name/icon/version/author/desc 字段先占位、不建市场）。 |
| 缺口 | templates 表 + metadata 保留字段缺失。 |
| 复用还是新建 | **新建**：`templates` 表（metadata 列先 reserved、逻辑不实现）。 |

### 1.8 AutomationTask / Queue / Worker

| 维度 | 内容 |
|---|---|
| 现状 | 无 task/queue/worker/scheduler/audit。任务 = 直接跑脚本，无排队、无并发上限、无 worker 注册。 |
| 目标 | §13–§15：task 批量/并发/queue states（queued/running/done/failed/cancelled）；local worker → remote worker 同一接口；workers 表 + 心跳；crash recovery 7 步。 |
| 缺口 | task/items/queue/workers/variables 全缺。 |
| 复用还是新建 | **新建**：`tasks / task_items / workers / variables` 表 + Queue + Worker（local 先行、remote 只留接口）。 |

### 1.9 ProfileContext / BrowserSession

| 维度 | 内容 |
|---|---|
| 现状 | Profile = `profiles.json` flat + 内存 partition；Session = Client per-tab / MClient per-group 两套互不兼容；proxy 仅 MClient；无 cookie-clear；指纹靠 env/b64 直灌、无原子性。 |
| 目标 | §16–§19：ProfileContext 自动注入 + `fingerprint.update` 门控；profile 隔离 + 显式 `profiles.get(id)`；Session 持久化（disconnect-not-close）、bulk 操作、audit；REST/WebSocket/CLI 同一 Service Layer；Playwright `connectOverCDP` 兼容；AI Agent 预留在同一 runtime；RBAC。 |
| 缺口 | 隔离语义、显式 get、持久 session、统一 Service Layer、RBAC 缺失；partition 持久化缺失。 |
| 复用还是新建 | **复用**：Browser/Profile/Fingerprint 生命周期、MClient proxy+login、preload shape、channel names；**重构**：Client/MClient 重复抽 shared core（禁止 naive merge）、`persist:` partitions + data-dir 配置、permission deny-list、IPC sender-check + URL gate；**新建**：FingerprintBroker（setFingerprintConfig+TLS/H2/UA 原子 + Bearer）、localhost REST 网关（见 §4）。 |

---

## 2. 目标速查（user spec §3–§36 折叠）

- 核心不等式：Script ≠ Task；Script 是代码资产，Task 是运行实例。
- Runtime 在 main：Automation / Script / Task / Profile / Session 五个 manager。
- 调用链：SDK → Adapter → Playwright / CDP / Electron。
- API 面：Browser / Page / Element / Cookie / Storage / Network / Download / Upload / Dialog。
- ProfileContext 自动注入 + `fingerprint.update` 门控（非白名单键拒绝）。
- Sandbox capability 模型：默认 deny `child_process` / `fs`。
- IDE：Monaco + `automation.d.ts`；params typed（含 secret）。
- RPA→AST 统一运行时；smart waits；error taxonomy（retriable-vs-not 决定 backoff）；screenshot / trace。
- task 批量/并发/queue states；profile 隔离 + 显式 `profiles.get(id)`；cron scheduler；retry backoff。
- REST / WebSocket / CLI 同一 Service Layer；Playwright `connectOverCDP` 兼容；AI Agent 预留同一 runtime；RBAC。
- 3-level logs；templates；marketplace metadata reserved。
- DB 表：`scripts / versions / params / templates / executions / logs / tasks / items / schedules / workers / variables / audit`，按 100k executions / 1M logs 做索引与归档预案。
- local worker 先行 → remote worker 接口；crash recovery 7 步（附录 B）；状态机 CREATED..RETRYING（附录 A）；observability 必答题（附录 C）。

---

## 3. 兼容性改造计划

### 3.1 复用（不动行为，只接线）

- Browser / Profile / Fingerprint 生命周期。
- `fpSplitConfig` / validate（`fp-schema.js:979` 起）。
- MClient proxy + login 流程。
- mini-browser 顺序 H2→UA→TLS。
- preload invoke-only 形态、现有 channel 名。

### 3.2 重构（改实现、保接口）

- shared core：抽 Client/MClient 公共部分，禁止 naive merge（两者 tab/group 模型不兼容，先抽象 Session 接口再合）。
- `persist:` partitions + data-dir 可配置（解决内存态重启丢失）。
- permission deny-list（替代默认 allow-all）。
- IPC sender-check + URL gate。

### 3.3 新建

- FingerprintBroker：统一 `setFingerprintConfig` + TLS / H2 / UA 原子切换 + Bearer 鉴权。
- localhost REST 网关：仅 `127.0.0.1` + Host/Origin 校验 + triple-return + 持久 sessions（disconnect-not-close）+ bulk + audit。
- Automation Runtime + Monaco IDE + RPA AST + scheduler + observability（logs/metrics/trace 三件套）。

---

## 4. 风险

| 风险 | 缓解 |
|---|---|
| Env-channel 注入（`FP_CONFIG*` 任意进程可写） | 默认关闭 env 通道；启用时要求 HMAC 签名信封。 |
| CDP 无鉴权（`wc.debugger` 全字符串转发） | allowlist：Page / DOM / Input / Network-read / Runtime-limited；deny：Browser / Target.create / SystemInfo；不开 TCP 端口；MCP 只走 stdio。 |
| renderer God-mode（debugger 桥接到 preload 即提权） | debugger 常驻 main-only，永不桥接到 preload/renderer。 |
| 指纹回归（helpers/patches 极脆弱） | 只走门控入口改指纹；改 `.patch` 注释必须等行数替换，保持 `@@` 头行数一致。 |
| partition 分叉（Client/MClient 语义不同） | 先定 Session 接口再合，P0 只做 `persist:` 不碰合并。 |
| 内存态数据丢失（profiles.json + 内存 partition） | DB 落地前先做定时快照 + 启动恢复；DB 上线后快照逻辑删除。 |

---

## 5. 阶段（P0–P10，对应 user spec §39）

- P0：DB + shared core 抽取 + `persist:` partitions + IPC sender-check/URL gate + permission deny-list。
- P1：Automation Runtime 骨架（Automation/Script/Task/Profile/Session managers）+ `scripts/versions/params` 表。
- P2：SDK→Adapter + Browser/Page/Element/Cookie/Storage 最小 API + smart waits + error taxonomy。
- P3：Network/Download/Upload/Dialog + screenshot/trace + `executions/logs` 表。
- P4：Queue/Worker（local）+ `tasks/items/workers/variables` 表 + 状态机 + retry backoff。
- P5：FingerprintBroker（原子切换 + Bearer）+ `fingerprint.update` 门控。
- P6：localhost REST 网关 + WebSocket + CLI 同 Service Layer + audit。
- P7：cron scheduler + `schedules` 表 + crash recovery 7 步。
- P8：Monaco + `automation.d.ts` + RPA→AST + templates（含 marketplace reserved 字段）。
- P9：RBAC + secret vault + 3-level logs + 100k/1M 归档。
- P10：Playwright `connectOverCDP` 兼容 + remote worker 接口 + AI Agent 预留 + observability 问答验收。

---

## 6. 架构阻塞项

### B1. 双客户端模型不兼容却 80% 重复

- 问题：Client（per-tab）与 MClient（per-group）会话模型互斥，直接合并必坏其一。
- 原因：两套 Session 生命周期 + proxy/cookie 能力不对齐（proxy 仅 MClient）。
- 影响：Automation Runtime 无法定 Session 接口，P1 阻塞。
- 可选方案：(a) naive merge；(b) 先抽象 Session 接口、shared core 只抽纯函数。
- 推荐方案：(b)。P0 只抽 `fpSplitConfig`/validate、proxy/login 等纯逻辑；会话合并放到 P4 之后。

### B2. 指纹四平面无原子切换

- 问题：Blink b64 / UA / TLS / H2 各自独立设置，中途切指纹会产生混合身份。
- 原因：无统一入口；H2 frozen（构造期）vs TLS live 时机不同。
- 影响：`fingerprint.update` 语义无法保证，P5 阻塞。
- 可选方案：(a) 各平面分别调；(b) FingerprintBroker 原子编排 + 失败回滚。
- 推荐方案：(b)，并加 Bearer 鉴权。

### B3. IPC/CDP 默认信任 renderer

- 问题：IPC 无 sender-check、无 URL gate；`wc.debugger` 无鉴权转发。
- 原因：历史调试便利配置残留。
- 影响：Automation 多租户/profile 隔离无从谈起，P0 必须先修。
- 可选方案：(a) 一次性全收紧；(b) deny-list + sender-check 先行，allowlist 随 CDP 方法逐批加。
- 推荐方案：(b)，避免一次性收紧打断现有探针。

### B4. 无 DB 导致一切状态易失

- 问题：profiles.json + 内存 partition + jsonl 日志，重启即丢，无法做 queue/schedule/audit。
- 原因：从未引入持久层。
- 影响：P0–P7 全部依赖 DB 表。
- 可选方案：(a) 直接上重型 DB；(b) SQLite 先行、表结构按 100k/1M 预留索引。
- 推荐方案：(b)，local-first，与 remote worker 接口不冲突。

---

## 附录 A：状态机（CREATED..RETRYING）

> 分层说明：本附录是 **Execution 层 7 态**（与 `database.md` §5 `script_executions` CHECK 一致）；队列层 12 态见 `task.md` §3，Task/Item 汇总层小写 6 态见 `database.md` §7–§8，三层映射见 `task.md` §8。三层各管各的，不互相覆盖。

`CREATED → QUEUED → RUNNING → (SUCCESS | FAILED | CANCELLED) → RETRYING → QUEUED`；`FAILED` 仅 retriable 错误可进 `RETRYING`（backoff），非 retriable 直接终态；`CANCELLED` 为终态。（`SUCCESS` canonical，实现与 `database.md` §5 一致。）

## 附录 B：crash recovery 7 步

1. worker 心跳超时标记可疑；2. 接管 RUNNING task 加排他锁；3. 按幂等键去重；4. retriable 回 QUEUED（backoff），非 retriable 置 FAILED；5. 重放 audit 补 logs 空洞；6. session 重连（disconnect-not-close 语义）；7. 告警 + observability 打点。

## 附录 C：observability 必答题

- 任一 execution 能否 3 跳内定位到 script version + params 快照 + worker？
- P99 排队时长、执行时长、重试率是否有面板？
- secret 是否在任何一级日志中可被 grep 到（应为否）？
- crash 后 7 步每步是否有审计行？
- 100k executions / 1M logs 下列表页是否仍 <500ms？
