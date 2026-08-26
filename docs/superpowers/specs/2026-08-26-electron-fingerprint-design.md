# Electron 指纹能力合并设计 — 1:1 移植 ungoogled-chromium-windows

**Date:** 2026-08-26
**Status:** Draft — 已通过 §1-§3 分段确认，待用户复审
**Decisions:** A. 1:1 Chromium patch 移植 + 完全隔离目录 + session+webContents 双入口 JS 动态隔离
**Ref:** `F:\code\ungoogled-chromium-windows\patches\ungoogled-chromium\windows\fp-fingerprint.patch` (1881 行, 36 文件, 56 键), `INTEGRATION.md`, `electron-fp/patches/config.json` / `chromium_src/BUILD.gn` / `shell/browser/web_contents_preferences.cc`

## 1. 目标与约束

### 1.1 目标
- 将 `ungoogled-chromium-windows` 的 56 键指纹能力完整移植到 `electron-fp`（当前 Chromium 154.0.8015.0），保持与未配置时原生一致。
- 窗口级隔离：每个 `BrowserWindow` / `WebContents` 可独立指纹，跨窗口不串扰。
- JS 动态配置：`session.setFingerprintConfig` + `webContents.setFingerprintConfig` / `new BrowserWindow({webPreferences:{fingerprint}})`，运行时可切换。
- 零配置原生：不传 `fingerprint` 时不注入，透传原生；`fingerprint:false|{}` 显式禁用。

### 1.2 非目标
- 不重写未覆盖的 ungoogled 能力外的新指纹面；不引入上层业务的分发/账号体系。

### 1.3 约束（用户明确）
- **目录完全隔离**：指纹 patch 与脚本不得散落在 `patches/chromium/` / `shell/` / `script/` 中，需独立顶层目录，避免 Chromium 大版本升级时与 Electron 165 个 patch 的 `e sync --3` 冲突。
- 保持合流能力：Chromium 154→155 升级仅替换指纹目录单文件，不改 `patches/chromium/.patches`。
- 可禁用：`fingerprint` 开关可按窗口禁用。

## 2. 总体架构与目录隔离

```
electron-fp/                  # 不动上游布局
  patches/chromium/           # 165 个 Electron 自身 patch，.patches 顺序不变
  shell/  lib/  chromium_src/ # Electron 粘合层（仅最小粘合由本设计新增，见 §3）
  fingerprint/                # ★ 独立目录，本设计唯一新增顶层
    patches/
      fp-fingerprint.patch    # 单文件，1:1 对应未切分（便于与 ungoogled diff 合流）
      .patches                # 可选，仅记录单条，隔离于主 .patches
    helpers/
      fp_config_helpers.h     # 复刻未改 helpers + 仅改注入源（见 §2.2）
    scripts/
      apply.py                # 检测 src/ 存在则 git am --3way，失败单告警
      check.py                # 镜像 devutils/check_patch.py 8 项检查
      smoke.js                # Electron 版 CDP 烟雾（替代 smoke_fp.ps1）
    README.md
    INTEGRATION.md            # 镜像未改 56 键规格表 + C1-C17 一致性
  docs/superpowers/specs/2026-08-26-electron-fingerprint-design.md # 本文
```

**合流：** `fingerprint/patches/fp-fingerprint.patch` 由未改的 `gen_patch6.py` 重生成后直接替换；Electron 自身 roll 流程（`e sync --3` / `update-patches.patch` artifact）完全不受影响。指纹 patch 冲突时仅 `fingerprint` 的 CI job 失败，不阻断主 `Apply Patches`。

**施加：** `patches/config.json` **不改**。`fingerprint/scripts/apply.py` 在主 `script/apply_all_patches.py` 之后独立施加（见 §4）。

## 3. 配置与 API 形态

### 3.1 JS API（主进程）

