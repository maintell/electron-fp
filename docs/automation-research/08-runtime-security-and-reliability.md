# 08 · 运行可靠性与执行安全（Runtime Reliability & Execution Security）

> 性质：research+design 合并稿，**以仓库实读源码为准**（`automation/runtime/*.js`），**整合/适配**既有 `docs/automation/` 设计语料。
> 一句话边界：as-built 提供的是**能力裁剪 + 崩溃记账 + 重试闭环**；**不是**资源隔离，也**不是**真正的安全隔离——`node:vm` 与宿主同进程，逃逸上限已在 §3.4 如实声明。
> 姊妹文档：数据实体/API 见 `07-data-model-and-api.md`；威胁模型原始定义见 `docs/automation/security.md`。

---

## 0. 文档集导航（00–11）

本包编号 00–11，本文件为 **08**。已落盘的姊妹文档（相对链接）：

| 编号 | 文档 |
|---|---|
| 00 | [00-executive-summary.md](./00-executive-summary.md) |
| 01 | [01-source-catalog.md](./01-source-catalog.md) |
| 02 | [02-competitor-matrix.md](./02-competitor-matrix.md) |
| 03 | [03-competitor-technical-analysis.md](./03-competitor-technical-analysis.md) |
| 04 | [04-automation-technology-selection.md](./04-automation-technology-selection.md) |
| 05 | [05-system-architecture.md](./05-system-architecture.md) |
| 06 | [06-script-sdk-specification.md](./06-script-sdk-specification.md) |
| 07 | [07-data-model-and-api.md](./07-data-model-and-api.md) |
| **08** | **`08-runtime-security-and-reliability.md`**（本文件） |
| 09 | [09-test-and-acceptance-plan.md](./09-test-and-acceptance-plan.md) |
| 10 | [10-implementation-roadmap.md](./10-implementation-roadmap.md) |
| 11 | [11-open-questions.md](./11-open-questions.md) |

> 上游：[00-executive-summary.md](./00-executive-summary.md)；数据/API：[07-data-model-and-api.md](./07-data-model-and-api.md)；待决项：[11-open-questions.md](./11-open-questions.md)。

---

# 第一部分 · 运行可靠性

## 1. 三层状态机映射

三层状态口径**不可混用**（详见 `07-...md` §3）：

| 层 | 状态数 | 状态集 | 实现锚点 |
|---|---|---|---|
| **Execution** | 7 | `CREATED QUEUED RUNNING SUCCESS FAILED CANCELLED RETRYING` | `database.md` §5（设计）；runner 6 态 + manager `QUEUED` |
| **Queue** | 12 | `CREATED QUEUED STARTING RUNNING PAUSED STOPPING RETRYING SUCCESS FAILED CANCELLED TIMEOUT CRASHED` | `task-queue.js:10-23`（已实现） |
| **Task-Item** | 6 | `queued running done failed cancelled paused` | `database.md` §7–§8（设计） |

**12 → 6 映射**（`task.md` §8）：`CREATED→queued`；`STARTING/STOPPING→running`；`RETRYING→queued`；`TIMEOUT/CRASHED→failed`（+`error_code` 区分）；`SUCCESS/FAILED/CANCELLED/PAUSED` 同名。

**迁移裁决唯一入口**：`task-queue.js:moveTo`（`:49-58`）。非法迁移 → **抛错拒绝、状态不变**，并记 audit `{action:'state-deny',id,from,to,at}`；合法迁移记 `{action:'state',id,from,to,at}`（供 crash recovery 重放补洞）。
**`RUNNING→PAUSED` 合法**（`task-queue.js:14`）；pause 仅置状态，是否中断在跑任务由 worker `interrupt` 决定（§5）。

## 2. 任务唯一标识

| 标识 | 生成 | 位置 | 用途 |
|---|---|---|---|
| `executionId` | `crypto.randomUUID()` | `script-runner.js:322`、`automation-manager.js:31` | 单次运行实例 |
| 队列条目 `id` | `crypto.randomUUID()` | `task-queue.js:80` | claim 主键 |
| schedule `id` | `crypto.randomUUID()` | `scheduler.js:135` | 调度注册 |
| `idempotency_key` | **设计**（`database.md` §5 条件唯一索引） | 未实现 | at-least-once → exactly-once 去重落点 |
| `taskPlanId` | 透传（可空） | `task-queue.js:81` | 关联 Task 计划（设计） |

**设计约束**：`script_executions.idempotency_key` 条件唯一（`WHERE deleted_at IS NULL AND idempotency_key IS NOT NULL`）；as-built 无此键，**去重能力当前缺失**（诚实缺口，见 §12 任务恢复边界）。

## 3. 执行心跳

