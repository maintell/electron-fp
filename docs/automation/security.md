# Automation 安全模型（security.md）

> 范围：automation 平面新增能力的威胁模型与控制要求。现状证据见 `docs/automation/current-architecture.md`；本文只定约束，不写实现。
> 现状基线：IPC 零 `event.sender` 校验（`Client/main.js:499-665`）、`debugger.attach/sendCommand` 无鉴权（`shell/browser/api/electron_api_debugger.cc:113-135`）、权限默认放行（无 `setPermissionRequestHandler` 注册）、preload 仅暴露 `invoke` + 6 事件白名单（`Client/preload.js:3-63`）。

---

## 1. 威胁模型（Threat Model）

假设攻击者已获得以下任一立足点，控制措施必须仍成立：

| # | 威胁 | 说明 / 后果 |
|---|------|-------------|
| T1 | XSS → main 接管 | renderer XSS 经无校验 IPC 直达 main（现状 `tabId \|\| activeTabId` 可伪造），进而读写任意 tab、开 devtools、执行 selftest 探针。automation 不得新增同类通道。 |
| T2 | RCE（child_process / fs） | 脚本若可 `require('child_process'/'fs')` 或触达 `process/net/dgram/shell`，即由脚本执行升级为系统命令执行。默认必须不可达。 |
| T3 | 原型污染（prototype pollution） | 脚本/任务参数、profile JSON、导入导出包中的 `__proto__/constructor/prototype` 键污染共享对象，导致权限绕过或逻辑篡改。解析与合并处必须设防。 |
| T4 | 路径遍历（path traversal） | 脚本导入/导出、日志/产物落盘、profile 文件路径拼接中出现 `../`、绝对路径、symlink，读写越界文件。所有外部文件名必须规范化 + 围栏。 |
| T5 | 命令注入（command injection） | 脚本参数、URL、profile 字段拼入 shell/子进程参数，导致额外命令执行。禁止 shell 拼接；必须参数化调用。 |
| T6 | SSRF | 脚本/任务触发的服务端请求访问内网（169.254.169.254、127.0.0.1、内网段）、探测端口或读取云元数据。网络能力必须 allowlist + 出站策略。 |
| T7 | 任意文件读写 | 经脚本 API、CDP `Page.printToPDF` 落盘路径、导出导入、日志路径实现任意读/写。文件能力默认关闭，按 profile/任务授权目录。 |
| T8 | IPC 提权（escalation） | renderer 或低权限脚本调用高权限通道（fingerprint 写入、proxy 改写、agent approve、devtools）。每条 IPC 必须鉴权 + sender 校验 + 权限位检查。 |
| T9 | token / cookie 泄漏 | automation 产物（快照、日志、HAR、导出包、审计回放）夹带 cookie、Authorization、proxy 密码、`FP_CONFIG_DATA` / `--fingerprint-config` 载体。落盘与回传前必须脱敏。 |
| T10 | 跨 profile 访问 | per-tab（`fp-tab-*`）/ per-group（`fp-group-*`）隔离被脚本跨越：读到他 profile 的 cookie/storage/指纹，或把 A 的指纹写到 B。profile 访问必须显式 `profiles.get(id)` + per-profile ACL。 |

非目标：内核指纹算法本身的对抗强度、Chromium 沙箱逃逸防护。本文只约束 automation 胶水层。

---

## 2. Script Sandbox 能力模型（Capability Model）

默认能力集合（最小权限，默认拒绝一切未列出项）：

```text
{ browser: true, cookies: scoped, storage: scoped, network: allowlist,
  filesystem: false, process: false }
```

规则：

- 默认 deny：`require('child_process'/'fs'/'os'/'net'/'dgram'/'shell')`、裸 `process`、`eval/new Function` 动态代码、shell 拼串执行。一律不可用，不以参数开关绕过。
- `filesystem:false / process:false` 为默认值；任何放宽必须走 trusted-script opt-in：脚本哈希签名 + 显式授权 + 授权目录围栏 + 审计记录，缺一不可。
- trusted-script 仅放行声明的最小目录与只读/只写位；`../`、绝对路径、symlink 跳出围栏一律拒绝并记审计。
- 网络默认仅 allowlist 域名 + 协议（https/wss）；内网段、元数据地址、非标端口默认拒绝。SSRF 防护放在执行侧强制，不依赖脚本自觉。
- 所有外部输入（任务参数、导入 JSON、profile 字段）在入沙箱前做原型污染清洗：禁止 `__proto__/constructor/prototype` 键，冻结合并目标原型。

---

## 3. Runtime vs Page 隔离

- Renderer 只做 IDE（编辑/展示/触发），不做执行。脚本执行一律在 main 侧 Worker（独立上下文），renderer 拿不到 Worker 句柄与源码执行权。
- Page（被测 tab）与 Runtime（脚本 Worker）双向隔离：脚本只能经受控 `browser/*` 能力操作 Page，不能 `executeJavaScript` 任意串、不能直连 Page 的 CDP、不能读 Page 进程内存。
- Worker 无 DOM、无 Node 全量 API、无 `window`；`browser/cookies/storage/network` 能力由 host 按任务逐项注入、用完即收回。

---

## 4. CDP 访问控制

