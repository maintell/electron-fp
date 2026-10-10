# 06 内核补丁（只读 + 回仓改）

本包**不含**内核补丁，也没有任何能力新增/修改键。
键的实现 = 仓库 `fingerprint/patches/`，想动它们必须回仓库走补丁流程。

## 指纹补丁（`fingerprint/patches/`，实测 8 文件）

按文件名顺序施加（`scripts/apply.py`）；`check.py` 守门（键覆盖/头注释/
残留/数量，<1s）。`00-core` 必须最先（它新建的 `fp_config_helpers.h`
被其余文件 include）。

| 补丁 | 内容 |
|---|---|
| `00-core.patch` | 新建 `fp_config_helpers.h`：唯一配置入口（`--fingerprint-config` base64 JSON → env → 文件 → `FP_*` env），仅 Blink 可包含 |
| `10-blink-core.patch` | Blink core：screen / geo / canvas / DOM / timing / font_cache / navigator |
| `20-blink-modules.patch` | Blink modules：WebGL / WebGPU / audio / speech / media / battery / storage |
| `30-webrtc.patch` | WebRTC 自定义 IP（独立仓库、无 `//base` 依赖）+ 注入点 |
| `40-net-tls.patch` | 网络层：`fp_*` 进 `SSLContextConfig` / mojom / `HttpNetworkSessionParams`（TLS 9 键 + H2 3 键的内核侧） |
| `50-electron-glue.patch` | JS 入口：`setSSLConfig({fp*})` 与 `fromPartition(name, {http2Profile})` 的 gin 转换器 |
| `60-electron-inspector.patch` | `electron://fingerprint/` 特权 WebUI（报告所在 BrowserContext 的实时生效配置） |
| `fp-fingerprint.patch` | **已废弃**：拆分前单体，不施加不校验，勿编辑 |

## 顶层 `patches/`（构建依赖，与指纹无关）

说明：任务书写的"15 个目录"与实测不符——实测为 **14 个子目录 + 3 个文件**
（`config.json`、`mtime-cache.json`、`README.md`），以下按实测列出，
用途只写有证据的两项，其余不编造：

`boringssl`、`chromium`（主 patch 系列，`e sync` 合流对象）、
`devtools_frontend`、`ffmpeg`、`libaddressinput`、`nan`、`node`
（node 集成 hunks）、`perfetto`、`ReactiveObjC`、`reclient-configs`、
`sqlite`、`squirrel.mac`、`v8`、`webrtc`。

## 内核层二次开发 = 回仓库（不可脱离）

1. 改 `fingerprint/patches/` 对应子系统补丁（只改失败的那个，不整体重来；
   升级指南见仓库 `fingerprint/README.md`"Chromium 大版本合流指南"）。
2. `python3 fingerprint/scripts/check.py` + `apply.py --dry-run` 必须过。
3. 全量编译验证（`e build` 级别，Chromium 检出 + 30～40 分钟链接）——
   静态检查通过**不等于**能编译（已有多次"检查全绿、编译失败"的实测）。
4. 构建约束（低优先级编译、禁 `npx`、`e` 不可用时的直接调用等）见仓库
   `AGENTS.md` / `CLAUDE.md`，动构建前先读。