- **as-built**（`worker.js`）：`heartbeatMs=5000`（`:9`）定时 `setTimeout` 链（`:83-93`），每次回调写 `lastHeartbeatAt` 并调 `onHeartbeat({running,claimed,completed,failed,ts})`。
- **`status()`**（`:277-279`）：`{state,running,claimed,completed,failed,lastHeartbeatAt}`。
- **设计形态**（`worker.md` §2）：心跳载荷 `{workerId,ts,status,running,capacity,inflight[{itemId,taskId,startedAt,executionId}]}` 落 `automation_workers.last_heartbeat_at`，crash recovery 第 1 步以超时（默认 30s）标可疑。
- **诚实缺口**：as-built 无 `workers` 表行、无心跳超时判定；进程恢复靠 `queue.claim` 异常路径的 `worker-recover` 审计（`worker.js:197-199`）。

## 4. 超时（三层，各自独立）

| 层级 | 参数 | 默认 | 实现 | 行为 |
|---|---|---|---|---|
| Script runner | `timeoutMs` | **30000 ms** | `script-runner.js:300,440-443` | `vm.Script.runInContext({timeout})` + `Promise.race` 超时 promise；触发 `TimeoutError(retriable:true)` → status `TIMEOUT` |
| Worker per-task | `taskTimeoutMs` | **60000 ms** | `worker.js:10,119-124` | `Promise.race` 超时 → `code:'TASK_TIMEOUT'` → `queue.timeout(id)` + `cancelFn()` |
| CDP protocol | `protocolTimeout` | 30 s（设计） | `runtime.md` §2.2（Phase 1 定值） | pending 整表 reject，不杀窗口 |

- **超时与取消的竞态**：runner 用 `Promise.race([p, timeoutPromise, abortPromise])`——**先 settle 者胜**（`script-runner.js:455`）；`finally` 清 `timer` 并移除 abort 监听。
- **vm 硬 hang**：`await` 永不 settle 的脚本，`Promise.race` 的 timeout 分支仍能 settle；但底层 promise 被**遗弃**（`automation-manager.js:105` 注释「abandoned promise = Phase 4 worker-kill territory」）。

## 5. 用户取消

| 路径 | 入口 | 机制 | 收敛状态 |
|---|---|---|---|
| 单执行取消 | `manager.cancel(executionId)` / HTTP `POST /executions/:id/cancel` / CLI `script stop` | `abortFn`→`AbortController.abort()` + `cancelFn`（best-effort 立即 settle） | `CANCELLED`（terminal 再取消→`CONFLICT`/false） |
| runner 层取消 | `signal.aborted` 检查 | `abortPromise` reject `CancelledError`；`step()` 协作点抛 `CancelledError` | `CANCELLED` |
| 队列取消 | `queue.cancel(id)` | 状态迁移 → `CANCELLED`（RUNNING/STARTING/PAUSED/STOPPING 均可达） | `CANCELLED` |
| worker 单项中断 | `worker.abortItem(id)` | 调该 item 的 `cancelFn` | 由 runner settle 决定 |
| 暂停中断 | `service.pauseTask(id,{interrupt:true})` / `worker.pause({interrupt:true})` | `queue.pause`（仅状态）+ 对在跑项调 `cancelFn` | `PAUSED`→`CANCELLED` 收敛 |
| worker 停止 | `worker.stop()` | 硬停前对全部 `cancelFns` 调一次；等 running drain | — |

- **合作式而非抢占式**：`worker.md` §6 明确「真暂停语义 = 收敛 CANCELLED，非 vm 冻结」；不经 signal 的 vm 硬 hang 仍靠 `taskTimeoutMs`。
- **cancel 幂等**：`manager.cancel` 对终态返回 `false`；service `run.stop` 对不可取消返回 `CONFLICT`。

## 6. 浏览器崩溃 / 连接断开检测

**触发信号**（`runtime.md` §5.1，设计）：`disconnected`（debugger 断开）、`detached`（target 主动脱离）、`targetCrashed`（renderer 崩溃）、**看门狗**（队列内命令 pending 超时且无响应 → 疑似假死）。

**as-built worker 侧**（`worker.js:146-157`）：
- 执行抛 `code==='BROWSER_CRASH'` 或 `name==='BrowserCrashError'` → status `crash` → 若注入 `relaunch` hook 先 `await relaunch({item,error})`（抛错记 `worker-relaunch-fail`，**不挡重试**）→ `queue.crash(id)`。
- `queue.crash`（`task-queue.js:151-158`）：置 `CRASHED`，`attempts<maxAttempts` 时 `scheduleRetry`（默认 retriable）。
- `RECOVERABLE_SESSION`/`RecoverableSessionError` → `queue.fail` + `worker-recover` 审计 + 连续失败计数；**连续 ≥5 次 → `worker.abort()`**（硬停）。

