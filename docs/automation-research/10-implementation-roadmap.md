# 10 · 实施路线图（Automation 研究 + 设计包）

> 性质：**实施计划 + 现状对齐**。定位：以 `automation-gap-analysis.md` 的 **P0–P10** 为主干，把「目标设计」与**已落地现实**逐阶段对齐，标出 已完成 / 部分 / 未开始 并绑**证据指针**；再给兼容性改造、架构阻塞项、依赖评估与**开发 Agent 可执行的下一步**。
> 口径：状态只写可复核证据（引实跑 PASS 数 / 文件锚点）；不把设计当已实现。上游：user spec §39（阶段）、`automation-gap-analysis.md` §3/§5/§6、`acceptance.md`（34 行矩阵）、`testing.md`（475 PASS）、`docs/automation/` 文档状态索引。
> 同包：`./05-system-architecture.md`、`./06-script-sdk-specification.md`、`./07-data-model-and-api.md`、`./09-test-and-acceptance-plan.md`；同包编号 00–11，本文件为 **10**。

---

## 1. 分阶段计划 P0–P10（含 as-built 现实）

> 状态图例：**✅ 已完成**（功能到线且有实跑证据）／**🔶 部分**（功能在、形态或边界未达设计）／**⬜ 未开始**。
> 「存储形态」列说明：仓内实际用 **JSON 文件 + 内存态**（`script-store.js` 头注释：*swap to SQLite at database.md when 10k scripts land*），`database.md` 的 SQLite 12 表为**未实现设计**。
>
> **分发硬约束（见 [16](16-zero-runtime-distribution-constraints.md)）**：任何阶段都不得让**应用自身**依赖系统 `node`/`python` 或第二解释器；应用运行时基底仅限 Electron 内嵌（用户自带的外部 SDK 环境不受此限）。

