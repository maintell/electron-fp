# 16 · 零外部解释器分发约束（Zero-External-Runtime Distribution Constraints）

> 性质：**硬约束 + 对既有 00–15 的范围审计与界定**。本文优先级高于其余设计文档：与之冲突的表述一律以本文为准。
> 背景（用户新增约束，2026-10-09）：**分发时尽量不在客户 PC 部署 Node.js / Python 或任何类似解释性语言环境**——异构客户机上装解释器是客诉高发源（安装体积、权限、杀软误报、版本冲突、PATH 污染、企业管控）。

---

## 0. 约束陈述（不可协商）

| 编号 | 约束 |
|---|---|
| C1 | 客户分发（安装包/绿色版）**不得要求**预装 Node.js / Python / Ruby / PHP / 任何独立解释器。 |
| C2 | 运行期**不得**调用系统 `node` / `python` / `python3` 等外部解释器。 |
| C3 | **不得**捆绑第二个解释器作为副作用（避免体积/杀软/更新负担）。 |
| C4 | 不得把 `.py` / 需外部解释器执行的资产作为运行时执行单元。 |
| C5 | 开发/CI 期可继续用 `node`（`automation/test-*.js`）与 `python`（`fingerprint/scripts/check.py`），但**不随分发**。 |

> **范围界定（重要，2026-10-09 修订）**：C1–C5 约束的是**应用自身的分发**——客户为运行本产品而必须安装的东西。**不约束**用户在**自己的**工程里使用外部 SDK 时自备的解释器：那由用户自行安装，属预期行为，**不构成冲突**（详见 §4）。

---

## 1. 第一性原理：为什么本产品天然满足（且必须显式守住）

- **Electron = Chromium + Node.js（内嵌于 main 进程）**。客户装的是 `electron.exe`，它**本身就是 JS 运行时**——应用内 JS 执行无需外部 Node。
- **渲染进程 = V8**。可视化环境与编辑器在渲染进程内运行，同样无需外部运行时。
- 因此：**应用内执行面（V8 / 内嵌 Node / `node:vm` / `worker_threads` / `utilityProcess`）全部自足，零安装**。

> 关键区分：**「运行时在应用内」= 满足约束**；**「要求用户在应用外装 Node/Python 跑业务」= 违反约束**。二者常被混淆，是本文存在的理由。

---

## 2. 允许 vs 禁止的执行基底

| 基底 | 归属 | 允许 | 说明 |
|---|---|---|---|
| V8（renderer） | Electron 内嵌 | ✅ | 编辑器 / 可视化画布 |
| Node.js（main 进程） | Electron 内嵌 | ✅ | 自动化运行时宿主 |
| `node:vm` | Electron 内嵌 | ✅ | 可信脚本沙箱（能力裁剪，非安全边界） |
| `worker_threads` | Electron 内嵌 | ✅ | 执行/资源隔离 |
| `utilityProcess` | Electron API | ✅（推荐用于不可信脚本） | 进程隔离，随 Electron 分发 |
| `child_process` 调**系统 node** | 外部 | ⛔ | 违反 C1/C2 |
| 独立 **Python Script Runner** | 外部 | ⛔ | 竞品 Multilogin 模式，禁用 |
| 捆绑第二解释器（自带 python/node 二进制） | 外部 | ⛔ | 违反 C3 |

---

## 3. 范围审计：对既有 00–15 的逐项核对

| 文档 | 冲突/风险陈述 | 裁决 | 处理 |
|---|---|---|---|
| **04** §3 | 候选「独立 `child_process` + Node」标「★★★ 需另装 Node」 | **否决**（违反 C1/C2） | 标记 ⛔ + 加约束段 + ADR-7 |
| **04** §3 | 推荐 `node:vm` / `utilityProcess` | **保留**（Electron 内嵌，符合约束） | 无需改 |
| **04** §6 ADR-3 | 可信 vm / 不可信 utilityProcess | **保留** | 补 ADR-7 |
| **05** §3 | `automation/bin/serve.js`「node 进程」 | **澄清**：仅开发者/CI/自托管服务端模式，**不随客户分发** | 加注 |
| **08** §25 | 隔离升级 L1–L4 | **保留**，但基底仅限 Electron 内嵌 / OS 沙箱 | 加约束注 |
| **14** 全篇 | 外部 SDK 要求用户在**自己的 Node/Python 工程**里 `npm/pip install` | **无冲突**：用户自备解释器属 **C1 范围之外**（C1 只约束应用自身分发） | 加范围说明（**不降级**） |
| **15** §1 | `astToScript` 产物走 `node:vm` | **保留**（内嵌） | 补注「无外部 node/python」 |
| **09/10** | 测试/构建用 node | **保留**（开发期）；补打包验证项 | 加注 |
| **12** | 命名空间 / API 面 | 无冲突 | 无需改 |
| **13** | 交互（1 处提及） | 无冲突；「外部 SDK」入口标为高级/可选 | 无需改 |