**设计恢复七步**（`runtime.md` §5.2）：
```
1. save state     持久化 url/viewport/enabledDomains/队列快照
2. kill residual  杀残留 renderer/view（防僵尸占 partition）
3. relaunch       按 partition + ProfileContext 重建（H2→UA→TLS→Blink 顺序）
4. re-attach      debugger attach + Target.attachToTarget flatten
5. re-enable      按 enabledDomains Set 重放
6. re-navigate    恢复 url（不恢复页面内存态）
7. RetryPolicy    失败按退避重试；超限 → crashed/终态 + 告警
```

## 7. 可重试 vs 不可重试错误分类

**队列层 `RETRIABLE_NAMES`**（`task-queue.js:26`，**权威集合**）：
```
NetworkError  BrowserError  TimeoutError  DownloadError  UploadError
```
判定（`classify` `:60-65`）：`err.retriable===true` **总是覆盖**（显式优先）→ 否则查 `RETRIABLE_NAMES`。`name` 缺省 `'Error'`。

**runner 层类默认**（`script-runner.js:8-88`，与队列层有差异）：

| 错误类 | code | retriable（runner 默认） |
|---|---|---|
| `TimeoutError` | TIMEOUT | **true** |
| `NetworkError` | NETWORK | **true** |
| `BrowserError` | BROWSER | **false** |
| `DownloadError` | DOWNLOAD | **false** |
| `UploadError` | UPLOAD | **false** |
| `SelectorError` | SELECTOR | false |
| `PermissionError` | PERMISSION | false |
| `ProfileError` | PROFILE | false |
| `ScriptError` | SCRIPT | false |
| `CancelledError` | CANCELLED | false（**不在 9 类 taxonomy 内**，协作中止信号） |

> **诚实差异**：`task.md` §5.1 分类基线把 `BrowserError/DownloadError/UploadError` 标为 **true**；runner 实现构造为 **false**。`task-queue.js` 的 `RETRIABLE_NAMES` 含 `BrowserError`（历史宽口）。**冲突时以运行时错误实例的最终 `err.retriable` 为准**（`task.md` 已注明）。
> **错误 taxonomy 是 9 类**（`ERROR_CLASSES`），`CancelledError` 刻意不入 `listErrors()`。

**分类裁决**：`worker.executeItem`（`worker.js:134-176`）按 `code`/`name` 分流——`TASK_TIMEOUT`→`queue.timeout`；`BROWSER_CRASH`→`queue.crash`；`CancelledError/AbortError`→`queue.cancel`；其余→`queue.fail`（读 `err.retriable`）。

## 8. 重试次数与退避

**默认参数**（`task-queue.js:33`）：`{max:3, baseMs:5000, mult:3, jitter:0.2}`。

**退避公式**（`backoff` `:38-41`）：
```
delay(n) = min(cap, baseMs × mult^(n-1)) × jitterFactor
cap = 300000 ms
jitterFactor ∈ [1-0.2, 1+0.2] = [0.8, 1.2]   （rng.jitter，seeded）
```
数值序列（名义值）：n=1 → ~5s；n=2 → ~15s；n=3 → ~45s；n=4 → ~135s；**n≥5 → 300s 封顶**。

**计数语义**（`scheduleRetry` `:68-74`）：`attempts += 1` **在调度时自增**（非 claim 时）；`maxAttempts` 默认 = `retry.max`（3）。`fail` 判定 `error.retriable && item.attempts < item.maxAttempts` → `RETRYING`，否则 `FAILED`。
**`retryNow(id)`**（`:184-190`）：跳过剩余 backoff 立即 `→QUEUED`；**不增加 `attempts`**（防无限手动续命由调用方策略决定；实现层只记审计）。
**`timeout`/`crash`**（`:142-158`）：先置 `TIMEOUT`/`CRASHED`，再 `attempts<maxAttempts` 时 `scheduleRetry`。
**seeded RNG**（`humanize.md` §3）：退避 jitter 走 `createRng(seed=hash(profileId))`，**禁裸 `Math.random`**（运行时计时路径）。

## 9. 最大等待

| 项 | 上限 | 锚点 |
|---|---|---|
| 单次重试退避 | **300000 ms** | `task-queue.js:39` |
| cron 下次命中搜索窗 | **366 天**（`WINDOW_MS = 366*24*3600*1000`） | `scheduler.js:9,78` |
| interval 最小周期 | **1000 ms** | `scheduler.js:102` |
| runner 单脚本 | 30000 ms | `script-runner.js:300` |
| worker 单任务 | 60000 ms | `worker.js:10` |
| HTTP body | 1 MB（`MAX_BODY`） | `http-api.js:7` |
| 执行日志条数 | 1000（`MAX_LOGS`） | `script-runner.js:116` |
| audit ring | 10000（`capacity`） | `audit-log.js:33` |

## 10. 幂等性与重复执行防护

