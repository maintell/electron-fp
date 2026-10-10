# 17 · 韧性加固与 attach 共享设计（Resilience & Attach-Sharing Design）

> 本文件落实 doc 11 §7 的四项派生待办：① executions 规模（**已实现修复**）、② 单一 attach broker（**设计**）、③ token 轮换（设计）、④ 可配置 data-dir（设计）。
> 证据来源：R6–R10 实验（2026-10-09）；Electron 源码（`shell/browser/api/electron_api_debugger.cc`）实读。
> 关联：[11-open-questions.md](11-open-questions.md) §2/§7 · [08-runtime-security-and-reliability.md](08-runtime-security-and-reliability.md) · [05-system-architecture.md](05-system-architecture.md)。

---

## Part A · executions 规模风险 —— 已实现修复（OQ-21）

### A.1 问题（实验证据）
`automation/runtime/automation-manager.js` 原用**无上限** `Map` + `order[]`，`order.unshift(id)` 每次插入 O(n) → 整体 **O(n²)**；`countRunning()` 每次 `start` 全表扫描（O(n)）→ O(n²) 的**另一半**。证据：`test-scale-latency.js` 原始 seed 100k 需 **143 s**，`listExecutions` p99 **19.75 ms**。

### A.2 修复（已落地 `automation/runtime/automation-manager.js`）
| 变更 | 前 | 后 |
|---|---|---|
| 保留上限 | 无 | `maxExecutions`（默认 **10000**，镜像 metrics/audit 环） |
| 淘汰 | `order.unshift` O(n) → O(n²) | 删 `order[]`；`while(size>cap) delete(keys().next())` O(1)（Map 插入序=最旧优先） |
| `countRunning()` | 每次 start 全表扫描 O(n) | O(1) 计数器（RUNNING 时 ++，finish 时 --） |
| `listExecutions` | 遍历 `order`（newest-first） | 反序遍历 `Map.values()`（newest-first）——**顺序与分页不变** |
| 公共 API | — | **签名不变**；唯一可观察变化=新上限 |

### A.3 证据（已独立复跑）
- `automation/test-executions-cap.js`（新增）**4 PASS**：cap 强制（250→保留 100）、最旧先淘汰 + newest-first 保持、默认 10000、seed 100k **1.22 s**（原 143 s）。
- `automation/test-scale-latency.js` **3 PASS**：executions 现 bounded（retained 10000）；`listExecutions` p99 **0.153 ms**（原 19.75 ms）。
- 回归（exit 0）：`test-automation-manager.js` **11 PASS**、`test-integration.js` 8、`test-http-api.js` 27、`test-ws-api.js` 6、`test-templates-api.js` 7、`test-electron-wire.js` 10、`test-stress.js` 2、`test-serve.js` 9。

### A.4 残余
- **env 可调**（`FP_AUTOMATION_EXECUTIONS_CAPACITY` 经 `serve.js`/`wire.js` 接线）为遵守「不动无关文件」暂缓；运营需要时再加。
- `stats()` 仍 O(n)（低频，可接受）；内存环只保最新，**DB/归档**为后续（doc 07）。
- 淘汰最旧**运行中**记录的理论边界：cap=10000 ≫ maxConcurrent=5，实际不会命中。

---

## Part B · 单一 attach broker（OQ-22）—— 设计

### B.1 事实（Electron 源码实读，非假设）
- `Debugger::Attach` 只要 `agent_host_` 已置就抛 **"Debugger is already attached to the target"** → **一个 `Debugger` 实例 = 一个 DevTools 客户端**。
- `sendCommand(method, params, sessionId)` **支持 sessionId**，回复按单调 `previous_request_id_` 关联 → **N 个并发 JS 调用本就安全**。
- `message` 事件带 `sessionId`。
- 现行 Electron 中，同 `webContents` 的 `RenderFrameHostChanged` **不再**拆解/重绑 attach → **失效信号应取 `detach` 事件，而非假设的 RFH 事件**（本 fork 需探针确认）。

### B.2 代码现实：**三个** attach owner（比工单描述的更糟）
| owner | 位置 | 行为 |
|---|---|---|
| 内置 executor | `executor.js:30-37` | `live.session` 恒 `undefined`（launcher 不设，`launcher.js:47`）→ **每次运行都新建 session 并 attach** |
| 录制器 | `recorder-controller.js:71-72` → `glue.js:26-27` | 新建 `createElectronSession` 并 attach |
| CDP-WS 桥 | `cdp-ws.js:297-299` | 自建 session 并 attach |

