# 11 · 未决问题、假设与验证方式（Open Questions）

> 本文件是**未决项登记与核查结果**的唯一归口。
> **2026-10-09 二次核查**：竞品侧 OQ-1…14 与内部侧 OQ-15…24 均已逐条核查（竞品=4 lane 公开源检索；内部=只读代码审计）；设计深化项 N1…N7 给出建议裁决。冲突项 §4 已裁决。
> 等级：A 官方证实 · B 官方示例/代码可验证 · C 推断 · D 证据不足。

## 1. 竞品侧未决问题——核查结果（2026-10-09）

**结论：14 项中 12 项已确认/已裁决；仅 1 项硬残余（OQ-2，文档空白）+ 1 项可选行为验证（OQ-8）。**

| # | 问题 | 结论 | 等级 | 残余（2026-10-09：竞品侧改用文档定论） |
|---|---|---|---|---|
| **OQ-1** | Multilogin 基址 `.com` vs `.org` | 两域均活、同一 API（live probe 逐字节相同 400）；用 `.com`，`.org` 为别名 | A/B | 无 |
| **OQ-2** | ML Script Runner 依赖/超时/多文件 | **官方文档完全空白**（请求体仅 `script_file`/`object_id`/`is_builtin`/`profile_ids[]`/`script_params[]`，无 timeout/requirements/多文件字段）；自定义 Python 脚本被官方划为**独立路径**，非 Script Runner 能力 | D | 无（文档未明确，D；按用户口径不再用账号） |
| **OQ-3** | GoLogin RPM | 权威 **300/500/800/1200**（定价分档 2026-08-10）；rate-limits「1200」过时 | A | 无 |
| **OQ-4** | AdsPower 限流 | 权威 **5/15/25 req/s**（=300/900/1500 req/min，v8.7.23 2026-09-23）；5 端点仍 1 req/s；localapi-doc 静态页仍旧值（stale） | A | 无 |
| **OQ-5** | Dolphin 并发天花板 | **付费档无软件层并发上限**（官方明写「无并发数限制，取决于机器性能」）；**Free=3** | B | 无 |
| **OQ-6** | Octo one-time | **确认** 4× 计费 + 停止即自动删除（不进 List/Trash） | A | 无 |
| **OQ-7** | Octo Profile Tasks 档位 | 现行 **Base+**（Team+ 是 2024-08 旧博客，已被 2024-09 取代） | A/B | 无 |
| **OQ-8** | Incogniton 本地 API 鉴权/绑定 | **免 token 确认**；文档一致 `127.0.0.1:35000`，**唯一可配的是端口**（无 host/bind 参数）→ 文档口径=**仅 loopback** | A/B | 无（文档口径=环回；不再用账号） |
| **OQ-9** | Incogniton Synchronizer 上限 | 权威 **5（1+4）**，Windows only；「20」为营销软性 | A | 无 |
| **OQ-10** | Undetectable 鉴权/门槛 | **无 token 确认**；**Base+ 可用**（Free 不可，定价页为准）；仅 Chromium 核 | A/B | 无 |
| **OQ-11** | MoreLogin 创建量 | **Local 1–50 / Open API 1–200**（Local 页「1–200」为误抄） | A | 无 |
| **OQ-12** | MoreLogin 本地 API 限流 | **无固定文档数字**：官方明确 localhost Local API **不经网关**、限额「取决于客户端与被调操作」；120/min 为过时旧文；网关 GCRA 200/min 仅适用 Open API | B | 无（文档明确；不再用账号） |
| **OQ-13** | 8 家 init/cleanup 钩子 | **8 家皆无**真正 on-start/on-close 脚本钩子（仅替代品：runbook/CookieRobot closeBrowser/after-task/Stop 块/autoOpenUrls/启动 flags/手动脚本） | B | 无 |
| **OQ-14** | GoLogin storage 导出范围 | CLI `storage-export/import/clear` 仅覆盖 **localStorage/sessionStorage**（`--scope local\|session\|both`），**不含 IndexedDB**；SDK 无 storage 导出（仅 cookie）；IndexedDB 仅 profile 级 `storage.indexedDb` 布尔开关（默认关） | B | 无（文档明确；不再用账号） |