**现有防护**：
- **claim 互斥**：队列 item 从 `QUEUED→STARTING→RUNNING` 的合法迁移即锁；并发双领第二次抛错拒绝（`task-queue.js:105-121`）。
- **同 profile 串行**：`worker` 维护 `runningProfiles` Set，claim 时 `skip` 已在跑的同 profile item（`worker.js:43,195`）——「同一身份不并行写」。
- **终态幂等**：`manager.cancel`/`queue.cancel` 对终态 no-op。
- **导入不覆盖**：`importScript` fresh uuid，永不覆盖既有脚本；`trusted` 位不随包导入。

**诚实缺口**：
- **无 `idempotency_key` 去重**（设计有、未实现）→ at-least-once 目前**不能保证 exactly-once**；crash 后重投可能产生重复 execution。
- **`retryNow` 不设限**（不增 attempts）→ 手动无限续命由外部策略兜底。
- **页面操作本身不一定幂等**（见 §11）。

## 11. ⚠️ 页面操作幂等性警告（必读）

**页面操作不一定幂等。** 以下操作**不可逆**，**禁止无条件自动重试**：

| 类别 | 示例 | 重复执行的后果 |
|---|---|---|
| 提交订单 | 点击「下单/提交」 | 重复下单、重复扣款 |
| 付款/转账 | 支付确认 | 重复扣款 |
| 发布内容 | 发帖/发消息/推送 | 重复发布、刷屏 |
| 删除类 | 删除账号/记录 | 二次删除报错或误删 |
| 注册/邀请 | 提交注册 | 重复账号 |

**规则**：
1. 对上述不可逆操作，**必须使用显式恢复策略**（先查状态再决定是否重放，而非盲目重试）；脚本作者应在脚本内做幂等键/状态检查。
2. **禁止**把不可逆操作放在会被自动重试的路径上而不做幂等保护；`RETRIABLE_NAMES` 的宽口（`BrowserError` 等）会增加误重试面。
3. 现有队列的自动重试（§8）**不区分操作语义**——它只认错误类型。**语义幂等是脚本/调用方的责任，不是队列的**。
4. `ponytail` 建议：不可逆操作脚本宜设 `maxAttempts=1`（或 `retryPolicy.retriable_only` 收紧），并在脚本内显式判态。

## 12. 失败现场信息保存（`buildTrace`）

`buildTrace({browserApi, currentUrl, now})`（`script-runner.js:253-298`）**仅 FAILED/TIMEOUT** 触发（`:487`），三源独立 guard（**永不抛**、保留部分）：

| 源 | 内容 | 上限 | 标志 |
|---|---|---|---|
| `url` | `page.getCurrentUrl()`，回退 `record.currentUrl` | — | `sources.url` |
| `html` | `document.documentElement.outerHTML` | **262144 B**（`MAX_TRACE_HTML_BYTES`，超限 `htmlTruncated=true`） | `sources.html` |
| `network` | `network.recent()` 尾部 | **50 条**（`MAX_TRACE_NETWORK`） | `sources.network` |

**产物**：`record.trace = {ts,url,htmlBytes,htmlTruncated,network[],sources,html?}`；截图另存 `record.artifacts[] = {ts,kind:'screenshot',bytes?|error?}`（`captureArtifact` `:354-372`，捕获失败记 `error` 不拖垮记录）。
**诚实 ceiling**：截图 fn 若 hang 会拖记录结算——由 worker `taskTimeoutMs` 兜底（`script-runner.js:486` 注释）。

## 13. 任务恢复边界（crash recovery 7 步 → 实现状态）

| # | 步骤 | 归属 | as-built 状态 |
|---|---|---|---|
| 1 | 心跳超时标可疑 | Queue 轮询 `ix_workers_hb`（设计） | ⚠️ 内存实现无 workers 表；靠 `worker-recover` 审计 |
| 2 | 接管 RUNNING + 排他锁 | `queue.crash` + claim 绑定 + 迁移检查 | ✅ |
| 3 | 按幂等键去重 | `idempotency_key` 唯一索引（设计） | ❌ **键与索引均未实现** |
| 4 | retriable 回 QUEUED（backoff），非 retriable → FAILED | §7/§8 分类 + 退避 | ✅ |
| 5 | 重放 audit 补 logs 空洞 | 读 `automation_audit_logs(entity='task_item')` 对账 | ⚠️ 设计就绪，**对账重放器未建** |
| 6 | session 重连（disconnect-not-close） | kill residual → relaunch → re-attach | ⛔ **P1 Electron glue 接线缺口**（`test-browser-session.js` 仅 mock 级 `recover()`） |
| 7 | 告警 + observability 打点 | metrics + audit | ⚠️ 字段就绪，面板/告警通道未做 |

**一句话诚实结论**（`worker.md` §4）：Phase 4 交付 = **检测 → 记账 → 幂等 → 重试闭环（步 1–4）**；**进程级自愈（步 6 relaunch/reattach）是 Electron glue 接线活，未做**。当前净效果：**item 不丢、不双跑，但需外部有可用 BrowserSession 才能真正重启**。

## 14. 日志轮转与磁盘限制