→ **即使无任何外部客户端**，第二次内置运行（或录制+执行）就已相撞。broker 与外部客户端无关，是内置自身的刚需。

### B.3 决策：**proxy-only 单 attach broker + broker 级多路复用**
一个 `webContents` 仅一个 attach owner；**所有消费者（内置自动化 + 每个外部 CDP 客户端）经 broker 代理，外部永不自行 attach**。
- 否 **serialize**：不满足「同时共存」。
- 否 **flat-session mux**（`Target.attachToTarget{flatten:true}`）：对**已 attach 的根目标**再开 session 在本 fork 未验证；现 `cdp-ws.js:158` 转发前**已剥离 sessionId**，说明真会话路由未接线 → 不建立在未验证原语上，延后至 Phase 3（probe-gated）。
- 选 **proxy-only**：唯一能在**已验证行为**上实现，且是**减法**（删第二次 attach，复用现有 `routeMessage` 路由）。同进程内多路复用无需 CDP 魔法：一个 debugger 对象、N 个 `sendCommand`、N 个 `message` 监听。

### B.4 接口（新模块 `automation/runtime/attach-broker.js`，纯、注入对象、WeakMap by webContents）
`acquire({webContents, consumer}) → handle{ get session, getState(), sendCommand(m,p,sid), onMessage(fn), release() }`
- handle **不暴露 `attach`/`detach`/`close`** → 消费者无法再引入双 attach（**新不变量**）。
- `ensureAttached()` 用 `attachP` 闩去重并发 attach（两消费者竞争只 attach 一次）。
- `release()` 到 0 ref 才 `detach`；`release` 前须 `await attachP`（避免 detach 竞态）。

### B.5 外部接入（`cdp-server.js` 变纯接线 shim）
- `createCdpWs` 增 `broker` 选项；`upgradeHandler` 以 `broker.acquire(...)` **替换** `cdp-ws.js:297-299` 的独立 attach。
- **`close()` 必须 `handle.release()`，不能 `session.detach()`**（`cdp-ws.js:351`）——否则一个客户端断开会杀掉所有人（**最关键一行重构**）。
- 命令/事件/sessionId 路由**不变**：`routeMessage`（`cdp-ws.js:75`）仍合成浏览器级方法、`PAGE_PREFIXES` 经共享 session 转发、其余 deny；`Target.attachToTarget` 仍返回 per-connection 合成 `cdp-sess-1`（每外部客户端仍以为独占会话）；事件改走 `handle.onMessage`（替换 `cdp-ws.js:340` 的直连监听）。

### B.6 生命周期 / 并发 / 失败
- **拥有者**=broker；仅 `acquire` 调 attach、仅 `release` 归零调 detach。建议 **launcher/profile 持一个生命周期 hold**（start acquire / stop release），避免运行间抖动。
- **窗口关闭**：WeakMap 丢弃 + debugger 自 detach（`reason:'target closed'`）→ 下次 `acquire` 重 attach，无 "already attached"。
- **crash**：`Inspector.targetCrashed` 已置 session `crashed`（`browser-session.js:47`）→ broker 通知消费者重连；`dbg.on('detach')`（`browser-session.js:58`）为兜底。
- **并发**：N 外部+内置同时 → 同一 `sendCommand`，Electron request-id 保独立回复，无需锁。
- **失败**：denied 只 reject 调用者（`gateCdpMethod`/FP scrub 本地抛，`browser-session.js:82-94`），session 对他人仍 attached。
- **现 HTTP 500 路径** → 正常 **101**（加入既有 attach）+ audit `cdp-ws-share`；500+`reason:'attach'` 仅留防御性回退。

### B.7 安全
- 共享 `browser-session.sendCommand` 是**唯一 choke point** → `gateCdpMethod`（`core.js:53`）+ FP 载体 scrub 对**外部同样生效**；外部不再拥有 session，**无法绕过 allowlist**。
- token/loopback 门（`cdp-ws.js:185-190,214,277`）不动。
- **新不变量**：只有 `attach-broker.js` 可调 `webContents.debugger.attach`（grep/测试守卫防回归）。

### B.8 权衡 / 风险 / 阶段
| 维度 | proxy-only（选） | serialize | flat-session mux | 现状 |
|---|---|---|---|---|
| 同时共存 | ✅ | ❌ | ✅ | ❌ |
| 可在已验证行为上实现 | ✅ | ✅ | ❓ | — |
| 改动量 | 小（减法） | 小 | 大 | 无 |
| 每客户端 CDP 隔离 | ❌ 共享 session/world | n/a | ✅ | ❌ |
| 外部绕过 gate | ❌ 不能 | n/a | 可能 | ❌(500) |
| 修复内部多重 attach | ✅ | 部分 | ✅ | ❌ |

