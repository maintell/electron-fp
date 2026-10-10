# 18 · 交付清单与验收（Delivery Manifest & Acceptance）

> 本文件是「自动化脚本系统多层封装 + 外部 SDK + 可用 MClient + 业务测试」的交付清单与验收命令。
> 验收脚本：`node sdk/test/acceptance.js`（断言全部交付物存在 + 各验证命令 exit 0）。
> 本文件**不覆盖**既有 `docs/automation/*`（内部设计/状态文档）；它只做交付对齐。

## 1. 交付物与验证命令

| 交付物 | 路径 | 验证命令 | 通过标准 |
|---|---|---|---|
| **SDK core**（回环 transport / 类型 / 错误映射 / capability 握手） | `sdk/core/` | `node sdk/core/test/smoke.js` | exit 0（11 PASS） |
| **SDK browser**（page/cookies/storage/network/download/upload/dialog 薄封装） | `sdk/browser/` | `node sdk/browser/test/smoke.js` | exit 0（8 PASS） |
| **SDK tasks**（queue/schedule/task 提交与轮询到终态） | `sdk/tasks/` | `node sdk/tasks/test/smoke.js` | exit 0（8 PASS） |
| **SDK rpa**（AST 构造/序列化，schema 同 `rpa-ast.js`） | `sdk/rpa/` | `node sdk/rpa/test/smoke.js` | exit 0（9 PASS） |
| **可用 MClient**（集成自动化栈 + preload facade） | `MClient/main.js` `MClient/preload.js` `MClient/test-automation-integration.js` | `node MClient/run-tests.js test-automation-integration.js` | exit 0（6 PASS） |
| **MClient 真实浏览器自动化**（脚本驱动 MClient 现有分组/标签，非纯脚本） | `automation/runtime/automation-manager.js`（runnerFactory 收 profileContext）· `MClient/main.js`（group/tab launcher 适配 + executor + attach-broker）· `MClient/test-automation-browser.js` | `node MClient/run-tests.js test-automation-browser.js` | exit 0（15 PASS） |
| **Client 真实浏览器自动化**（脚本驱动 Client 现有标签，非纯脚本） | `Client/main.js`（per-tab launcher 适配 + executor + attach-broker）· `Client/test-automation-browser.js` | `node Client/run-tests.js test-automation-browser.js` | exit 0（14 PASS） |
| **MClient 自动化 UI**（脚本编辑器/运行/模板面板移植进 MClient，与指纹面板互斥） | `MClient/renderer/automation-panel/` + `MClient/renderer/{index.html,app.js,style.css}` · `MClient/test-automation-panel.js` | `node MClient/run-tests.js test-automation-panel.js` | exit 0（24 PASS） |
| **脚本工作流（可视化 RPA）**（`window.rpaApi` 全接线：validate/save/load/replay/record） | `automation/runtime/rpa-service.js`（新）· `ipc-bridge.js`（+4 通道）· `wire.js`（挂 `service.rpa`）· `Client/preload.js`/`MClient/preload.js`（`rpaApi`）· `MClient/main.js`（recorder controller）· `MClient/test-automation-rpa.js` | `node MClient/run-tests.js test-automation-rpa.js` | exit 0（17 PASS） |
| **端到端业务套件**（CRUD/语法/运行/异常/超时/取消/多 profile/调度/导入导出/版本） | `automation/e2e/run-all.js` | `node automation/e2e/run-all.js` | exit 0（24 PASS） |
| **安全测试套件**（§8.4：未授权浏览器控制/跨 profile/越权文件/子进程/恶意脚本/secret 泄露/IPC 绕过/供应链/强制终止） | `automation/test-security.js` | `node automation/test-security.js` | exit 0（16 PASS） |
| **性能测试套件**（§8.3：冷/热启动、单实例、并发、日志写入、调度延迟、长时内存；**只测量不编造**） | `automation/test-perf.js` | `node automation/test-perf.js` | exit 0（20 PASS） |
| **总验收** | `sdk/test/acceptance.js` | `node sdk/test/acceptance.js` | exit 0 |

