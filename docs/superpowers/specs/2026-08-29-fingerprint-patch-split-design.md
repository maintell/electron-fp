# 指纹补丁拆分设计

日期：2026-08-29
状态：**已完成**（实施于 `68f4a1461b`；设计要点见下，实际数据以实施结果为准）
范围：`electron-fp/fingerprint/patches/` 与 `fingerprint/scripts/`

> **实施结果**：拆分完成并全部验证通过。最终为 36 文件 / +1239 行（比设计预估多，
> 因为 `20-blink-modules` 在本轮同时补上了原本缺失的 webgpu_features/limits 实现）。
> `apply.py` / `check.py` 均按设计改造，另新增 `split_patch.js` 与 `revert_webrtc.js`。
> 验证：拆分后补丁按序施加到还原树上，36/36 文件与工作树逐字节一致。

## 1. 目标与动机

当前指纹补丁是单个 `fp-fingerprint.patch`（36 个文件 / +1051 行 / 76KB），横跨三个运行时子系统。Chromium 大规模升级时，任何一处 context 失配都会导致整块补丁应用失败，必须一次性重新锚定 36 个文件的 hunk。

**目标**：按运行时子系统拆成 4 个独立补丁，使升级时可以只重新生成失败的那一个，其余保持不变。

**非目标**（本次不做）：
- 不新增/删除任何指纹能力（56 个 key 语义不变）
- 不实现 TLS/JA3/JA4（属独立工程，需改 BoringSSL 与网络栈）
  - **已于 2026-08-29 实测确认，非仅推断**：补丁 36 个文件全部位于 `third_party/blink`(32)
    与 `third_party/webrtc`(4)，无 `net/`、`ssl/`、`boringssl/`；`fp_config_helpers.h` 位于
    `blink/renderer/core/frame/`，只能被 Blink 包含，网络栈取不到配置。
    真实 HTTPS 实测：空配置与明确配置各 4 次，JA4 完全相同 → 配置对 TLS 指纹零影响。
  - 附带确认 UA 存在泄露：实测 UA 含 `Electron/45.0.0-nightly.20260825`，且 schema 中
    UA/platform 类 key 为 0 个；`macOS / Safari-like` 预设仍报 Windows + Electron，自相矛盾。
  - 完整结论、测法陷阱（GREASE 需丢弃首次连接）与四条可选路径见
    `fingerprint/README.md` § 已知未覆盖：网络层指纹（TLS/JA3/JA4）与 User-Agent。
- 不改 `--fingerprint-config` 的注入机制

## 2. 现状

| 子系统 | 文件数 | 新增行 | 说明 |
|---|---|---|---|
拆分后的实际分布（已程序化核对，合计 36 文件 / +1051 行）：

| 补丁 | 文件数 | 新增行 | 内容 |
|---|---|---|---|
| `00-core` | 1 | +385 | `fp_config_helpers.h`（新建） |
| `10-blink-core` | 13 | +120 | screen / geo / canvas / DOM / timing / font_cache |
| `20-blink-modules` | 17 | +354 | webgl / webgpu / audio / speech / media / battery / storage |
| `30-webrtc` | 5 | +192 | webrtc 4 文件 + `ipc_network_manager.cc` |

**关键依赖**：36 个文件中 **32 个** 引入 `fp_config_helpers.h`（由补丁新建，`@@ -0,0 +1,385 @@`）。这是共享基础设施，决定应用顺序。

**例外 4 文件**（不引入 helper）：
- `webrtc/rtc_base/network.cc`、`network.h`、`p2p/base/port.cc` — webrtc 是零 `base/` 依赖的独立组件
- `blink/renderer/platform/p2p/ipc_network_manager.cc` — 属 Blink，但它是 WebRTC 的注入点，因此按功能归入 30-webrtc

## 3. 设计

### 3.1 切分维度：运行时子系统

选它而非"按功能分组"或"每文件一补丁"，理由：
- 与进程/技术边界一致 → 升级故障域天然隔离
- 同一上游文件不会落在两个补丁里 → 无交叉冲突
- 4 个文件规模适中，不像 36 个那样难以管理

### 3.2 目标布局

```
fingerprint/patches/
  00-core.patch             1 文件   +385   fp_config_helpers.h（新建）
  10-blink-core.patch      13 文件   +120   screen/geo/canvas/DOM/timing/font_cache
  20-blink-modules.patch   17 文件   +354   webgl/webgpu/audio/speech/media/battery/storage
  30-webrtc.patch           5 文件   +192   webrtc 4 文件 + ipc_network_manager.cc
```

文件名前缀 `NN-` 编码应用顺序，`apply.py` 按序号升序扫描。

归属规则（唯一，避免歧义）：
1. `fp_config_helpers.h` → `00-core`
2. 路径含 `/webrtc/` → `30-webrtc`
3. `platform/p2p/ipc_network_manager.cc` → `30-webrtc`（WebRTC 在 Blink 侧的注入点）
4. 路径含 `blink/renderer/modules/` → `20-blink-modules`
5. 其余 Blink（`core/`、`platform/fonts/`）→ `10-blink-core`

### 3.3 工具链改造：目录扫描