| 阶段 | 目标 | 交付物 | 依赖 | 验收标准 | 风险 | **状态** | 证据指针 |
|---|---|---|---|---|---|---|---|
| **P0** | DB + shared core + `persist:` partitions + IPC sender-check/URL gate + permission deny-list | launcher persist / IPC 门 / deny-list；SQLite | B3、B4 | 三开口堵死、partition 重启存活 | 一次性收紧打断探针 | **🔶 部分** | ✅ `launcher.js` `persist:auto-*`（smoke 24/24 relaunch cookie）；✅ IPC `checked()` Client 20+/MClient 37（copy-sync 21/21）；✅ deny-list（`troubleshooting.md` §3）；⬜ DB（`script-store.js` 仍 JSON）；🔶 shared core 有意未合（B1） |
| **P1** | Runtime 骨架（Automation/Script/Task/Profile/Session managers）+ scripts/versions/params 表 | 5 manager + 表 | P0 | manager 可编排、版本/参数可用 | 存储形态易失 | **🔶 部分** | ✅ `automation-manager.js`/`script-store.js`/`task-queue.js`/`profile-manager.js`/`browser-session.js`（manager 11 / store 13 / profile 17）；⬜ SQLite 表 |
| **P2** | SDK→Adapter + Browser/Page/Element/Cookie/Storage 最小 API + smart waits + error taxonomy | `page.js`/`browser-api.js`/`executor.js` | P1 | page 全 ops 真链路、错误分类 | CDP 面越权 | **✅ 已完成** | smoke 24/24、script-e2e 17/17、browser-api 14、core 16（allowlist）；`acceptance.md` #12–#14 |
| **P3** | Network/Download/Upload/Dialog + screenshot/trace + executions/logs 表 | 上述 API + 取证 | P2 | 四 API 到线、失败取证 | 拦截能力越权 | **🔶 部分** | ✅ Download/Upload（smoke、browser-api 14 围栏）、Network read ring cap 200、screenshot/trace（forensics 12、script-e2e 17/17）；⬜ Dialog（`page.js` 无 dialog 面）；🔶 intercept 未授权接线；⬜ SQLite 表 |
| **P4** | Queue/Worker（local）+ tasks/items/workers/variables 表 + 状态机 + retry backoff | `task-queue.js`/`worker.js` | P3 | 12 态机、背压、重试 | 同 profile 并行写 | **✅ 已完成**（存储 JSON） | queue 22、worker 18、scheduler 11、stress 2、real-stress 8/8×4；remote worker 接口 ⬜ |
| **P5** | FingerprintBroker（原子切换 + Bearer）+ `fingerprint.update` 门控 | `profile-manager.js` broker | B2 | 四平面原子、H2 冻结诚实 | 指纹回归 | **✅ 已完成** | profile 17（broker 五门 + rotate + H2 预检）；cli 23、ipc 18 |
| **P6** | localhost REST 网关 + WebSocket + CLI 同 Service Layer + audit | `http-api.js`/`ws-api.js`/`cli.js`/`audit-log.js` | P4 | 六关卡、三传输一致 | 鉴权绕过 | **✅ 已完成** | http 27、ws 6、cli 23、audit-log 9、serve 9；`acceptance.md` #23–#24、#28 |
| **P7** | cron scheduler + schedules 表 + crash recovery 7 步 | `scheduler.js` + 恢复编排 | P4 | 时区/catch-up、7 步闭环 | 少跑/漏跑 | **✅ 已完成**（存储 JSON） | scheduler 11；worker 18（步 1–4 + 步 6 relaunch）；audit 9 + metrics 9（步 5/7）；`troubleshooting.md` §5 #22 |
| **P8** | Monaco + `automation.d.ts` + RPA→AST + templates（含 marketplace reserved） | IDE/RPA/templates | P6 | 编辑/录制/模板可用 | 离线资产管道 | **🔶 部分** | ✅ `automation.d.ts`、rpa-ast 16、rpa-recorder 27、templates 9+7、live-recorder 12、recorder-control 7/7；**Monaco waive**（hook + textarea 回退，`acceptance.md` §5） |
| **P9** | RBAC + secret vault + 3-level logs + 100k/1M 归档 | JWT/vault/logs | P6 | 权限命名、secret 不可 grep | 规模性能 | **🔶 部分** | ✅ RBAC（jwt-claims 21）；🔶 secret 名+值双 scrub（runner 31）但**无落库加密 vault**；🔶 3-level 由 audit 收集器覆盖（audit-log 9），独立 system 表未建；⬜ 100k/1M 归档 |
| **P10** | Playwright `connectOverCDP` + remote worker 接口 + AI Agent 预留 + observability 验收 | CDP 桥/agent/metrics | P7 | 外部可接、observability 必答 | 依赖 vendoring | **🔶 部分** | ✅ CDP 桥（cdp-ws-client 11/11、cdp-server 10/10）、AI agent 桥（MClient `test-agent-engine.js` 49）、observability（metrics 9 / serve 9）；🔶 playwright **不 vendored**（用户侧自装，`testing.md` §3）；⬜ remote worker 接口 |

**汇总**：✅ 4（P2/P4/P5/P6/P7 中 P4/P5/P6/P7 功能完成，P2 完成）——功能面 6 阶段完成、4 阶段部分、0 未开始；**唯一系统性缺口 = SQLite 持久层（B4）**，其余 🔶 为「形态 waive」或「单点边界」。

---

## 2. 兼容性改造计划

> 源：`automation-gap-analysis.md` §3。三类互斥，逐项标**当前落地状态**。

| 类别 | 项 | 当前状态 | 证据/锚点 |
|---|---|---|---|
| **复用**（不动行为只接线） | Browser/Profile/Fingerprint 生命周期 | ✅ 已接线 | launcher persist、profile 17 |
| | `fpSplitConfig`/validate（`fp-schema.js:979`） | ✅ | core 16（FP scrub）、acceptance #34（指纹零改动） |
| | MClient proxy + login 流程 | ✅ 复用 | 未改行为 |
| | mini-browser 顺序 H2→UA→TLS | ✅ 复用 | `troubleshooting.md` §2 |
| | preload invoke-only 形态 + 现有 channel 名 | ✅ 复用 | ipc 18、wire 10 |
| **重构**（改实现保接口） | shared core：抽 Client/MClient 公共（**禁 naive merge**） | 🔶 有意暂缓 | B1；`acceptance.md` §3 |
| | `persist:` partitions + data-dir 可配 | ✅ 已落地 | launcher `persist:auto-*`；data-dir 待配 |
| | permission deny-list（替代 allow-all） | ✅ 已落地 | `troubleshooting.md` §3 #14 |
| | IPC sender-check + URL gate | ✅ 已落地 | Client 20+/MClient 37 `checked()` |
| **新建** | FingerprintBroker（原子 + Bearer） | ✅ 已建 | profile 17 |
| | localhost REST 网关（127.0.0.1 + Host/Origin + triple-return + 持久 session + bulk + audit） | ✅ 已建 | http 27、serve 9 |
| | Automation Runtime + Monaco IDE + RPA AST + scheduler + observability | ✅ 功能已建（Monaco waive） | 见 §1 P2–P8 |