> 方法披露：仅 OQ-1 用 live probe；其余官方文档/定价页/发布说明/官方仓库源码交叉印证；**无账号登录、无端口暴露**。**2 处官方自相矛盾**已记档：Undetectable plans 页（取定价页/Free 排除条款）；MoreLogin 新版指南 vs 旧 support 文（取新）。**2 处 stale 官方静态页**勿引用：AdsPower localapi-doc（旧 2/5/10）、Octo 2025-11 旧博客（称本地不计限额，与现 rate-limiting.md 冲突）。

## 2. 内部设计侧未决问题——核查结果（2026-10-09）

**结论：10 项全部闭合——7 项由代码裁决（CLOSED）；R6–R10 五项运行时实验（2026-10-09）闭合了 OQ-16/17/19/21/22 的残余；OQ-15 经用户决定暂缓（接受为已知风险）。**

| # | 问题 | 状态 | 结论 / 证据 | 残余 |
|---|---|---|---|---|
| **OQ-15** | `node:vm` 逃逸真实可利用性 | **暂缓（接受为已知风险）** | 代码声明非硬边界 + 已收紧（`script-runner.js:1`、`:437`）；红队实验**用户 2026-10-09 决定暂缓**，作为已接受风险 | 无（暂缓） |
| **OQ-16** | `utilityProcess` 承载可行性 | **CLOSED ✅ 可行** | `probe-utility-process.js` **6 PASS**：utilityProcess 内脚本经 `process.parentPort`↔`postMessage` 由 **main 代理**调 `webContents.debugger`，实测 `Page.navigate`+`Runtime.evaluate` 取回真实值；**约束**=仅结构化克隆 JSON 跨界、无 webContents/debugger 句柄、须 main broker | 无 |
| **OQ-17** | 指纹四平面原子切换 | **CLOSED ✅** | 无原子热切换（running→CONFLICT `:360`、H2 `everStarted` 冻结 `:367`、rotate=stop→update→start `:412`）；`test-rotate-rollback.js` **2 PASS**：**start 失败后无残留不一致**——rotate 先持久化新指纹、运行态落诚实 `error`、下次 start 重放新指纹（**不**回滚旧指纹，属设计） | 无 |
| **OQ-18** | Client/MClient 会话抽象 | **CLOSED** | 分歧量化：Client=`fp-tab-${tabId}`（1tab=1partition）、MClient=`fp-group-${groupId}`（Ntab=1partition）；**可抽=纯函数**（fpSplitConfig/applyTabUserAgent/applyTabTLSConfig/normalizeGroupProxy，已两份重复），**模型不可 naive merge** | 无 |
| **OQ-19** | `persist:` + data-dir | **CLOSED ✅** | `persist:auto-<id>` 已实装强制（`profile-manager.js:132`、`launcher.js:27,30`）；data-dir 不可配（无 `app.setPath('userData')`）；`probe-coldstart-partition.js` **3+1 PASS**：cookie **跨进程冷启动存活**（强于此前同进程证据） | 无 |
| **OQ-20** | JSON→SQLite 迁移窗口 | **CLOSED** | 迁移触发阈值代码注释写死=**10k scripts**（`script-store.js:1`）；写路径=整文件读入+全量重写（`:140,143`）、`list()` 无分页（`:214`） | 无（双写窗口为设计取舍） |
| **OQ-21** | 100k/1M 规模 | **CLOSED ✅** | `test-scale-latency.js` **3 PASS**：**保留容量下 <500ms 达标**（metrics/audit p99 0.2/0.4ms；executions p99 19.75ms）；**但** metrics/audit 环 cap=10000 → 100k/1M **静默丢弃**（retained 10000）；**executions 无上限**（持 100k、O(n) 列表、O(n²) `unshift`，seed 143s）= **真实扩展风险** | 无（风险已定位：需索引/归档 + executions 上限） |
| **OQ-22** | 外部 CDP attach 与 automation attach 共存 | **CLOSED ✅（冲突确认）** | `probe-attach-coexist.js` **4 PASS**：automation attach 后第二次 attach 抛 **"Debugger is already attached to the target"**；cdp-server 外部 WS 得 **HTTP 500** + audit `cdp-ws-deny` → **不可共存，必须共享单一 attach** | 无（转入设计：共享 attach/broker） |
| **OQ-23** | 本地 API token 轮换 / 最小权限 | **CLOSED** | IPC=**仅 sender-check**（`ipc-bridge.js:74`，无 token）；HTTP=静态 token 必填+RBAC(JWT)+loopback+Host 门（`http-api.js:229,467,591`）；WS/CDP-WS 同类门（`ws-api.js:171`、`cdp-ws.js:185`）；**最小权限已落地**；**token 轮换缺失**（token/readToken/jwtSecret 均构造期静态） | token 轮换待实现 |
| **OQ-24** | 打包 ESM/CJS | **CLOSED** | `automation/package.json:3` 树根 `type:commonjs`；守护 `Client/test-packaged-automation.js:58`（parity+断言+可加载）；`run-tests.js:46` 通配**自动收录**；troubleshooting §6 #26 记载 | 无（未打包时走 SKIP） |

