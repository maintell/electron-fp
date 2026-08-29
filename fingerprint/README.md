# fingerprint — 隔离目录

本目录与 Electron 主 patch 完全隔离（见 `docs/superpowers/specs/2026-08-26-electron-fingerprint-design.md`）。

- `patches/*.patch` 补丁集（按运行时子系统拆分为 4 个，按文件名顺序施加）；整块替换源仍为 `ungoogled-chromium-windows`，升级时按需替换单个补丁
- 不改 `patches/chromium/.patches` / `patches/config.json`，施加由 `fingerprint/scripts/apply.py` 独立完成
- `helpers/fp_config_helpers.h` 仅改注入源为 `--fingerprint-config`（per-Renderer，`ElectronBrowserClient::AppendExtraCommandLineSwitchesForRenderer`），其余 56 键语义与上游一致

## 目录结构

- `patches/*.patch` — 补丁集，按**运行时子系统**拆分为 4 个，按文件名顺序施加：

  | 补丁 | 文件 | 内容 |
  |---|---|---|
  | `00-core.patch` | 1 | `fp_config_helpers.h`（新建，被其余 32 个文件 include，必须最先施加） |
  | `10-blink-core.patch` | 13 | Blink core：screen / geo / canvas / DOM / timing / font_cache |
  | `20-blink-modules.patch` | 17 | Blink modules：WebGL / WebGPU / audio / speech / media / battery / storage |
  | `30-webrtc.patch` | 5 | WebRTC：自定义 IP（webrtc 为独立仓库、无 `//base` 依赖）+ `ipc_network_manager.cc` 注入点 |

  合计 36 文件。每个补丁含 patch 头说明及 per-file `RANGE/PURPOSE/CONFIG/MERGE` 注释。
  拆分目的：升级时只需重新锚定失败的那一个子系统，而非 36 个文件整体重来。
  用 `scripts/split_patch.js` 从源码树重新生成（以源码为准，同时修正注释漂移并重算 hunk 计数）。
- `helpers/fp_config_helpers.h` — 命令行优先 `FpConfigContent()`（`--fingerprint-config` base64 JSON → `FP_CONFIG_DATA` → `FP_CONFIG` 文件 → `FP_*` env）
- `scripts/apply.py` — 扫描 `patches/` 下 `[0-9][0-9]-*.patch` 并按序用 `git apply` 施加（无 split 补丁时回退到 monolith）。每个补丁有**独立**的幂等标记，无 `src/third_party/blink` 时跳过返回 exit 0
- `scripts/check.py` — 本地未接 `devutils/check_patch.py` 8 项静态检查（<1s）：56 配置项（跨全集合校验）/ 头注释 / doc-segment 匹配 / empty-segment / debug 残留 / hunks / 头计数 / 隔离 / 文件不得被多个补丁重复拥有
- `scripts/split_patch.js` — 从当前源码树重新生成 4 个补丁（保留 doc 块，以源码为准消除注释漂移并重算 hunk 计数）
- `scripts/revert_webrtc.js` — 将单个 webrtc 文件还原到未打补丁状态（webrtc 是未初始化的 submodule，git 无法还原）
- `scripts/smoke.js` — Electron CDP 烟雾（20+ 面：hardwareConcurrency/screen/Audio/WebGL/Canvas/Geolocation 等，零配置与原生一致）

## Chromium 大版本合流指南（Merge Guide）

> 升级约束：Chromium 大版本升级时**按需**替换失败的补丁即可 —— 补丁已按子系统拆分，
> 只需重新锚定受影响的那一个（例如 Blink 重构通常只影响 `10-blink-core`，
> WebRTC 升级只影响 `30-webrtc`）；`patches/chromium/.patches` 不涉及指纹。
>
> **注意**：`00-core.patch` 必须最先施加 —— 它创建的 `fp_config_helpers.h`
> 被其余 32 个文件 include。

### 1) 替换 patch