```ts
// 推荐双入口，session 为模板，webContents 可覆盖
session.fromPartition('persist:fp1').setFingerprintConfig(config: FingerprintConfig | null)
session.fromPartition('persist:fp1').getFingerprintConfig(): FingerprintConfig | null

webContents.setFingerprintConfig(config: FingerprintConfig | null)
webContents.getFingerprintConfig(): FingerprintConfig | null

new BrowserWindow({
  webPreferences: {
    fingerprint?: FingerprintConfig | false  // false/undefined = 原生
  }
})
```

`FingerprintConfig` 为 56 键扁平对象，类型按 `fp_config_helpers.h` 保持：`int` 键无引号、`string` 键带引号，例如：

```js
{
  screen_width: 1920, screen_height: 1080,
  hardware_concurrency: 8, device_memory: 8,
  webgl_vendor: "Google Inc. (NVIDIA)", webgl_renderer: "ANGLE (NVIDIA, ...)",
  canvas_noise_seed: 123456, fonts_blocklist: "Arial,Helvetica",
  tz_id: "America/New_York", webrtc_ip: "1.2.3.4",
  // ... 余 46 键同未改 spec 表
}
```

缺键 = 该面透传原生（零配置一致）。

### 3.2 注入链路（per-RenderProcess 窗口隔离）

- C++：`shell/common/options_switches.h` 新增 `kFingerprintConfig`；`shell/browser/web_contents_preferences.cc` 解析 `webPreferences.fingerprint` → `blink::web_pref::WebPreferences::fingerprint_config`（新增字段）或存入 `RendererPreferences`。
- 透传：`shell/browser/electron_browser_client.cc::AppendExtraCommandLineSwitchesForRenderer` 对该 `RenderProcessHost` 所属的 `WebContents` 取 `FingerprintConfig` 序列化为 JSON，注入为 `--fingerprint-config=<base64>`（替代原环境变量，避免沙箱读不到主进程 env；单 RenderProcess 粒度天然窗口隔离，`site-per-process` 下跨站不串）。
- Renderer：`fingerprint/helpers/fp_config_helpers.h` 读优先级改为 `1) --fingerprint-config 开关 2) FP_CONFIG_DATA 3) FP_CONFIG 4) FP_*`，保持未改的 `FpConfigInt/String/Int64` 类型语义，缺省透传。

### 3.3 零配置与禁用

- 不传 `fingerprint` → 不注入开关 → Renderer 侧 `FpConfig*` 均为缺省 → 透传原生（与未改一致）。
- `fingerprint:false` 或 `setFingerprintConfig(null)` → 注入空 JSON 或显式禁用标记 → 同透传（与未改一致，显式语义）。

## 4. Patch 移植与合流

### 4.1 移植清单

单文件 `fingerprint/patches/fp-fingerprint.patch` 覆盖未改 36 文件（按未改头注释的 MERGE 风险分级）：

- `third_party/blink/renderer/platform/fonts/font_cache.cc` (HIGH, 统一遮蔽)
- `third_party/blink/renderer/core/html/canvas/*` + `canvas2d/base_rendering_context_2d.cc` + `offscreencanvas` (HIGH, `FpApplyPixelNoise`/`FpApplyCanvasExportNoise`)
- `third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc` + `third_party/blink/renderer/modules/webgpu/gpu_adapter.cc` (HIGH/MEDIUM, 保持 GPU 厂商一致 C6-C8/C17)
- `third_party/webrtc/*` 4 文件 + `third_party/blink/renderer/platform/p2p` (HIGH, WebRTC IP 覆盖)
- 余 26 文件按未改清单（Screen/Audio/Geolocation/Permissions/Performance/Media/NetInfo/Storage/Battery/DnTrack/Speech/MediaDevices 等），均为 getter 拦截或确定性噪声。

`fingerprint/helpers/fp_config_helpers.h` 仅改注入源，其余 `FpApplyPixelNoise`/`FpFontFamilyHidden`/`FpPerturbRectF` 保持未改。

### 4.2 粘合改动（Electron 侧最小）

