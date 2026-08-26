# Fork Release — maintell/electron-fp 发版指南

> 适用于 `https://github.com/maintell/electron-fp` 的完整编译发版流水线，已配置 GitHub Actions 自动发布到本仓库的 Releases。

## 第一性原理审视（必读）

1. **隐含假设破除**：上游 `electron/electron` 的 CI 不是“标准 GitHub Actions”——它依赖 ARC 自托管大规格 Runner（32 核、100GB+ 磁盘、`/mnt/cross-instance-cache`、`ghcr.io/electron/build` 镜像、SISO 远端执行、Azure SAS/AKS 缓存、RBE 私有集群、`CHROMIUM_GIT_COOKIE`、sudowoodo 签发等）。fork 直接复制 `build.yml`/`release-build.yml` 会因 `if: github.repository == 'electron/electron'` 被跳过，或因缺挂载/密钥而失败。
2. **完整编译的成本**：Electron release 编译 = Chromium + Node + V8 全量编译，单平台 80GB 磁盘、32GB 内存、3-6 小时，即使上游也需专用 runners。指望 `ubuntu-latest`/`macos-15`/`windows-latest` 免费规格跑全量编译会 OOM/磁盘爆/超时。
3. **本方案的取舍**：不试图 1:1 复刻上游私有基建。保留编译链路，移除仓库门禁，将发布从 `electron/electron`+sudowoodo 改为本仓库 `GITHUB_TOKEN` 直发 Release；并在 `fork-pipeline-electron-build.yml` 中加入缓存 miss 时回退到完整 `gclient sync`（慢但可用）。最小差分、易于与上游同步。

---

## 已交付内容

- `.github/workflows/fork-release.yml` — 主流程：`push tag v*` 或 `workflow_dispatch` 触发 → 解析版本 → 构建 3 平台的 release → 聚合上传到本仓库 Release。
- `.github/workflows/fork-pipeline-electron-build.yml` — fork 友好的编译分片：复刻上游 `pipeline-segment-electron-build.yml`，恢复缓存失败时自动 `gclient sync`，不强依赖 `/mnt/cross-instance-cache` 与 Azure。
- 复用上游 `pipeline-segment-build-siso.yml` 构建 SISO（无 repo 门禁，纯 `ubuntu-latest` 可跑）。

`skipped: 上游的 checkout 缓存强依赖与 sudowoodo 发布；add when 你自托管了 ARC/AKS 缓存或需要上游同款远端执行`

## 触发方式

### 方式 A — 推 tag（推荐）

```bash
# 本地打 tag 并推送，CI 自动编译并发布
git tag v32.0.0-fp.1
git push origin v32.0.0-fp.1
# 可选：带注释/签名
# git tag -a v32.0.0-fp.1 -m "fp release 1"
```

推送后在 Actions 观测 `Fork Release`。完成后访问 `https://github.com/maintell/electron-fp/releases/tag/v32.0.0-fp.1`。

### 方式 B — 手动 Dispatch

Actions → Fork Release → Run workflow → 填 `version`（如 `v32.0.0-fp.2`）。注意：手动填的 `version` 仅决定 Release 的 `tag_name`；构建产物的版本号仍由 `git describe` 决定，若该 tag 尚未推送到远端，产物名可能与 Release tag 不一致。**正式发版请用方式 A**。

### 按需跳过平台

`workflow_dispatch` 的 `skip-linux/skip-macos/skip-windows` 可只编单一平台以节省资源/时间。`push tag` 默认全平台。

## 产出与命名

构建产物由 `script/lib/config.py` 的 `get_zip_name` 决定，形如：

- `electron-v32.0.0-fp.1-linux-x64.zip`
- `electron-v32.0.0-fp.1-linux-arm64.zip`
- `electron-v32.0.0-fp.1-darwin-x64.zip` / `electron-v32.0.0-fp.1-darwin-arm64.zip`
- `electron-v32.0.0-fp.1-mas-x64.zip` / `-mas-arm64.zip`
- `electron-v32.0.0-fp.1-win32-x64.zip` / `-win32-arm64.zip`
- 伴随 `*-symbols.zip`、`*-dsym.tar.xz`（macOS）、`*-pdb.zip`（Windows）、`*-debug.zip`（Linux）、`chromedriver-*.zip`、`mksnapshot-*.zip`、`ffmpeg-*.zip`、`hunspell_dictionaries.zip`、`electron-api.json`、`electron.d.ts` 等