```bash
# 方式 A：直接拷贝上游新基线产物
cp "F:/code/ungoogled-chromium-windows/patches/ungoogled-chromium/windows/fp-fingerprint.patch" \
   fingerprint/patches/fp-fingerprint.patch

# 方式 B：用上游 devutils/gen_patch6.py 在新 src 重生成后覆盖（推荐，含 56 键完整性校验）
```

若单文件冲突难定位，可临时拆为 `fingerprint/patches/fp-*.patch` 多文件调试，稳定后合回单文件（见上游 `INTEGRATION.md` 风险分级）。

### 2) 本地静态校验（<1s，无需 src）

```bash
python3 fingerprint/scripts/check.py
python3 fingerprint/scripts/apply.py --dry-run
```

- `check.py` 失败 → 按输出修复：补键 / 补头注释 `MERGE/UPGRADE GUIDE` / 清 debug 残留 / 对齐 per-file doc。
- `dry-run` 失败（`git apply --check --3way` 非 0）→ 按 patch 头 `MERGE:` 风险分级逐文件 re-anchor：
  - `LOW`：Navigator/Screen/DoNotTrack — 稳定 getter
  - `MEDIUM`：Audio/Geolocation/MediaDevices/NetInfo/Permissions — 偶尔重构，Anchor 对应方法
  - `HIGH`：WebGL/Canvas/WebRTC/FontCache — 频繁变更，手动对比 upstream diff（`git log --oneline -L :Func:path` / `grep -l filename patches/chromium/*.patch`）

### 3) 全量构建验证（可选，需 gclient sync）

```bash
e sync --3 && e build         # 主 165 patches 照常合入，不受 fingerprint 影响
python3 fingerprint/scripts/apply.py --src src   # 实际施加到 src
node fingerprint/scripts/smoke.js                # 窗口隔离 + 20 面
node fingerprint/scripts/smoke.js --no-fingerprint  # 零配置应与原生一致
```

### 4) 提交

```bash
git add fingerprint/patches/fp-fingerprint.patch
git commit -m "chore(fingerprint): roll fp-fingerprint.patch to Chromium 15x"
```

**隔离保证**：`patches/chromium/.patches` 与 `patches/config.json` 永远不含 `fp-fingerprint.patch`；`e sync --3` 的 `update-patches.patch` artifact 不包含指纹面；冲突仅使 `fingerprint-patch` job 失败，不阻断主构建与发布。

## CI

- **fork-release.yml `fingerprint-patch` job**：`runs-on: ubuntu-latest`，`continue-on-error: false`（严格阻塞该 job），但为**隔离 job**——`macos`/`linux`/`windows` 不 `needs` 它，`publish` 亦不 `needs` 它，主 165 patches 编译链路不受影响；失败时仅该 job 红叉，提示指纹面需按上节适配。
- **fingerprint-check.yml**（可选 fast check）：`pull_request` / `push: main` 且 `paths: fingerprint/**` 触发，同样两步（`check.py` + `apply.py --dry-run`），<1min，无容器，不拉 `ghcr.io/electron/build`。

## 本地自检

```bash
python3 fingerprint/scripts/check.py && echo PASS
python3 fingerprint/scripts/apply.py --dry-run && echo "dry-run ok (or src missing, skip)"
```

## 隔离边界

禁止项（CI `check.py` 会拦）：
- 在 `patches/chromium/` 下新增 `fp-*.patch` 或在 `patches/config.json`/`patches/series` 中引用 `fp-fingerprint.patch`
- 改 `patches/chromium/.patches` 顺序

允许项：
- `shell/common/options_switches.h`、`shell/browser/web_contents_preferences.cc`、`shell/browser/electron_browser_client.cc`、`shell/browser/api/electron_api_*.cc`、`lib/browser/api/*.ts`、`typings/internal-electron.d.ts` 的最小粘合（见 `docs/superpowers/specs/2026-08-26-electron-fingerprint-design.md §4.2`）
