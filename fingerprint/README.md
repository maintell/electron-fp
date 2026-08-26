# fingerprint — 隔离目录
本目录与 Electron 主 patch 完全隔离（见 specs/2026-08-26-electron-fingerprint-design.md）。
- patches/fp-fingerprint.patch 单文件来自 ungoogled-chromium-windows，升级时直接替换
- 不改 patches/chromium/.patches，施加由 fingerprint/scripts/apply.py 独立完成
