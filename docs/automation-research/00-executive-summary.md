# 00 · 执行摘要（Executive Summary）

> 面向对象：产品/技术决策者与后续开发 Agent。
> 一句话：**8 款竞品把「用户代码」都放在浏览器之外，脚本版本管理/代码级编辑器/优先级调度/幂等语义/崩溃恢复是它们的共同空白；本方案在现有 Electron 指纹浏览器已建成的 main 进程自动化运行时之上，用「进程内 `webContents.debugger` + 按信任级分档的脚本隔离 + Monaco IDE + 版本化脚本 + 幂等任务」补齐这些空白，且不重造指纹内核。**

## 1. 八款竞品：谁最值得借鉴，借鉴什么

| 产品 | 最值得借鉴的点 | 证据 |
|---|---|---|
| **Multilogin** | 唯一「产品内置 Python Script Runner + `script_params` 传参」范式；automation token（长时效）与普通 token（30min）分离 | [03](03-competitor-technical-analysis.md) §1 |
| **GoLogin** | **最完整的开发者面**：官方 Node+Python SDK、3 个 CLI、MCP、Cloud Browser（远程 Chromium）、localStorage 原语、并发指引；**429 吊销 token** 的失败模式设计 | [03](03-competitor-technical-analysis.md) §2 |
| **AdsPower** | **运行/任务管理最深**：RPA Plus 可视化 + Execute-JS + 进程级 Timeout + 任务线程 ≤100 + 单任务 ≤5000 profile + 调度 once/daily/weekly/monthly | [03](03-competitor-technical-analysis.md) §3 |
| **Dolphin Anty** | 双面 API（本地 v1.0 + 远程 v2 OpenAPI）+ 机器可读文档（llms.txt/openapi.yaml）+ 官方 MCP 路径 | [03](03-competitor-technical-analysis.md) §4 |
| **Incogniton** | 官方 SDK/CLI/MCP 全套 + **per-profile 锁文件**隔离语义 + 「明确声明不幂等」的诚实文档 | [03](03-competitor-technical-analysis.md) §5 |
| **Octo Browser** | **one-time 临时 profile**（用完即焚、4× 计费）+ 请求加权限流 + Action Log WS（watermark 续传）+ Docker/K8s 配方 | [03](03-competitor-technical-analysis.md) §6 |
| **Undetectable** | 最小执行闭环（`browser/*` 原生端点：opentab/openurl/click/fill/evaluate/screenshot）+ WebEngine 页面脚本 | [03](03-competitor-technical-analysis.md) §7 |
| **MoreLogin** | **最完整的可靠性语义**：53 操作重试/完成矩阵、业务码错误目录、零知识加密同步、Free 即含 Local API、内置 MCP/CLI | [03](03-competitor-technical-analysis.md) §8 |

**共识借鉴（跨产品）**：①「厂商 API 管实例 → 返回 CDP/WebDriver 句柄 → 框架接管页面」的两段式；②本地回环 API + 云端 token 双面；③内存账（300–500MB/profile）反推并发；④一次性 profile；⑤429 指数退避 + 抖动。

## 2. 最适合当前 Electron 指纹浏览器的脚本执行架构

**推荐（唯一）**：
- **页面控制**：默认 **进程内 `webContents.debugger`**（浏览器级 CDP，省掉竞品必有的外部进程/端口层）；外部/远程场景用 **raw CDP over loopback WS**；**Playwright `connectOverCDP` / Puppeteer / Selenium 仅作可选兼容 Adapter**。
- **脚本运行时**：可信脚本沿用 **`node:vm`**（并显式声明其非安全边界）；不可信脚本升级 **`utilityProcess`**。
- **可视化**：复用 **RPA→AST 同一运行时**，不引入第二套引擎。
- **编辑器**：**Monaco + `automation.d.ts`**（类型即权限面）。
- **存储**：首期 JSON + 快照，DB（SQLite 12 表）为后续。

对比与评分见 [04-automation-technology-selection.md](04-automation-technology-selection.md)；架构见 [05-system-architecture.md](05-system-architecture.md)。

## 3. 首期 vs 后续

| 阶段 | 首期（P0–P4） | 后续（P5–P10） |
|---|---|---|
| 核心 | DB/shared-core 抽取、`persist:` partition、IPC sender-check/URL gate、permission deny-list、Runtime 骨架、脚本 CRUD+版本、SDK→Adapter 最小 API、smart waits、error taxonomy、本地 Queue/Worker、retry/backoff | FingerprintBroker 原子切换、localhost REST/WS/CLI 统一、cron scheduler + crash recovery、Monaco IDE + RPA→AST + templates、RBAC + secret vault + 3 级日志、`connectOverCDP` 兼容 + remote worker + AI Agent |

排期、交付物、依赖与验收见 [10-implementation-roadmap.md](10-implementation-roadmap.md)。

## 4. 关键技术风险与验证方法

| 风险 | 验证方法 |
|---|---|
| `node:vm` 逃逸（非安全边界） | 红队脚本实验 + `utilityProcess` 原型（[11](11-open-questions.md) OQ-15/16） |
| 指纹四平面无法原子切换 | FingerprintBroker 原型 + 失败回滚（OQ-17） |
| Client/MClient 会话模型互斥 | 先抽象 Session 接口，shared core 只抽纯函数（OQ-18） |
| 无 DB 状态易失 | 定时快照 + 启动恢复先行（OQ-20） |
| 打包 ESM/CJS 陷阱 | `Client/test-packaged-automation.js` 守护（OQ-24） |
| 规模（100k/1M） | 造数压测 + 索引验证（OQ-21） |