- Allowlist（仅这些域可调）：`Page` / `DOM` / `Input` / `Network-read`（只读：取请求元数据，不改请求）/ `Runtime-limited`（受限求值：超时 + 无 await 无限循环 + 返回值截断脱敏）/ `Storage` / `Target.attachToTarget·setAutoAttach·setDiscoverTargets·getBrowserContexts·getTargets`，以及**只读发现** `Browser.getVersion`（供外部 CDP 客户端握手；无控制能力）。
- Deny（默认拒绝）：`Browser.close` / `Browser.*`（除 getVersion）/ `Target.createTarget` / `Target.closeTarget` / `SystemInfo` / `FileSystem` / 任意可开新目标、可读系统信息、可跨 target 的方法。现状 `debugger.attach` 无鉴权（`electron_api_debugger.cc:113`）不得直接复用，必须包一层鉴权网关。
- **不开原生调试端口**（`--remote-debugging-port` 保持缺席）。外部 CDP 接入走**自建** `runtime/cdp-ws.js` 桥：仅绑 `127.0.0.1`，WS 升级前校验 Host + token，页面级方法经既有 allowlist 会话转发（同一 choke point 与审计），无 Node/依赖新增。
- 绑定三件套（HTTP 网关与 CDP 桥一致）：`127.0.0.1` + `Host/Origin` 校验 + Bearer token（按任务签发、短期有效、单任务作用域）。
- 快照脱敏：快照/日志/HAR 在落盘与回传前 scrub FP 载体（`--fingerprint-config` b64、`FP_CONFIG_DATA`、`FP_CONFIG` 路径内容、cookie、Authorization、proxy 密码）。含敏感字段的快照不得进 execution log 明文。

---

## 5. Env 通道管控

- `FP_CONFIG_DATA / FP_CONFIG / FP_<key>` 等 env 注入通道默认禁用（default-disable）。automation 任务需用指纹时，必须显式声明并经 fingerprint 更新门禁（见 §8）。
- 开启时走 HMAC 信封：`payload + nonce + expiry + HMAC(secret)`，执行侧验签后才注入；过期/重放/篡改一律拒绝并记审计。
- secret 按 profile 隔离存放（复用 safeStorage 思想，不落明文）；日志中只记 key 名与指纹哈希，不记载体原文。

---

## 6. Profile 隔离与 ACL

- 沿用现有隔离语义：per-tab `fp-tab-*` 与 per-group `fp-group-*` 不互通；automation 不得隐式跨越。
- 脚本访问 profile 必须显式 `profiles.get(id)`，禁止枚举全部、无禁止 `list()` 遍历敏感字段（cookie、proxy 密码、指纹原文默认不返回）。
- per-profile ACL：每个 profile 独立授权（allow/deny 脚本或任务 id）；跨 profile 读写必须双向授权（源读 + 目标写）同时成立，否则拒绝。
- `originProfileId` 不可变语义保持；`profileId` 置 `custom` 的写操作必须走 §8 门禁。

---

## 7. RBAC

权限点（permission）：

```text
Script: View / Create / Edit / Delete / Run / Debug / Export / Import
Task:   View / Create / Cancel
Profile: View / Run
Automation: API / Admin
```

角色矩阵（`Owner > Admin > Developer > Operator > Viewer`，高位含低位未显式 deny 项）：

| 角色 | Script | Task | Profile | Automation |
|------|--------|------|---------|------------|
| Owner | 全部 | 全部 | View+Run | API+Admin |
| Admin | 全部 | 全部 | View+Run | API+Admin |
| Developer | View/Create/Edit/Run/Debug/Export/Import（无 Delete） | View/Create/Cancel | View+Run | API（无 Admin） |
| Operator | View/Run（无 Create/Edit/Delete/Debug/Export/Import） | View/Create/Cancel | View+Run | 无 |
| Viewer | View（仅） | View（仅） | View（仅） | 无 |

- `Debug` 隐含 CDP 受限访问，仍受 §4 allowlist 约束，不因角色放宽域集合。
- `Export/Import` 触发路径围栏 + 脱敏 + 审计；`Admin` 才能改 RBAC 与 trusted-script 名单。

---

## 8. 指纹更新门禁（Fingerprint Update Gated）

任何经 automation 变更指纹（Blink/TLS/H2/UA 任一平面）的操作，必须依次通过五道门：

1. **validate**：经 `fpSplitConfig` 分流 + schema 校验（63 Blink 键类型严格、TLS/H2 键集合法），未知键拒绝或显式丢弃告警；类型错配（数字加引号等）直接失败，不静默 fallback。
2. **permission**：调用方具 `Profile.Run`（或更高）+ 目标 profile ACL 写授权；renderer 发起还需 `event.sender` 归属校验（补现状缺口）。
3. **lifecycle**：确认目标 tab/group 处于可重建状态；H2/TLS 平面冻结语义如实告知（能改才改，不能改只上报、不谎称成功）。
4. **restart**：同 partition 重建 renderer 使 `--fingerprint-config` 生效（复用 `recreateTabView/recreateGroupViews` 语义），cookie/storage 按 partition 语义保留或显式清空。
5. **log**：记 audit log（谁、何时、哪个 profile、改了哪些键哈希、成功/拒绝原因），载体原文不进日志。

---

## 9. 审计日志三元组（Audit Log Triple）

三类日志分离存放、时钟单调、不可经脚本 API 篡改（目标形态；实现现状：中央收集器 `runtime/audit-log.js` 同流承载，`GET /api/audit` 可查，`FP_AUTOMATION_AUDIT_FILE` 落 JSONL；独立 system 表仍未建，SQLite P9 时再拆）：

- **execution log**：任务级（任务 id、脚本哈希、参数哈希、起止时间、 verdict 行、产物路径）。可含脱敏后的快照摘要，不含 token/cookie/FP 载体原文。
- **system log**：运行时级（Worker 启停、CDP 网关 allow/deny、网络出站 allow/deny、文件围栏拦截、HMAC 验签失败）。面向运维排障。
- **audit log**：安全级（鉴权成败、RBAC 变更、trusted-script 授权、profile 跨访、指纹更新五门结果、导出导入）。只追加，Admin 可读不可改，保留期最长。

三者以任务 id + profile id 关联，任一拒绝动作必须同时在 system 与 audit 留痕。