- `shell/browser/web_contents_preferences.cc` + `shell/common/options_switches.h` + `shell/browser/electron_browser_client.cc`（上述注入链路）
- `shell/browser/api/electron_api_session.cc` + `shell/browser/api/electron_api_web_contents.cc`（gin 绑定）
- `lib/browser/api/session.ts` + `lib/browser/api/web-contents.ts` + `typings/internal-electron.d.ts`（JS 透出，复用现有 `userAgent` prototype 模式）
- `filenames.gni` 仅若新增 `fingerprint/helpers` 需包含（header-only 则免）

以上以外不碰 `shell/`/`lib/`，`patches/chromium/.patches` 不动。

### 4.3 合流策略

- 升级时用未改 `devutils/gen_patch6.py` 在新 Chromium 基线重生成 `fp-fingerprint.patch` 单文件替换；Electron 自身 `roller/chromium/main` 的 `e sync --3` 与本目录无关。
- 若单文件冲突难定位，可后续按未改头注释的风险分级临时拆为 `fingerprint/patches/fp-*.patch` 多文件（仅升级期），稳定后合回。

## 5. 构建与验证

### 5.1 施加顺序

1. `gclient sync` → `script/apply_all_patches.py` 施加 `patches/chromium/*`（165）
2. `fingerprint/scripts/apply.py` 检测 `src/third_party/blink` 存在则 `git -C src am --keep-non-patch --3way -- < fingerprint/patches/fp-fingerprint.patch`，失败仅 `fingerprint-patch` job 告警（`continue-on-error`），不阻断主构建。

CI：新增 `fingerprint-patch` job（`ubuntu-latest`, 无容器）先于 `fork-pipeline` 构建；主构建 jobs 依赖它但 `if: always() && fingerprint-patch.result != 'failure'` 可配置为不阻断（按本节隔离语义取不阻断）。

### 5.2 验证

- **静态**：`fingerprint/scripts/check.py` 镜像未改 8 项（series 引用、头注释、56 键完整性、debug 残留、hunk 数、INTEGRATION 同步），<1s。
- **烟雾**：`fingerprint/scripts/smoke.js` 用 `BrowserWindow` + `webContents.debugger` / `remote-debugging`（复用未改 `smoke_fp.ps1` 的 20+ 断言：`navigator.hardwareConcurrency`/`deviceMemory`/`screen`/`Intl.DateTimeFormat().resolvedOptions().timeZone`/`gl.getParameter(0x9245)`/`canvas.toDataURL` hash/`storage.estimate`/`gpu.requestAdapter` 等），零配置时对比原生指纹一致。

### 5.3 CI 集成

`fork-release.yml` 的 `setup` 后插入 `fingerprint-patch`；`fork-pipeline-electron-build.yml` 已有的 cache-miss 回退（`continue-on-error` + 完整 `gclient sync`）保持，不受指纹 patch 影响。

## 6. 风险、回退与非目标

- **Roll 冲突面大**：36 文件中 WebGL/FontCache/WebRTC 为高波动区，已在 patch 头标注 HIGH；回退：`fingerprint/scripts/apply.py` 失败时构建自动回退到无指纹原生（该 RenderProcess 不注入即透传），不影响 Electron 主功能。
- **一致性 C1-C17**：GPU 厂商/区域链路/种子确定性等需上层业务保证，本设计仅透传，不校验；后续可加 `fingerprint/scripts/check_consistency.js`。
- **MAS/签名**：本设计不引入额外 entitlement，仅改 Blink/WebRTC getter，不影响签名。

## 7. 验收

- [ ] `fingerprint/` 目录独立，`patches/chromium/.patches` 未动
- [ ] `session` + `webContents` 双入口可设 56 键，窗口隔离验证（两窗口不同指纹）
- [ ] 零配置时 20+ 面与原生一致（smoke 零配置对比通过）
- [ ] `fingerprint/scripts/check.py` 8 项通过
- [ ] Chromium 154 基线构建通过，patch 冲突仅影响 fingerprint job