---

## 3. 架构阻塞项 B1–B4 与解决顺序

| 阻塞 | 问题 | 推荐方案 | 当前状态 | 依赖顺序 |
|---|---|---|---|---|
| **B3** IPC/CDP 默认信任 renderer | IPC 无 sender-check、`wc.debugger` 无鉴权转发 | (b) deny-list + sender-check 先行，allowlist 逐批加 | **✅ 已收口** | **第 1**（安全前置，P0） |
| **B4** 无 DB 导致状态易失 | profiles.json + 内存 partition + jsonl，重启即丢 | (b) SQLite 先行、表结构按 100k/1M 预留索引 | **⬜ 未落地**（JSON 仍） | **第 2**（解 P0/P1/P3/P7/P9 形态） |
| **B2** 指纹四平面无原子切换 | Blink/UA/TLS/H2 各自独立设，中途切换产生混合身份 | (b) FingerprintBroker 原子编排 + 失败回滚 + Bearer | **✅ 已收口** | **第 3**（P5） |
| **B1** 双客户端模型不兼容却 80% 重复 | Client（per-tab）vs MClient（per-group）会话模型互斥 | (b) 先抽象 Session 接口、shared core 只抽纯函数 | **🔶 有意暂缓**（未 naive merge） | **第 4**（P4 之后） |

**解决顺序裁定**：B3 → B4 → B2 → B1。理由：安全开口必须先堵（B3 已完成）；持久层是所有状态型阶段的公共前置（B4 是当前唯一系统性缺口）；指纹原子性独立且已闭环（B2）；会话合并风险最高且非阻塞，放最后（B1）。

---

## 4. 关键依赖：维护状态 / 版本兼容 / 许可评估

| 依赖 | 角色 | 版本/内置 | 许可 | 维护状态 | 风险与裁定 |
|---|---|---|---|---|---|
| **`node:vm`** | 脚本沙箱执行 | Node 内置（随 Electron） | 随 Node（MIT 系） | 随运行时 | **非硬安全边界**，ceiling = 同进程逃逸（`script-sandbox.md` §4）；团队内脚本可接受，陌生人脚本升级 `utilityProcess/worker` + structured clone。无第三方版本风险 |
| **Monaco Editor** | IDE 编辑基座 | **未 vendored** | **MIT** | 活跃 | 离线资产管道缺失；CDN 违反单机离线姿态 → **waive bundle 形态**，仅留 `__mountMonaco` hook + textarea 回退（`acceptance.md` §5）。功能面已覆盖 #1/#2 |
| **Playwright**（可选 Adapter） | 外部 `connectOverCDP` | **未 vendored** | **Apache-2.0** | 活跃 | 不 vendored 是**策略**（ADR-3 不开 debug port；用户侧自装）。低保真：通常只见 `contexts()[0]`、`close()` 默认不杀底层浏览器（`troubleshooting.md` §4 #21）。进程内 SDK 不受影响 |
| **Puppeteer**（可选 Adapter） | 外部 CDP 客户端 | **未 vendored** | **Apache-2.0** | 活跃 | 同上；经 `cdp-ws.js` 标准 `connectOverCDP` 兼容 |
| **Selenium**（可选 Adapter） | 外部 WebDriver 客户端 | **未 vendored** | **Apache-2.0** | 活跃 | 需 WebDriver 协议层，非本仓 CDP 桥直接覆盖；列为可选 Adapter 远期项 |
| **npx** | 包执行 | — | — | — | **禁用**（静默拉取执行任意包，`AGENTS.md` §2）；用 `node_modules/.bin/` 或 `yarn <tool>` |