## 2. 架构定位（与既有运行时）

- SDK 是**外部薄客户端**，**零浏览器逻辑**：每个调用翻译成一次回环请求（HTTP REST 命令 + WS 事件推送），打到既有 main 进程运行时 `automation/runtime/*` + `automation/electron/*`（serve.js 暴露的 API）。
- MClient 集成复用 `automation/electron/wire.js` 的 `attachAutomation`（与 `Client/main.js` 同一接线），新增 `wireAutomation()` + `automationApi` preload facade。
- **MClient 真实浏览器自动化**：`wireAutomation()` 用 `createElectronLauncher`-风格的 **group/tab launcher 适配器**（`acquire(groupId)` 返回该组活动标签的 `{window, webContents, electronSession}`）+ `createElectronExecutor` + `createAttachBroker`（每 webContents 单一 attach）；`automation-manager` 把 `profileContext` 传给 runnerFactory 以按运行派发到对应组。脚本因此能对**真实 MClient 标签页**做 goto/click/fill/getText/cookies/storage/network（`test-automation-browser.js` 断言真实 DOM 与 cookie 往返、且活动 webContents 真的导航了）。
- RPA 层与运行时**共享同一 AST schema**（`automation/runtime/rpa-ast.js`），无第二运行时。
- 遵循分发约束（doc 16）：**应用自身零外部解释器**；SDK 面向自备 Node/Python 的集成者。

## 3. 一键验收

```powershell
# 全部（含 Electron MClient，约 1 分钟）
node sdk/test/acceptance.js

# 跳过 Electron 部分（仅 SDK + e2e）
$env:FP_ACCEPTANCE_SKIP_ELECTRON='1'; node sdk/test/acceptance.js
```

## 4. 相关文档

- 调研与技术设计：[00-executive-summary.md](00-executive-summary.md) … [17-resilience-and-attach-design.md](17-resilience-and-attach-design.md)
- 测试与验收计划：[09-test-and-acceptance-plan.md](09-test-and-acceptance-plan.md)
- 外部 SDK 设计：[14-external-sdk-design.md](14-external-sdk-design.md)
- 可视化环境：[15-visual-scripting-environment.md](15-visual-scripting-environment.md)
- 内部分发约束：[16-zero-runtime-distribution-constraints.md](16-zero-runtime-distribution-constraints.md)

## 5. 打包与套件状态（2026-10-09）

- **打包副本全部同步**（手工维护副本，各有守护把关）：
  - `out/Default/resources/automation`（Client 打包自动化树）→ `node Client/test-packaged-automation.js` **12/12**
  - `out/Default/resources/app`（Client 打包 app）→ `node Client/test-app-copy-sync.js` **21/21**
  - `MClient/dist/resources/app`（MClient 打包 app，含 automation-panel）→ `node MClient/run-tests.js test-app-copy-sync.js` **绿**
  - `MClient/dist/resources/automation`（MClient 打包自动化树；**本次新增同步 + 新增守护**）→ `node MClient/test-packaged-automation.js` **12/12**
- **加固实现**：token 轮换（doc 17 Part C）+ executions 上限 env（§A.4）+ 可配置 data-dir（Part D）均已落码 —— `test-token-rotate` 8 PASS、`test-data-dir`（Client/MClient）各 15 PASS；鉴权回归 `test-http-api` 27 / `test-jwt-claims` 21 / `test-ws-api` 6 / `test-cdp-ws` 20 全绿。
- **MClient 全套件绿**：**73 文件 1308 PASS / 0 FAIL**（1 skip 为既有合法跳过）。修复的 5 个既有红项（`test-ui-groups` / `test-ui-sync` / `test-h2-tab` / `test-profile-tab-tls` / `test-tls-keys`）根因均为**陈旧测试**，**未改生产代码、未弱化断言**。
- **总验收**：`node sdk/test/acceptance.js` → exit 0（**37 PASS**，覆盖 SDK×4 / MClient 桥 / MClient 真自动化 / MClient 面板 / MClient RPA / Client 真自动化 / e2e 业务套件）。