聚合上传由 `softprops/action-gh-release@v2` 扁平化收集 `generated_artifacts_*` 中的 `*.zip/*.tar.xz/*.json/electron.d.ts`。

## Runner 与资源要求

| 平台 | 默认 runs-on（fork 托管） | 上游原配置 | 说明 |
|------|---------------------------|------------|------|
| linux | `ubuntu-22.04` + `ghcr.io/electron/build:daad061f...` 容器 | `electron-arc-centralus-linux-amd64-32core` | 托管规格磁盘小，建议自托管或增大磁盘（`free-space` 已在流程中） |
| macOS | `macos-15` | `macos-15-xlarge` | 上游 xlarge 为 14GB+ 内存；托管 `macos-15` 可能需多次 swap，建议自托管 |
| windows | `windows-2022` | `garm-windows-x64-32core` | 同上，托管 win 可能超时 |

**自托管建议**：若你有自托管 ARC，可把 `fork-release.yml` 中的 `build-runs-on` 改回上游值（`electron-arc-...` / `garm-windows-...` / `macos-15-xlarge`），并把 `build-container` 挂载 `/mnt/cross-instance-cache` 与 `/var/run/sas`，可恢复上游的秒级缓存恢复。

## Secrets / Vars

| 名称 | 必需 | 说明 |
|------|------|------|
| `GITHUB_TOKEN` | 自动提供 | 发布到本仓库 Release 需 `contents: write`（本工作流已声明） |
| `CHROMIUM_GIT_COOKIE` | 可选但推荐 | 私有 Chromium 依赖的 git cookie；缺省时公开同步可能失败，公开构建若成功可留空 |
| `CHROMIUM_GIT_COOKIE_WINDOWS_STRING` | Windows 可选 | 同上，Windows 专用 |
| `PATCH_UP_APP_CREDS` | 可选 | 上游用于自动修补 patches 的 GitHub App 凭据，fork 可留空 |
| `ELECTRON_RBE_JWT` / `DD_API_KEY` 等 | 可选 | 远端执行/观测，留空则本地执行 |

无需 `ELECTRON_GITHUB_TOKEN`/`SUDOWOODO_EXCHANGE_URL`——已改为 `softprops` 直发。

## 本地验证与同步

```bash
# 校验 YAML
npx --yes js-yaml .github/workflows/fork-release.yml > /dev/null && echo "fork-release OK"
npx --yes js-yaml .github/workflows/fork-pipeline-electron-build.yml > /dev/null && echo "fork-pipeline OK"

# 预览将发布的文件（本地 dry-run，不真编译）
git tag --list | tail

# 同步上游后，注意保留 fork-release 两个文件；上游的 pipeline-segment 更新时可对比合并
```

## 常见问题

- **Q: 为什么 tag 推送后没有触发？** 检查 tag 是否符合 `v*.*.*` 或 `v*.*.*-*`（如 `v32.0.0-fp.1` 命中第二条）。`v32` 不命中。
- **Q: 构建卡在 `gclient sync` 很久？** 无缓存回退会完整克隆 Chromium（~30GB），首次 30-60 分钟正常；自托管并挂载缓存可加速。
- **Q: 如何只发 Linux？** `workflow_dispatch` 勾选 `skip-macos` 与 `skip-windows`，或临时推送 tag 后在 Actions 界面 Cancel 其它平台。
- **Q: 需要改 branding 吗？** 产物名由 `shell/app/BRANDING.json` 的 `project_name` 决定，保持 `electron` 即可与 `electron/electron` 兼容；若改名需同步 `get_zip_name` 与下游 `electron-download` 逻辑。

## 回滚/禁用

在仓库 Settings → Actions → disable workflow，或删除两个 `fork-*.yml` 即可恢复到仅上游工作流（但上游工作流在 fork 本就不会运行）。

---

# ponytail: 本文档包含资源现实与自托管升级路径已足够；后续如需生成 SBOM/attestation 或按 nightly/stable 分流，再补充新 workflow 而非膨胀本文件。
