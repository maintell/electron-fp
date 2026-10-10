# Profile Manager 专册（P8，2026-09-26）

> 实现：`automation/runtime/profile-manager.js`；测试：`automation/test-profile-manager.js` **17 PASS**；接线：service `profiles` 组 → HTTP 全路由 → CLI `profile *` → IPC 9 通道（见 `api.md` §4.6/§10）。

## 1. 模型

- `createProfileManager({ file?, launcher, now, audit, fpValidate? })`。
- JSON-file 原子存储（tmp+rename；落盘时剥 `lastEndpoint`）；`partition = 'persist:auto-' + id` 派生（`task.md` §6）。
- 状态：`stopped / starting / running / stopping / error`；running 中改指纹三元组 → `CONFLICT`；非法迁移（stopped 下 stop/start 已 running）→ `CONFLICT`；`launcher` 未接 → `LIMIT 'launcher not wired'`。
- `launcher.start` 须返回 `wsEndpoint / cdpUrl / debugPort` 三元组至少其一（`debugPort: 0` 合法）；否则 VALIDATION → 状态 error。
- `bulkStart(ids)` 分块 `Promise.allSettled` → `{ started: [], failed: [{ id, error: { code, message } }] }`。
- `assertOwned(profileId, ctxProfileId)` → `ProfileError('cross-profile access denied')`（跨 profile 硬拒）。
- `list()` 脱敏 `proxy.password = '***'`；`get()` 返回全量（in-process 明示）。
- `setEndpoint(id, patch)`：仅 running 浅合并进 live endpoint（unknown → NOT_FOUND；patch 非对象 → VALIDATION；非 running → CONFLICT），**永不落盘**——供宿主把运行时地址挂上（如 cdp-server 发布的 `cdpUrl`，见 `api.md` §6）。
- `ProfileError` 本地类（`code` 参 CONFLICT/VALIDATION/NOT_FOUND/LIMIT；与 script-runner.js 的 `ProfileError` 同名不同类，各自 `name='ProfileError'`——service `mapError` 优先信 `e.code`，见 automation-service.js 注释）。

## 2. 启动/停止语义

- `start(id)`：stopped → starting → launcher.start → running（存 `lastEndpoint` 内存态）；launcher 抛错 → error。
- `stop(id)`：running → stopping → launcher.stop → stopped；非 running → CONFLICT。
- `status(id)`：`{ id, status, endpoint? }`（endpoint 仅 running 有，含 `setEndpoint` 合并的运行时字段如 `cdpUrl`；无 endpoint → `GET /:id/cdp` 404，见 `api.md` §6）。

## 3. 真链路边界

- launcher 的 `fromPartition(persist:auto-*)` 绑定**已落地**：`automation/electron/launcher.js`（`start/acquire/stop/list`；非 `persist:` 分区拒建），探针实证 partition 断言 / stop 销毁 / 同 id relaunch cookie `rl2` 存活（smoke 24/24 内）。launcher 仍为注入式（测试用 fake，生产由 Client 装配 `createWindow`）。
- `electron/glue.js` `restartSession` 已证同 partition 重建 + carried 状态（探针 relaunch 项），与 launcher 重建同一模式；真窗压力档 `probe-real-stress.js` 在 N=10/20/30 下每 profile 走 launcher 分区，验证零丢失与同 profile 串行。