## 3. 设计深化（12–16）未决项 N1…N7——已人工确认（2026-10-09）

| # | 裁决（已确认） | 备注 |
|---|---|---|
| **N1** | 采用 **10 能力域 × 8 命名空间域**（两套正交分解） | 用户确认 |
| **N2** | **`automation.d.ts` 为唯一 API 类型真相源**；codegen 派生「RPA 节点目录 schema + 外部 SDK 类型 + OpenAPI」，三者均为派生物、不手改 | 用户确认（最高优先） |
| **N3** | 包 `@fp-automation/{core,browser,tasks,rpa,visual}`；主传输 **HTTP(REST 命令)+WS(事件推送)**，CDP 仅页面级；Python=OpenAPI 生成薄客户端（次要、opt-in） | 用户确认 |
| **N4** | 保留现 26 节点兼容 + 注册表扩展；AST→代码始终可；代码→AST 仅受限子集（文档化） | 用户确认 |
| **N5** | 面板(F9) 保留快捷操作 + 全屏 `aw-` 工作台为主创作面，**叠加式**迁移 | 用户确认 |
| **N6** | **V1–V5 全部为验收门**（用户选更严方案：含干净机三链路 + 守护扩展 + 静态检查） | 用户确认（严于建议） |
| **N7** | 外部 SDK 与内置运行时**同一 `PermissionKey`/capability + 同一 Service Layer**，能力由 runtime 强制 | 用户确认 |

> 以上 7 项已从「未决」转为「已定」。**N2 为跨 12/14/15 一致性的基础**。

## 4. 来源冲突——裁决结果（2026-10-09）

| # | 冲突项 | 裁决 |
|---|---|---|
| CF-1 | Multilogin 基址 `.com`/`.org` | 两域均活、同一 API；用 `.com` |
| CF-2 | GoLogin RPM | 300/500/800/1200（rate-limits「1200」过时） |
| CF-3 | AdsPower 限流 | 5/15/25 req/s（旧文档/GitHub 过时） |
| CF-4 | AdsPower RPA 付费模板 | 仍 C（2022 新闻），不采信 |
| CF-5 | Incogniton Synchronizer | 5（1+4），营销「20」为软性 |
| CF-6 | Incogniton 框架支持 | 以新 SDK 文档为准 |
| CF-7 | Octo Profile Tasks | Base+ |
| CF-8 | Undetectable 计划门槛 | Base+（Free 不可） |
| CF-9 | MoreLogin 创建量 | Local 1–50 / Open 1–200 |
| CF-10 | MoreLogin 限流 | GCRA 200/min burst 10（120/min 过时） |

## 5. 残余未决与人工确认清单（2026-10-09；竞品侧 2026-10-09 二次修订）

> **竞品侧 R1–R4 改用官方帮助文档定论**（用户 2026-10-09：不再用账号，只调研帮助文档）。结论见下表；内部项 R5–R10 见 §2。

**竞品侧（文档定论）**

| # | 项 | 文档结论 | 等级 |
|---|---|---|---|
| R1 | OQ-2 Multilogin Script Runner 依赖/超时/多文件 | **官方文档未明确**：Script Runner 无 requirements/pip、无 timeout、无多文件文档；请求体仅单 `script_file`；只有手动 `script-stop`（装包只出现在「在 IDE 里跑脚本」与 Docker 进容器手装，非 Script Runner 机制） | D |
| R2 | OQ-8 Incogniton 本地 API 绑定 | **文档口径=环回、本机专用**：三处官方源一致 `127.0.0.1`/`localhost:35000`，**仅端口可改**，无 `--host`/`0.0.0.0`/bind 配置；文档未明文禁止非环回 | B |
| R3 | OQ-12 MoreLogin 本地 API 限额 | **文档明确**：guide 逐字「Local API 不经云网关，其有效限制取决于桌面客户端与被调操作」（无固定数字）；support 另载「每端点 120 次/分钟」但未区分 Local/Open（B） | A(+B) |
| R4 | OQ-14 GoLogin storage-export 范围 | **文档明确**：CLI `storage-export/import/clear` 的 `--scope` 仅 `local\|session\|both`，**不含 IndexedDB**（profile 级「存储同步」另含 IDB，与 CLI 导出是两回事） | A |