**风险**：① 共享 isolated world（外部 `Runtime.evaluate` 与自动化同 world，可串扰；升级=per-consumer `__world`）；② 共享 domain 状态（`Network.enable`/`Page.enable` 在此为进程级，A 看到 B 开的域；P2 加 per-consumer 域过滤）；③ flat-session 未验证，勿先建。
**阶段**：**P1（最小，解阻塞）✅ 已实现（2026-10-09）**：新增 `automation/runtime/attach-broker.js`（proxy-only，WeakMap by webContents，handle 不暴露 attach/detach）；`cdp-ws.js`/`cdp-server.js`/`glue.js`/`executor.js`/`recorder-controller.js` 改 acquire/release（`broker` 可选，legacy 路径保留）；`probe-attach-coexist.js` 重写为**正向共存探针 11 PASS**（核心=全 run attach 计数 **==1**；外部 WS→**101**；并发回复独立；deny 门对外部生效；release 不误杀；全释放后 `isAttached()===false` 再 acquire 干净）。回归全绿：`test-cdp-ws` 20、`test-cdp-server` 7、`test-electron-wire` 10、`test-automation-manager` 11、`test-ipc-bridge` 18、`test-script-runner` 31、`test-integration` 8；Electron `probe-cdp-server` 10、`probe-script-e2e` 17、`probe-automation-smoke` 24、`probe-real-stress` 8、`probe-recorder-control` 7、`probe-live-recorder` 7。**已知（预先存在，非本次引入）**：`probe-cdp-ws-client.js` 的 "Playwright-shaped setAutoAttach → attachedToTarget" 一腿超时（`first=!state.attached||!state.sessionId` 逻辑未改，换回原 packaged `cdp-ws.js` 可复现）；**P2 ✅ 已实现（2026-10-09）**：per-consumer 域过滤（`acquire({webContents,consumer,domains})`，`handle.stats()→{delivered,dropped,filtered}`）+ 中央单一 `message` 监听 fan-out（每 entry 恒 1 个）+ launcher 生命周期 hold（`createElectronLauncher({broker})`：start acquire / stop release）+ audit `attach-broker-share`；验证 `automation/test-attach-broker.js` **7 PASS**（纯 node，fake debugger）+ P1 探针 `probe-attach-coexist.js` **11 PASS**（attach 计数仍 ===1，P1 未回归）；**P3 ✅ 已实现（opt-in，2026-10-09）**：`acquire({flat:true})` 在共享根 attach 上为每 consumer 开真 flat session（`Target.attachToTarget{flatten:true}` → per-consumer `sessionId`；命令带 sessionId、事件按 sessionId 路由、release 先 `detachFromTarget`）；默认（flat 省略）= P1/P2 完全不变。可行性探针 `automation/probe-flat-session.js` **7 PASS**；`automation/test-attach-broker.js` **11 PASS**（P2 7 + P3 4）；P1 探针 `probe-attach-coexist.js` **11 PASS**（attach 计数仍 ===1）。诚实边界：flat↔flat 完全隔离；**非-flat consumer 仍收全事件**（flat↔非-flat 是共存非隔离）。

### B.9 探针必须断言（改写 `probe-attach-coexist.js` 为正向共存探针）
① 内置先 attach→`state==='attached'`；② 外部 WS upgrade→**101**（断言**非** 500）；③ **全run attach 计数==1**（spy `webContents.debugger.attach`，核心证据）；④ 并发：内置 `6*7`→42、外部 `2+2`→4，各得各的回复；⑤ 两外部客户端同时→都 101、合成 sessionId 不同、回复独立；⑥ 外部发 denied 方法→拒绝 + audit `cdp-deny`（证明共享门对外部生效）；⑦ 关外部→内置仍 attached 且能 evaluate（ref-count 未误杀）；⑧ 全 release→`isAttached()===false`，再 acquire→重 attach 仍只一次、无 already attached；⑨ 意外 `dbg.detach()` 后 acquire→干净重 attach；⑩ audit 含 `cdp-ws-open` + share 标记、**无** `cdp-ws-deny reason:'attach'`。