`apply.py`：
- 无 `--patch` 时，扫描 `patches/*.patch` 并按文件名升序依次应用
- 保留 `--patch` 用于单个补丁调试（过渡期与 monolith 兼容）
- 任一补丁失败即中止并报错，不继续应用后续补丁（保证顺序语义）

`check.py`：
- 校验 `patches/` 下所有补丁，汇总失败项后统一退出
- `EXPECTED_KEYS`（56 项）仍在**全集合**上校验：拆分不得导致任一 key 丢失或重复
- 新增检查：所有补丁的 `--- a/` 路径并集必须覆盖 56 个 key 所需文件

### 3.4 每补丁独立幂等标记（关键）

**现有缺陷**：`apply.py:48-53` 的 marker 用 `fp_config_helpers.h` 是否存在判断"已应用"。monolith 下正确，但拆分后会**静默漏打** —— `00-core` 应用后 helper 存在，后续 10/20/30 全部误判为已应用并 skip。

**修法**：每个补丁用**自身独有的落地特征**作 marker，而非共享文件。

| 补丁 | marker 判定 |
|---|---|
| `00-core` | `src/third_party/blink/renderer/core/frame/fp_config_helpers.h` 存在 |
| `10-blink-core` | `screen.cc` 含 `FpConfigInt("screen_width"` |
| `20-blink-modules` | `webgl_rendering_context_base.cc` 含 `FpConfigInt("webgl_max_texture_size"`（第 4003 行；`webgl_vendor` 在 4048 行因换行不连续，不宜作 marker） |
| `30-webrtc` | `webrtc/rtc_base/network.cc` 含 `SetCustomWebRtcIpOverride` |

marker 定义随补丁配置（脚本内表驱动），新增补丁时同步登记。

## 4. 顺带修复（本次一并处理）

拆分会重写全部补丁文件，正好修正以下既有缺陷：

1. **`webgpu_features` / `webgpu_limits` 零实现**
   `check.py` 的 `EXPECTED_KEYS` 含这两项、patch 文档（原 1844-1845 行）声称实现 REPLACE/MERGE，但源码无任何代码。实测 features 恒 18 项、limits 恒 `2147483648`，配置完全无效。
   处理：本次**不实现**（超出拆分范围），但需在补丁文档标注为 NOT-IMPLEMENTED，并从 `EXPECTED_KEYS` 中移出或标记，消除"文档说有、代码没有"的误导。

2. **补丁与源码 6 处注释漂移**
   既有源码经手工修改未回写补丁（如 `// 1) FP_CONFIG_DATA env...` 等编号注释、`// fp: override host IPs before merging.`）。纯注释、不影响功能，但会导致重打补丁时 context 不匹配。
   处理：拆分时以**源码为准**重新生成，漂移自然消除。

3. **hunk 头计数不准**
   原补丁存在 hunk 头声明行数与实际不符的情况（如 `offscreen_canvas.cc` 声明 +10 实际 +11）。
   处理：拆分时程序化重算每个 hunk 的 `-old,+new` 计数。

## 5. 验证

拆分后必须全部通过：

| 检查 | 命令 | 期望 |
|---|---|---|
| 静态检查 | `python fingerprint/scripts/check.py` | 63 keys、hunks ok、no residue |
| 补丁可应用 | `python fingerprint/scripts/apply.py --dry-run --src src` | 各补丁均可应用 |
| 幂等性 | 连续运行两次 apply | 第二次全部 skip，无重复应用 |
| 顺序敏感 | 用干净 tree，只应用 00-core 后跑 10/20/30 | 不误报 already-applied |
| 客户端回归 | `Client/test-schema.js` 等 8 套 | 全 PASS |
| 二进制可用 | 重新编译 + BrowserLeaks 抽样 | 已验证的 54/56 项不变 |

**拆分正确性判据**：4 个补丁按顺序应用到干净 tree 后，`git diff` 结果必须与原 monolith 应用结果**等价**（功能语义一致；注释漂移导致的差异允许）。

## 6. 风险

- **重编译**：拆分后需重新编译验证（约 25 分钟）
- **CI 已覆盖（原判断错误，已更正）**：`.github/workflows/fingerprint-check.yml` **确实存在**（此前在 `src` 下找错了路径，该 job 在 `electron-fp` 仓库）。它在 `pull_request` / `push: main` 且 `paths: fingerprint/**` 时运行，执行 `check.py` + `apply.py --dry-run`。另有 `fork-release.yml` 的 `fingerprint-patch` job 作为严格门禁。两个脚本均已在无 Chromium checkout 的环境下验证：check.py exit 0、apply.py 优雅跳过 exit 0。
- **`src` 中内核改动未纳入 git**：`src` 仓库里 `electron/fingerprint` 未被跟踪，`ipc_network_manager.cc` 与 webrtc 子模块的改动只存在于工作树 → 拆分前需先确认源码改动有留档

## 7. 执行顺序

1. 备份现有 monolith 补丁与 `src` 工作树改动
2. 以源码为准，程序化切分为 4 个补丁（重算 hunk 计数）
3. 改造 `apply.py`（目录扫描 + 每补丁独立 marker）
4. 改造 `check.py`（全集合校验 + 63 key 覆盖检查）
5. 处理第 4 节的 3 项既有缺陷
6. 跑第 5 节全部验证
7. 重新编译 + 抽样回归