| 日志 | as-built | 限制 | 轮转/retention |
|---|---|---|---|
| 执行日志 | `record.logs` 内存数组 | `MAX_LOGS=1000`，超限**静默丢新行** | **无轮转**；随 record 存活 |
| audit 收集器 | 内存 ring + 可选 JSONL（`FP_AUTOMATION_AUDIT_FILE`） | ring `capacity=10000` | JSONL **append-only，无内置轮转**；ring 溢出丢最旧 |
| 设计 `script_execution_logs` | 未实现 | 写：WAL + 每 200 条/1s flush | **90 天**归档 SUCCESS/CANCELLED；`DELETE … LIMIT 5000` 循环；1M+ 按月 `ATTACH` 分库（`database.md` §6） |
| 设计 `automation_audit_logs` | 未实现 | 永不删除，只归档 | 保留期最长（`security.md` §9） |

**诚实缺口**：**as-built 无任何日志轮转/磁盘配额**；JSONL 会无界增长（依赖外部清理）。落库 retention 是设计。

---

# 第二部分 · 执行安全与隔离

## 15. 权限边界（Capability 模型）

**默认能力集**（`script-store.js:10` `DEFAULT_PERMISSIONS`）：
```text
{ browser:true, cookies:true, storage:true, network:true, filesystem:false, process:false }
```
**键集**：store 校验 6 键（`CAPS` `:9`）；runner 注入 10 键（`CAP_KEYS` `:115`）；`automation.d.ts PermissionKey` 10 键（详见 `07-...md` §2.13 的诚实差异表）。
**默认 deny**（`security.md` §2）：`require('child_process'/'fs'/'os'/'net'/'dgram'/'shell')`、裸 `process`、`eval/new Function`、shell 拼串——**不以参数开关绕过**。
**trust 闸**：`filesystem`/`process` 需 `permissions[key]===true` **且** trusted；wired 模式走 `trustResolver(scriptId)`（`script-runner.js:413-429`），**resolver 失败 = deny（永不 fail-open）**。
**deny 实现**：`denyProxy(key)`（`:159-181`）——get/set/has/apply/construct **全部抛 `PermissionError`**（不是返回 undefined）。

## 16. 脚本访问本地文件范围

- **默认 `filesystem:false`** → `denyProxy('filesystem')`。
- **trusted 解闸**后才暴露，且受**围栏**约束：`upload`/`download` 的路径须过 `browser-api.js checkPath`（fail-closed；`security.md` T4/T7），拒绝 `../`、绝对路径、symlink 跳出。
- **设计**：trusted 只放行声明的最小目录 + 只读/只写位（`security.md` §2）；as-built 围栏已落地（`test-browser-api.js` 围栏块），但**目录声明式最小集未落地**。

## 17. 子进程启动权限

- **默认 `process:false`** → `denyProxy('process')`；`require`/`child_process` 在 vm 上下文**不可达**（不在注入清单）。
- **trusted 解闸**：仅放行参数化调用、**禁 shell 拼串**（`security.md` §7）；as-built 的 process 注入面在实现上仍是占位（`automation.d.ts:453` `declare const process: unknown`）。
- **无 shell 拼串入口**（`security.md` §2 规则）。

## 18. 网络访问

- **设计**：`network: allowlist`——https/wss + 域名 allowlist；内网段/元数据地址/非标端口默认拒绝；**执行侧强制，不依赖脚本自觉**（SSRF T6）。
- **as-built 诚实缺口**：`network` 目前是**只读观测 + intercept 改写未接**；SSRF 执行侧强制**待 P3**（`script-sandbox.md` §6 勾选表 #6 为 ☐）。CDP `Network.` 域只读（§23）。

## 19. 密钥 / 令牌存储

- **secret 参数**：`type==='secret'` 或 `secret===true` → 名字进 `secretNames`；**值本身也进**（用于 scrub）；`scrubSecrets` 在 console/instrument/error.message/error.stack 全链替换为 `***`（`script-runner.js:228-238,344-352,479-480`）。
- **不存明文**：as-built **无 vault**；secret 值仅运行期存在于 params，不落库（`script_execution_logs` 设计用 `secret_ref`）。
- **audit 二次脱敏**：`audit-log.js` 门口 `scrubValue` 抹 `SECRET_KEYS`（`token/authorization/password/secret/key/signature/bearerToken/proxyPassword`）+ `FP_RE`（FP 载体）→ `***` / `[SCRUBBED:fp-carrier]`；字符串 >4096 截断。**这是第二道网，非首道**。
- **设计**：`automation_variables.secret_ref`（secret 只存 vault 引用）；`security.md` §5 HMAC 信封（payload+nonce+expiry+HMAC）——**均未实现**。

## 20. 脚本间状态隔离