> **对工单框架的修正**：根因不是「外部 CDP vs 内置自动化」，而是**三个内部调用点各自 create-and-attach 私有 session**。集中 attach 一举修复外部共存 + 两处既有内部相撞。设计围绕 `detach` 事件，而非假设的 RFH 拆解。

---

## Part C · token 轮换（OQ-23）—— ✅ 已实现（2026-10-09）

**现状**：`http-api.js`/`ws-api.js`/`cdp-ws.js` 构造期捕获 `token`/`readToken`/`jwtSecret` 为字符串并逐请求比对；无过期/吊销/轮换，改 token 需重启。

**设计（无新依赖）**：
1. **间接层**：`createTokenStore({token,readToken,jwtSecret,graceMs})` → `verify(got)->{role:'admin'|'viewer'|null}` + `rotate(...)`；http/ws/cdp 改调 `creds.verify(got)`。向后兼容：传字符串即包成单条 store，现有调用/测试不变。
2. **轮换流**：`POST /api/automation/token/rotate`，需显式 `Automation.Admin` JWT（仅持 bearer 不够，同 trust 铸造规则）；body `{newToken?,jwtSecret?}`，缺省服务端生成；新 token **只返回一次**；audit `{type:'token-rotate',by:sub}`（**不含值**）。
3. **宽限窗口**：新 token 为 current，旧 token 为 previous + `graceUntil=now+graceMs`（默认 60s，`FP_AUTOMATION_TOKEN_GRACE_MS`）；`verify` 接受 current 或未过期 previous（惰性驱逐）。`readToken` 独立轮换；`jwtSecret` 轮换期旧密钥仅用于 verify、新密钥用于签。
4. **存储**：current 凭据落 `<dataDir>/automation-credentials.json`（0600，存 `sha256(token)`）；优先级 env > file > generated；env 设置的 token 保持权威且内存态（除非 `FP_AUTOMATION_TOKEN_FILE` opt-in）。
5. **迁移**：若 `FP_AUTOMATION_TOKEN` 已设→作为初始 current、**不自动轮换**（opt-in）；若都无→首次启动生成 + 写 file（0600）并打印一次（今天行为），但现**跨重启稳定**。

安全：轮换仅 loopback + admin；保留常数时间比较；audit 永不记 token 值。

---

## Part D · 可配置 data-dir（OQ-19）—— ✅ 已实现（2026-10-09）

**现状**：用 Electron 默认 `userData`（`%APPDATA%\<appName>`），全仓无 `app.setPath('userData')`；`persist:auto-<id>`（`launcher.js:27`、`profile-manager.js:132`）物化为 `<userData>/Partitions/<encoded>`。独立服务用 `FP_AUTOMATION_STORE`/`os.tmpdir()`。

**设计**：
1. **配置面**：Electron：`--user-data-dir=<path>`（Chromium 原生支持）或 `FP_DATA_DIR`；优先级 CLI > env > default。独立：`FP_AUTOMATION_DATA_DIR`（默认 `os.tmpdir()`），派生 store/audit/凭据路径。
2. **时序约束**：`setPath` 必须在 main 入口**最顶**、`app.whenReady()` 前、任何 window/partition/`getPath('userData')` 前（`Client/main.js`/`MClient/main.js`）。
3. **迁移**：首次启动若新目录空且旧默认存在→**复制**（绝不移动/删除）`Partitions/` 子树 + 状态文件；写 `<newDir>/.fp-data-migrated-from` 防重复；`FP_DATA_DIR_MIGRATE=copy|move|none`（默认 `none`）。需 app 完全停止（LevelDB 锁）。只读目标/磁盘不足→**快速失败**，绝不静默回退默认（会分裂数据）。
4. **与 `persist:` 交互**：分区名**相对当前 `userData`**，故 relocate 原子移动全部分区、**不改分区名、不改 `persist:auto-<id>` 派生**（保 H2 冻结不变量与「派生、非内存」规则）；迁移 `Partitions/` 即保 cookie，跳过则 profile 呈登出态（同 id，无损坏）。**不要**改绝对分区路径。
5. **测试**：断言 `app.getPath('userData')` 在任何 window 前等于配置目录；扩展 `probe-coldstart-partition.js`（同配置目录冷启动后 cookie 可读）。

---

## 关联
- 规模/attach 结论回填 [11-open-questions.md](11-open-questions.md) §2 OQ-21/OQ-22、§7；可靠性约束见 [08-runtime-security-and-reliability.md](08-runtime-security-and-reliability.md)；架构集成见 [05-system-architecture.md](05-system-architecture.md)。