---

## 4. 范围界定：C1 约束什么、不约束什么

**C1 只约束「应用自身的分发」**——即客户为了运行本产品而必须安装的东西。它**不约束**用户在**自己的**开发环境里使用外部 SDK 时自备的 Node/Python：那由用户自行安装，属预期行为，**不构成冲突**。

| 场景 | 谁提供解释器 | 是否受 C1 约束 | 说明 |
|---|---|---|---|
| 应用内运行（可视化 / 内置编辑器） | Electron 内嵌 | **是** | 客户零安装，产品必须自足 |
| 应用自身运行时基底 | Electron 内嵌 | **是** | 不得 spawn 系统 node/python、不得捆绑第二解释器 |
| 外部 SDK（用户自己的工程） | **用户自备** | **否** | 用户使用 SDK 时自行安装解释器，预期且可接受 |
| 开发/CI 脚本（test-*.js / check.py） | 开发机自备 | **否** | 不随分发 |

**结论**：doc 14 的外部 SDK 是**一等设计路径**（面向选择用代码组装的用户），**不降级、不设前提**；产品另有一条面向非开发者的**应用内零安装路径**（可视化 + 内置编辑器），保证「客户什么都不装也能用」。两条路径并存，各自服务不同人群。

---

## 5. 分发形态与打包规则

- **单一 Electron 产物**：安装包或绿色版，内含 `resources/automation/`（已实现，见 `../automation/troubleshooting.md` §6 #26；CJS 标记陷阱见该节）。
- **禁止**：安装器顺带装 Node/Python；安装向导勾选「安装运行时」；运行期 `spawn('node'|'python')`；把解释器二进制放进 `resources/`。
- **允许**：Electron 自带的一切（内嵌 Node、V8、`utilityProcess`）。
- **开发/CI 例外**：`automation/test-*.js`（node）、`fingerprint/scripts/check.py`（python）——仅开发链，不进入客户分发产物。

---

## 6. 验证（可执行、可复核）

| # | 验证项 | 方法 | 通过判定 |
|---|---|---|---|
| V1 | 产物无外部解释器调用 | 对打包产物 grep `spawn(`/`exec(`/`child_process` 且目标含 `node`/`python` | 命中即失败（dev 脚本除外） |
| V2 | 干净机可运行 | 在**未装 Node/Python** 的干净 Windows 镜像上运行打包 app | 三链路跑通：可视化脚本 / 代码脚本 / 运行监控 |
| V3 | 打包守护扩展 | 扩展 `Client/test-packaged-automation.js`，增「无外部解释器依赖」检查 | 检查通过 |
| V4 | 静态审查 | 审查所有 `child_process`/`utilityProcess` 调用点 | 无系统解释器调用 |
| V5 | 资产审查 | 产物内无 `.py` 作为执行单元 | 无命中 |

> V2 是「真链路」证据；V1/V3/V4/V5 是静态证据。二者都要，缺一不可（对齐 user spec §8.4 安全测试与 §12 验收）。

---

## 7. 与竞品对比（分发友好度是差异化点）

| 产品 | 运行时依赖 | 分发友好度 |
|---|---|---|
| Multilogin | 内置 Python Script Runner（解释器负担） | 低 |
| GoLogin / Incogniton | 官方 SDK 需用户装 Node/Python（开发者向） | 中（面向开发者） |
| **本方案** | **应用自身零安装**（Electron 内嵌）；外部 SDK 由用户自备环境 | **高（差异化）** |

---

## 8. 对既有决策的影响汇总

1. **04 ADR-3 保持**（`node:vm`/`utilityProcess` 均 Electron 内嵌）；新增 **ADR-7**（**应用自身**运行时基底限定 Electron 内嵌，拒绝 spawn 系统 node/python 与捆绑第二解释器；**不限制**用户自带的外部 SDK 环境）。
2. **04 候选「child_process+Node」否决**。
3. **05 `serve.js`/`browser-cli.js` 定位澄清**：开发者/CI/自托管，非客户分发。
4. **08 隔离 L1–L4 基底限定** Electron 内嵌 / OS 沙箱。
5. **14 外部 SDK 保留为一等路径**（用户自备解释器，明确不在 C1 范围内）；产品另有面向非开发者的应用内零安装路径。
6. **15 可视化执行走内嵌运行时**（无外部 node/python）。
7. **09/10 增加打包零解释器验证项**。
8. **13 外部 SDK 入口**：面向开发者，UI 需说明「需自备 Node/Python 环境」；产品内零安装路径面向非开发者。

> 关联：[04 技术选型](04-automation-technology-selection.md) · [05 架构](05-system-architecture.md) · [08 安全可靠性](08-runtime-security-and-reliability.md) · [14 外部 SDK](14-external-sdk-design.md) · [15 可视化](15-visual-scripting-environment.md) · [09 测试](09-test-and-acceptance-plan.md)。