- **每次 `run()` 新建 vm 上下文**（`vm.createContext(sandbox)` `:437`）——每个 context 有**独立 `Object.prototype`**（新 V8 context），脚本内 `Object.prototype.x=1` 只污染 vm 自身，宿主不受影响。
- **原型污染清洗**：`cleanInput`（`:214-223`）在 host→vm 边界丢弃 `__proto__/constructor/prototype`；`validateParameters` 边界同样清洗（`script-store.js:325-330`）；参数名保留字直接拒绝。
- **冻结**：`params`/`context` 深冻结（`Object.freeze` + `cleanInput`），运行中不可改写以影响门控/日志。
- **无宿主继承**：sandbox 显式 allowlist（§22），不继承 `globalThis`/`require`/`module`。

## 21. 超时与强制终止 / 内存 CPU 限制

- **超时**：见 §4（runner 30s / worker 60s）。
- **强制终止**：`codeGeneration:{strings:false, wasm:false}` 关死 `eval`/`new Function`/动态 wasm（`:437`）。
- **内存/CPU 限制**：**as-built 无任何限制**（诚实缺口）。仅有的"限制"是：`MAX_LOGS=1000`（日志条数）、`MAX_TRACE_HTML_BYTES`（trace 体积）、`MAX_BODY=1MB`（HTTP 入站）。**vm 无堆/CPU 配额**；死循环靠 `timeoutMs` 打断，但内存膨胀无上限。升级见 §24。

## 22. 不可信脚本隔离（vm 注入面）

`vm.createContext(sandbox)` 的 sandbox 显式 allowlist（`script-runner.js:384-402,431-435`）：

| 类别 | 注入项 |
|---|---|
| 语言内置 | `JSON` `Math` `Date` `Promise` `URL` `structuredClone` |
| SDK 全局 | `params` `context` `console` `step` `page` `browser` `cookies` `storage` `network` `download` `upload` `dialog`（`profiles` 仅显式跨 profile 声明） |
| 错误类 | 9 个 `ERROR_CLASSES`（冻结） |
| capability 键 | 按 `isAllowed(key)` 注入 `expose(key)`，否则 `denyProxy(key)` |

**不注入**：`require` `process` `module` `globalThis` 宿主引用、Electron API、`env`/`FP_*`（永关，ADR-5）。
**`step(name)`**：协作中止缝（signal.aborted → 抛 `CancelledError`）+ 记 `currentStep`。

## 23. Electron IPC 权限校验 + CDP 方法 ACL

### 23.1 IPC（sender-check + URL gate）

`ipc-bridge.js` 双门（`:120-151`）：
1. **通道白名单**：`ALLOWED_SET.has(channel)`，否则 `DENY 'channel not allowed'`。
2. **sender 校验** `isSenderAllowed`（`:74-88`）：`getType()` 必须 ∈ `{window, webContents}`（**`webview` 帧恒拒**）；URL 必须匹配 `allowedSenders[].urlPrefix`（缺省 `['file://','http://127.0.0.1','http://localhost']`）。
3. 拒绝**不泄漏**具体哪道门失败（统一 `'sender not allowed'`）。
4. `register()` 只注册 allowlist 通道；请求列表含未知通道直接抛错。
5. 审计只记 `channel/status/code`，**永不记 args**（可能含 secret）。

### 23.2 CDP 方法 ACL（`core.js:gateCdpMethod`）

**DENY_EXACT**（`core.js:33`）：`Browser.close`、`Target.createTarget`
**DENY_PREFIX**（`:34`）：`SystemInfo.`、`FileSystem.`、`Target.closeTarget`
**ALLOW_PREFIX**（`:35-51`）：
```
Browser.getVersion      Target.getTargets          Page.        DOM.
Input.                  Network.                  Runtime.     Storage.
Target.attachToTarget   Target.setAutoAttach      Target.setDiscoverTargets   Target.getBrowserContexts
```
**判定顺序**：deny-exact → deny-prefix → allow-prefix → **默认 deny**。

**CDP-WS 桥**（`cdp-ws.js`，自建，非 `--remote-debugging-port`）：
- `PAGE_PREFIXES = ['Page.','DOM.','Input.','Network.','Runtime.','Storage.']` 转发到 `browser-session` allowlist 会话；`ACCEPT_IGNORED` 集合回空 `{}`；其余 → `-32601 'method not allowed'` + `cdp-ws-deny` 审计。
- 握手三门：**Host**（loopback）→ **token** → **profile 存在性**；任一失败 → `cdp-ws-deny`（reason: host/token/profile）+ 403/401/404。
- **语义对齐** `runtime.md` §3：`Network` 只读（禁 `setCookie/setCacheDisabled`）、`Runtime` 受限（`awaitPromise`+超时+截断脱敏）、`Browser` 仅 `getVersion` 只读发现。

### 23.3 HTTP 网关三门

`http-api.js`：Host 白名单（`127.0.0.1`/`localhost`，DNS-rebinding 面）→ CORS（OPTIONS，loopback Origin）→ Bearer（admin/viewer/JWT 三档，`tokenEqual` 常数时间 sha256）→ rate limit（60/min/token）→ body ≤1MB。**仅绑 loopback**（`start()` 对非 loopback host 抛错拒启）。