> 说明：R1 的 D 是「文档没写」，不等于「功能不存在」；R2 的 B 是「文档只描述环回、未显式禁止非环回」。二者已按用户口径定案（不追账号实测）。

**内部侧（人工确认结果 2026-10-09）**

| # | 项 | 确认方式 | 判定 | **确认结果** |
|---|---|---|---|---|
| R5 | OQ-15 `node:vm` 逃逸可利用性 | 红队脚本取宿主引用 | 取到 = 逃逸成立 | **暂缓（接受为已知风险）** |
| R6 | OQ-16 `utilityProcess` 可行性 | 原型：utilityProcess 跑脚本 → IPC → main 调 `webContents.debugger` | 脚本能驱动页面 = 可行 | **由我执行（原型）** |
| R7 | OQ-17 rotate 的 start-failure 回滚 | 制造 start 失败，验存储指纹/运行态一致性 | 无残留不一致 = 通过 | **由我执行（node 单测）** |
| R8 | OQ-19 跨进程冷启动 partition 存活 | 冷启动 app 后读同 id partition cookie | cookie 存活 = 通过 | **由我执行（Electron E2E）** |
| R9 | OQ-21 100k/1M 精确延迟 | 造数压测列表页 | <500ms = 达标 | **由我执行（造数压测）** |
| R10 | OQ-22 外部 CDP attach 与 automation attach 共存 | 同 profile 并发 attach | 冲突 = 需设计共享 | **由我执行（Electron E2E）** |

> **执行结果（2026-10-09）**：R6–R10 **全部闭合**（见 §2 OQ-16/17/19/21/22）；R5 暂缓。新增测试/探针：`automation/test-rotate-rollback.js`、`automation/test-scale-latency.js`、`automation/probe-utility-process.js`(+`-child`)、`automation/probe-coldstart-partition.js`、`automation/probe-attach-coexist.js`。

## 6. 关键假设（若被推翻需重估设计）

| # | 假设 | 依据 | 若推翻的影响 |
|---|---|---|---|
| A1 | 竞品脚本引擎都在浏览器外/客户端内 | [03](03-competitor-technical-analysis.md) §0 | 进程内路线仍成立 |
| A2 | `webContents.debugger` 覆盖所需 CDP 域 | 现状 page.js | 需补 raw CDP 桥 |
| A3 | 用户脚本主要为可信本机脚本 | 竞品模式 | 首期可先用 vm |
| A4 | 每 profile 内存约 300–500MB | GoLogin/AdsPower 官方 | 并发上限设计 |
| A5 | 无 DB 时 JSON+快照可支撑首期 | 现状 | 需提前上 DB |
| A6 | Monaco + `automation.d.ts` 足以提供 IDE | d.ts 已存在 | 需补类型生成管线 |

## 7. 下一步行动

1. ✅ **R6–R10 已执行并闭合**（见 §2）。
2. ✅ **N1–N7 已人工确认**（§3）。
3. ✅ **派生待办 ①–④ 已推进**（见 [17-resilience-and-attach-design.md](17-resilience-and-attach-design.md)）：① executions 上限 + O(1) 淘汰 **已实现**（`test-executions-cap.js` 4 PASS；seed 143s→1.22s；回归全绿）；② 单一 attach broker **已设计**（proxy-only；接口/生命周期/安全/三阶段/探针断言）；③ token 轮换、④ data-dir 可配 **已设计**。
4. **待实现（有设计、未落码）**：③ token 轮换、④ data-dir；① 的 env 可调接线。**② attach broker P1 已实现**（`probe-attach-coexist.js` 11 PASS，attach 计数==1；回归全绿；见 doc 17 §B.8）。
5. 竞品侧 R1–R4 因**无账号**关闭；全部并入 `Error_Ledger` 跟踪。

> 交付文档索引见 [00-executive-summary.md](00-executive-summary.md)。