## 5. 交付文档路径

目录：`docs/automation-research/`

| # | 文件 | 内容 |
|---|---|---|
| 00 | [00-executive-summary.md](00-executive-summary.md) | 本文件 |
| 01 | [01-source-catalog.md](01-source-catalog.md) | 8 款竞品官方资料索引（URL/访问日期/证据位置） |
| 02 | [02-competitor-matrix.md](02-competitor-matrix.md) | 竞品功能矩阵（7 域 × 8 家，来源/未知标记） |
| 03 | [03-competitor-technical-analysis.md](03-competitor-technical-analysis.md) | 机制分析 + A/B/C/D 证据等级 + 最小验证实验 |
| 04 | [04-automation-technology-selection.md](04-automation-technology-selection.md) | 技术选型（≥2 路线 + 10 维评分 + ADR） |
| 05 | [05-system-architecture.md](05-system-architecture.md) | 系统架构与模块边界（Mermaid） |
| 06 | [06-script-sdk-specification.md](06-script-sdk-specification.md) | 脚本 SDK 规范 + 示例 |
| 07 | [07-data-model-and-api.md](07-data-model-and-api.md) | 数据模型与 API 设计 |
| 08 | [08-runtime-security-and-reliability.md](08-runtime-security-and-reliability.md) | 安全、隔离、异常与可靠性 |
| 09 | [09-test-and-acceptance-plan.md](09-test-and-acceptance-plan.md) | 测试方案与验收标准 |
| 10 | [10-implementation-roadmap.md](10-implementation-roadmap.md) | 分阶段开发计划 |
| 11 | [11-open-questions.md](11-open-questions.md) | 未决问题、假设与验证方式 |
| 12 | [12-api-surface-design.md](12-api-surface-design.md) | 产品架构：能力域 → API 封装（分层/命名/版本/能力协商/覆盖度） |
| 13 | [13-ux-interaction-design.md](13-ux-interaction-design.md) | 交互与体验设计（面板→全屏工作台、7 条任务流、双人群衔接、可访问性） |
| 14 | [14-external-sdk-design.md](14-external-sdk-design.md) | 外部可组合 SDK（搭积木、分层包 @fp-automation/*、DI、版本协商） |
| 15 | [15-visual-scripting-environment.md](15-visual-scripting-environment.md) | 可视化脚本环境（节点分类法/AST/代码双向/录制/调试） |
| 16 | [16-zero-runtime-distribution-constraints.md](16-zero-runtime-distribution-constraints.md) | 零外部解释器分发约束（应用内嵌基底、范围界定、验证） |
| 17 | [17-resilience-and-attach-design.md](17-resilience-and-attach-design.md) | 韧性加固与 attach 共享（executions 上限**已实现**；attach broker / token 轮换 / data-dir 设计） |

> 与既有 `docs/automation/`（21 篇内部设计/状态文档）的关系：本目录是**面向调研与交付**的整合版；每篇含「与 docs/automation 的关系」delta 小节，说明新增/修改/废弃。内部实现细节以 `docs/automation/` 与代码为准。

### 设计深化文档（12–15）的一句话定位

- **12 产品架构视角**：把全部浏览器能力分解为 10 个能力域 × 8 个命名空间域，统一超时/取消/重试/错误/权限/批处理，给出「能力→命名空间→方法→实现锚点」总表与覆盖度检查（含 as-built 缺失项）。
- **13 交互视角**：在既有 `automation-panel`（420px 面板）+ 全屏 `aw-` 工作台上演进；7 条任务流（首启/编写/运行监控/调度批量/绑定参数/历史产物/录制编排），四态齐全，双人群（可视化/代码）同一资产。
- **14 SDK 视角**：SDK 全部**外部化**为 npm/pip 薄客户端（`@fp-automation/{core,browser,tasks,rpa,visual}`），**零浏览器逻辑**；用户用「原子操作→组合器→预置块」搭积木组装业务；含依赖注入、版本握手、分发与许可。
- **15 可视化视角**：演进既有 RPA builder，**AST 单一真相源**，节点=API 调用封装，green/red 双出口，受限子集代码↔AST 双向；观感/交互委派 13，技术结构在本文。

## 6. 尚未解决的问题与下一步

- **未决项**：见 [11-open-questions.md](11-open-questions.md)（14 项竞品未决 + 10 项内部未决 + 10 条来源冲突）。
- **下一步**：①取证 OQ-1/3/4/5/9/11/12（需真实账号）；②原型 OQ-16/17/18/19/22；③专项确认 OQ-13（init/cleanup 钩子是否为行业空白）；④OQ-21 规模压测。

## 7. 合规边界（user spec §11）

本方案的自动化能力面向**获得授权的测试、运营与重复性业务流程**；**不**把规避网站访问控制或绕过安全验证作为默认设计目标。竞品调研仅提炼公开接口形态，不复制任何竞品实现代码或私有协议。