## 24. 脚本包完整性 / 依赖供应链 / 审计记录

### 24.1 脚本包完整性（trust 签名）

- `trust(id,{signature,trustSecret,actor})`（`script-store.js:251-268`）：`signature === sha256(latest.code + ':' + trustSecret)`，`timingSafeEqual` 比较；成功置 `trusted=true` + `trustedAt/trustedVersion/trustedBy`。
- **per-version**：`addVersion` 使旧签名失效（`trusted` 回 false）——**换码必须重签**。
- **导入不携带 trust**：`exportScript` 不导出 trust 位；`importScript` 剥离 `trusted/trustedAt/trustedVersion/trustedBy`（`:388`），导入脚本**恒 untrusted**。
- **Admin-only**：`trust`/`untrust` 仅 service 层可写；HTTP 侧须**显式 `Automation.Admin` JWT claim**（admin bearer 本身不够）。

### 24.2 依赖供应链

- **as-built 零依赖**：脚本 code 是自包含 async body；`require`/`import` 在 vm 不可达 → **无 npm 依赖解析面**。
- **缺口**：无 `ScriptDependency` 表/锁文件（`07-...md` §2.12）；对外脚本市场需引入（升级触发同 §25）。

### 24.3 审计记录

**事件源**（实测，`observability.md` §1.1）：`api`/`api-error`/`rate-limit`/`auth-jwt`（HTTP）；`cdp-ws-open/close/deny`（CDP 桥）；`cdp-deny`/`cdp-call`（browser-session）；`recorder-start/stop`、`recorder-session-start/stop`；`script-exec`；`execution`；`schedule-fire`/`schedule-skip`；`state`/`state-deny`/`shutdown`（queue）；`worker-abort/exec/recover/relaunch/relaunch-fail`；`ipc-deny`/`ipc-call`；`script-trust/untrust`。
**设计三元组**（`security.md` §9）：execution log / system log / audit log 分离存放、时钟单调、不可经脚本 API 篡改；as-built **同流承载**（中央收集器），独立 system 表未建。

---

## 25. 诚实区分：执行隔离 vs 资源隔离 vs 真正的安全隔离

| 维度 | as-built 提供 | 不提供 |
|---|---|---|
| **执行隔离** | ✅ vm 上下文 + 显式 allowlist 全局 + `denyProxy` 能力键 + `cleanInput` 原型清洗 + codeGeneration 关 | 进程/线程级内存隔离 |
| **资源隔离** | ❌ 无堆/CPU 配额；仅日志/trace/body 的体积上限 | 内存上限、CPU 配额、磁盘配额 |
| **真正的安全隔离** | ❌ **无** | 对抗完全恶意代码的隔离边界 |

### 25.1 `node:vm` 逃逸上限（必须明说）

- `node:vm` **不是硬安全边界**（`script-runner.js:1` 头注释、`script-sandbox.md` §4）。vm 上下文与宿主**共享进程内存**，存在已知逃逸路径（构造器链、原型逃逸等可拿到宿主引用）。
- 它提供的是**能力裁剪 + 减少误用面**，**不是**对抗完全恶意代码的隔离。
- **当前威胁模型 = 团队内 / 半信任脚本**：假定脚本作者不主动写逃逸 exploit；即便写了恶意逻辑，也**只能落在能力格子内**（无 fs/process/env/eval）。
- **对外发布脚本市场 / 运行陌生人脚本 → 当前方案不足**。

### 25.2 升级路径（按触发条件，逐级）

| 级别 | 手段 | 解决 | 触发条件 |
|---|---|---|---|
| L1（现状） | `node:vm` + allowlist | 能力裁剪 | 团队内半信任 |
| L2 | **`utilityProcess`**（Electron）或 **`worker_threads`** + 消息传递 + **结构化克隆** | 进程/线程内存隔离；宿主原型不可达（数据经 structured clone，不共享引用） | 需更强隔离但仍同机 |
| L3 | **OS 权限限制**（沙箱账户、只读挂载、seccomp/AppContainer） | 系统调用/文件面收窄 | 运行陌生人脚本 |
| L4 | **受控 API 代理**（脚本只经代理调白名单 API，代理在隔离进程） | 最小暴露面 | 高对抗/多租户 |

> **分发约束（见 [16](16-zero-runtime-distribution-constraints.md)）**：上述 L1–L4 基底**只能取自 Electron 内嵌**（`node:vm` / `worker_threads` / `utilityProcess` / OS 沙箱）；**禁止**引入系统 `node`/`python` 或第二解释器作为隔离手段。

> 升级时**不得**靠加固 vm 继续撑（`script-sandbox.md` §4 明确）。

---

## 26. 威胁清单（T1–T10）与防护状态