**兼容性裁定**：运行时**零第三方依赖**（仅 `node:vm` 内置），与「单机离线 + 无鉴权端口」姿态一致；Playwright/Puppeteer/Selenium 一律**用户侧自装**、经 `cdp-ws.js` 的 loopback+token+Host 三门接入，本仓不引入其版本锁定。

---

## 5. 每阶段可交付 / 可验证 + 开发 Agent 下一步

| 交付 | 可验证命令/判据 |
|---|---|
| 全量 Unit | §09 §1.2 循环脚本，`FAIL=0` 且 exit 全 0 |
| 打包守护 | `node Client/test-packaged-automation.js` → 12 检查全过 |
| 面板三测 | `node Client/run-tests.js test-automation-panel.js`（19）/ `-bridge.js`（6）/ `-degrade.js`（5） |
| 指纹静态门 | `python fingerprint/scripts/check.py` → exit 0 |
| E2E 真链路 | `node Client/run-tests.js <probe-*.js>`（先自动 stash `resources/app`） |

**开发 Agent 可直接执行的下一步（按优先级）**：

1. **N1 · 落 SQLite（解 B4，最高杠杆）** — 以 `database.md` 12 表替换 `script-store.js` 的 JSON 持久层；保留现有 store 接口签名（保接口改实现），跑 `test-script-store.js` 13 + `test-integration.js` 8 回归。**验收**：重启后 scripts/versions/params/executions/logs 全存活；`test-stress.js` 100×10 仍 p99<500ms。
2. **N2 · Dialog SDK 面（补 P3）** — 在 `electron/page.js` 增 dialog 处理（`Page.javascriptDialogOpening` + `Page.handleJavaScriptDialog`），绑定 `browser-api.js`；新增 `automation/test-*.js` 并扩 smoke 探针。
3. **N3 · Network intercept 授权接线（补 P3/#17 边界）** — 按 capability 授权开放 `Network.setRequestInterception`/`Fetch` 改写，过 allowlist + 审计。
4. **N4 · secret vault 加密落库（补 P9）** — 在 N1 的 params 表上加静态加密 + 解密仅在 runner 注入时；保持日志双 scrub 不回归。
5. **N5 · remote worker 接口（补 P10）** — 定义 remote worker 与 local 同接口（`worker.md`），先留接口不实现远端。
6. **N6 · shared Session 接口抽取（解 B1，最后）** — 先抽象 Session 接口，shared core 只抽纯函数，**禁 naive merge**。

---

## 6. 与 `docs/automation` 的关系（delta）

| 类别 | 内容 |
|---|---|
| **NEW（本包新增）** | ① P0–P10 逐阶段的 **as-built 状态列 + 证据指针**（`docs/automation` 的 `automation-gap-analysis.md` 只有目标态与 §5 阶段清单，无逐阶段落地状态）；② **B1–B4 解决顺序裁定**（B3→B4→B2→B1）；③ 关键依赖的**许可/维护/版本兼容表**（`docs/automation` 未单列）；④ 面向开发 Agent 的 **N1–N6 下一步**（含验收判据）。 |
| **MODIFIED（口径纠正）** | 把「阶段已完成」的笼统印象按证据收敛为：**功能面 P2/P4/P5/P6/P7 完成，P0/P1/P3/P8/P9/P10 部分**；核心修正是 **P0/P1/P3/P7 的「存储形态」为 JSON 而非 `database.md` 的 SQLite**（B4 未落地）。 |
| **DEPRECATED（不再引用）** | `automation-gap-analysis.md` §5 的 P0–P10 纯目标态描述，由本文件 §1 的 as-built 表取代；`database.md` 12 表在落地前仅作**设计目标**，不得据其声称「已实现」。 |
| **不变（复用）** | P0–P10 的阶段划分、`automation-gap-analysis.md` §3 兼容三类、§6 B1–B4 的问题/原因/可选方案**逐项复用**，仅补状态与顺序。 |
