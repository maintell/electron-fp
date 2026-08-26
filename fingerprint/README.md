# fingerprint — 隔离目录

本目录与 Electron 主 patch 完全隔离（见 `docs/superpowers/specs/2026-08-26-electron-fingerprint-design.md`）。

- `patches/fp-fingerprint.patch` 单文件来自 `ungoogled-chromium-windows`，升级时直接替换
- 不改 `patches/chromium/.patches` / `patches/config.json`，施加由 `fingerprint/scripts/apply.py` 独立完成
- `helpers/fp_config_helpers.h` 仅改注入源为 `--fingerprint-config`（per-Renderer，`ElectronBrowserClient::AppendExtraCommandLineSwitchesForRenderer`），其余 56 键语义与上游一致

## 目录结构

- `patches/fp-fingerprint.patch` — 1881 行单文件，覆盖 36 文件指纹面（见 patch 头 `MERGE/UPGRADE GUIDE` 与 per-file `RANGE/PURPOSE/CONFIG/MERGE` 注释）
- `helpers/fp_config_helpers.h` — 命令行优先 `FpConfigContent()`（`--fingerprint-config` base64 JSON → `FP_CONFIG_DATA` → `FP_CONFIG` 文件 → `FP_*` env）
- `scripts/apply.py` — 独立施加 `git -C src am --keep-non-patch --3way`，无 `src/third_party/blink` 时优雅跳过（exit 0）
- `scripts/check.py` — 镜像未改 `devutils/check_patch.py` 8 项静态检查（<1s）：60 键完整 / 头注释 / doc-segment 对齐 / empty-segment / debug 残留 / hunks / `---a/+++b` 配对 / 隔离
- `scripts/smoke.js` — Electron CDP 烟雾（20+ 面：hardwareConcurrency/screen/Audio/WebGL/Canvas/Geolocation 等，零配置与原生一致）

## Chromium 大版本合流指南（Merge Guide）

> 设计约束：Chromium 升级仅替换**单文件** `fingerprint/patches/fp-fingerprint.patch`，`patches/chromium/.patches` 永不触碰。

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