来源：`security.md` §1；状态取自 `script-sandbox.md` §6 勾选表（**实测**）。

| # | 威胁 | 防护 | 状态 |
|---|---|---|---|
| T1 | XSS → main 接管 | renderer 永不执行脚本；IPC sender-check + URL gate | ☑ 已落地（双层 sender 门 + 导航守卫 + permission deny-list） |
| T2 | RCE（child_process/fs） | `process`/`child_process` 默认 deny；仅 trusted 解闸 | ☑ 默认关 + trust 真签名门（版本钉选） |
| T3 | 原型污染 | 入沙箱清洗 + 冻结；vm 独立 `Object.prototype` | ☑ 已落地（`cleanInput` + 参数名保留字拒绝） |
| T4 | 路径遍历 | `filesystem` 默认 deny；trusted 围栏拒 `../`/绝对/symlink | ☑ 围栏已落地（upload/download `checkPath` fail-closed） |
| T5 | 命令注入 | `process` 默认 deny；无 shell 拼串入口 | ☑ 默认关（模型层） |
| T6 | SSRF | `network` allowlist，执行侧强制 | ☐ **设计已定，执行侧强制待 P3** |
| T7 | 任意文件读写 | `filesystem:false` + 围栏 | ☑ 已落地（围栏见 T4） |
| T8 | IPC 提权 | renderer 永不持有脚本执行权/debugger 句柄 | ☑ 架构铁律 + 双层 sender 门 |
| T9 | token/cookie 泄漏 | secret 名+值双 scrub；FP 载体 scrub；日志三元组分离 | ☑ 已落地（runner scrub + 收集器门口二次脱敏） |
| T10 | 跨 profile 访问 | cookies/storage scoped；显式 `profiles.get(id)` + 双向 ACL | ☑ scoped 模型层已定；☐ **双向 ACL 待 P0/P6** |

**非目标**（`security.md` §1）：内核指纹算法对抗强度、Chromium 沙箱逃逸防护。本层只约束 automation 胶水层。

---

## 27. 与 `docs/automation` 的关系（delta）

### 27.1 NEW（本文首次成文）

- **三层状态机 + 12→6 映射集中表**（原分散于 `task.md` §3/§8、`database.md` §5/§7）。
- **超时三层对照表**（runner 30s / worker 60s / CDP 30s）——原分散。
- **取消路径全表**（6 条路径 + 收敛状态）——原散落。
- **可重试分类的「双表冲突」显式对照**（队列 `RETRIABLE_NAMES` vs runner 类默认）——原只在 `task.md` 脚注提及。
- **执行隔离 vs 资源隔离 vs 安全隔离 的三分表** + L1–L4 升级路径——原 `script-sandbox.md` §4 只有散文。
- **不可逆操作幂等警告**单列成节（§11）——原语料无独立章节。
- **日志轮转/磁盘限制 as-built vs 设计对照**（§14）。

### 27.2 MODIFIED（相对 `docs/automation`）

| 项 | 原文档 | 本文 |
|---|---|---|
| 重试默认 | `task.md` §5.2 写 `jitter=uniform(0.8,1.2)` | 明确 `jitter:0.2` 参数 + `rng.jitter` seeded（禁裸 `Math.random`） |
| crash recovery | `runtime.md` §5.2 七步 | 加 `worker.md` §4 的**逐步实现状态**（1–4 ✅ / 3 ❌ / 5 ⚠️ / 6 ⛔） |
| SSRF | `security.md` T6「执行侧强制」 | 明确 **as-built 未接**（P3 待办） |
| 内存/CPU | 未提 | 新增诚实缺口：**无任何配额** |
| `idempotency_key` | `database.md` §5 有列 | 明确 **未实现**，at-least-once 目前非 exactly-once |

### 27.3 DEPRECATED（相对 `docs/automation`）

| 项 | 状态 | 依据 |
|---|---|---|
| 「`RUNNING→PAUSED` 不合法」 | 作废 | `task-queue.js:14` |
| 「只有 pre-start cancel」 | 作废 | runner 全程 signal 化（`script-runner.js:444-462`） |
| 「vm 是硬安全边界」的任何暗示 | 作废 | `script-runner.js:1` + `script-sandbox.md` §4 |
| 「失败无现场可查」 | 作废 | `buildTrace` + `artifacts`（§12） |
| 「profiles 未接线」 | 作废 | `profile-manager.js` 已接线（`07-...md` §7.3） |

### 27.4 引用锚点（逐项可复核）

`script-runner.js` · `task-queue.js` · `worker.js` · `automation-manager.js` · `audit-log.js` · `ipc-bridge.js` · `http-api.js` · `core.js` · `cdp-ws.js` · `browser-session.js` · `script-store.js` · `scheduler.js` · `seeded-rng.js`；设计语料 `docs/automation/{security,script-sandbox,runtime,worker,task,observability,humanize,api}.md`。
