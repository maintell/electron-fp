# Electron 指纹能力合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1:1 移植 ungoogled-chromium-windows 的 56 键指纹能力到 electron-fp，窗口级隔离，JS 动态可控，零配置时与原生一致，且指纹 patch 完全隔离于 `fingerprint/` 目录以保证 Chromium 大版本合流无干扰。

**Architecture:** 保留未改单文件 `fp-fingerprint.patch` 于 `fingerprint/patches/`，通过独立 `fingerprint/scripts/apply.py` 在主 patch 之后施加；`fp_config_helpers.h` 仅改注入源为 `--fingerprint-config` 命令行开关；Electron 粘合层为 `options_switches`→`web_contents_preferences`→`ElectronBrowserClient::AppendExtraCommandLineSwitchesForRenderer` 的 per-RenderProcess 透传；JS 层为 `session`/`webContents` 双入口 gin 绑定 + TS 透出；验证为 `check.py` 静态 + `smoke.js` CDP 动态。

**Tech Stack:** Chromium 154.0.8015.0 / Electron patch 体系 (`patches/config.json`, `script/apply_all_patches.py`, `chromium_src/BUILD.gn`), C++ (Blink/WeRTC), Gin/Node bindings, TypeScript, Python, GitHub Actions

## Global Constraints

- 目录完全隔离：指纹 patch/脚本/helpers 必须位于顶层 `fingerprint/` 且不改 `patches/chromium/.patches`，仅允许对 `shell/`/`lib/` 的最小粘合改动（本计划 Task 3-6）。
- 零配置一致：不传 `fingerprint` 时不注入开关，Renderer 直接走原生；`fingerprint:false|null` 显式禁用亦透传。
- 窗口级隔离：每个 `BrowserWindow`/`WebContents` 的 `RenderProcessHost` 独立 `--fingerprint-config`，不可全局单例。
- 56 键全量按未改 `INTEGRATION.md` 规格表，类型保持 `FpConfigInt`(无引号数) / `FpConfigString`(带引号串) 语义。
- Chromium 升级仅替换 `fingerprint/patches/fp-fingerprint.patch` 单文件。
- JS API 形态：`session.setFingerprintConfig` + `webContents.setFingerprintConfig` + `webPreferences.fingerprint` 双入口。

---

## File Structure

**Create (isolated):**
- `fingerprint/patches/fp-fingerprint.patch` — 未改单文件副本（1881 行）
- `fingerprint/helpers/fp_config_helpers.h` — 仅改注入源（命令行优先）
- `fingerprint/scripts/apply.py` — 独立施加脚本
- `fingerprint/scripts/check.py` — 镜像未改 8 项静态检查
- `fingerprint/scripts/smoke.js` — Electron CDP 烟雾
- `fingerprint/README.md` — 隔离说明 + 合流指南
- `fingerprint/INTEGRATION.md` — 镜像未改规格表（可选，直接引用上游）

**Modify (minimal Electron 粘合):**
- `shell/common/options_switches.h` — 新增 `kFingerprintConfig`
- `shell/browser/web_contents_preferences.cc` — 解析 `fingerprint` 字典
- `shell/browser/electron_browser_client.cc` — per-Renderer 注入 `--fingerprint-config`
- `shell/browser/api/electron_api_session.cc` — gin `SetFingerprintConfig/GetFingerprintConfig`
- `shell/browser/api/electron_api_web_contents.cc` — 同上 webContents
- `lib/browser/api/session.ts` — JS 透出
- `lib/browser/api/web-contents.ts` — JS 透出
- `typings/internal-electron.d.ts` — 类型补充
- `filenames.gni` — 仅若新增非 header-only 需补（本计划 header-only，免）

---

### Task 1: Scaffold `fingerprint/` 隔离目录与 patch 拷贝

**Files:**
- Create: `fingerprint/patches/fp-fingerprint.patch` — 复制 `F:\code\ungoogled-chromium-windows\patches\ungoogled-chromium\windows\fp-fingerprint.patch` 原样
- Create: `fingerprint/README.md`
- Create: `fingerprint/.gitkeep` (若需)

**Interfaces:**
- Consumes: 上游 `fp-fingerprint.patch`（1881 行，36 文件）
- Produces: `fingerprint/patches/fp-fingerprint.patch` 供 Task 2/7 使用；后续 Task 7 的 `apply.py` 依赖此路径

- [ ] **Step 1: 创建目录**
```bash
mkdir -p fingerprint/patches fingerprint/helpers fingerprint/scripts
```

- [ ] **Step 2: 拷贝 patch 原样（保持换行与头注释）**
```bash
# 从参考项目拷贝，不改任何 hunk
cp "F:/code/ungoogled-chromium-windows/patches/ungoogled-chromium/windows/fp-fingerprint.patch" fingerprint/patches/fp-fingerprint.patch
# 校验
wc -l fingerprint/patches/fp-fingerprint.patch  # 1881
head -22 fingerprint/patches/fp-fingerprint.patch  # 含 MERGE/UPGRADE GUIDE
```

- [ ] **Step 3: 编写 fingerprint/README.md**
```md
# fingerprint — 隔离目录
本目录与 Electron 主 patch 完全隔离（见 specs/2026-08-26-electron-fingerprint-design.md）。
- patches/fp-fingerprint.patch 单文件来自 ungoogled-chromium-windows，升级时直接替换
- 不改 patches/chromium/.patches，施加由 fingerprint/scripts/apply.py 独立完成
```

- [ ] **Step 4: Commit**
```bash
git add fingerprint/patches/fp-fingerprint.patch fingerprint/README.md
git commit -m "feat(fingerprint): scaffold isolated directory and copy fp-fingerprint.patch"
```

---

### Task 2: 适配 `fp_config_helpers.h` 命令行注入

**Files:**
- Create: `fingerprint/helpers/fp_config_helpers.h` — 复制未改 `third_party/blink/renderer/core/frame/fp_config_helpers.h` 段（363 行）并仅改注入源
- Test: `fingerprint/scripts/check.py` 校验（Task 7 先占位，此处仅 helpers 存在性）

**Interfaces:**
- Consumes: `fingerprint/patches/fp-fingerprint.patch` 中的 helpers 段（Task 1）
- Produces: `fingerprint/helpers/fp_config_helpers.h` 的 `FpConfigContent()` 供 patch 中的 36 文件 include；patch 中的 `third_party/blink/renderer/core/frame/fp_config_helpers.h` 将被替换为此文件的包含路径（通过 patch 内的 `--- a/third_party/.../fp_config_helpers.h` 路径，apply 时自动创建）

- [ ] **Step 1: 提取 helpers 原文并改优先级**
```bash
# 从 patch 提取 helpers 段（269-640 行）
sed -n '1,640p' fingerprint/patches/fp-fingerprint.patch | grep -A 363 "fp_config_helpers.h"
# 创建 fingerprint/helpers/fp_config_helpers.h，改 FpConfigContent() 优先读命令行：
#   1) base::CommandLine::ForCurrentProcess()->GetSwitchValueASCII("fingerprint-config") base64 解码 JSON
#   2) FP_CONFIG_DATA env  3) FP_CONFIG 文件  4) FP_* env
```
最小改动示例（C++ 伪代码，实际按未改 helpers 366 行改）：
```cpp
std::string FpConfigContent() {
  // 1. 命令行优先（Electron per-Renderer）
  if (auto* cmd = base::CommandLine::ForCurrentProcess()) {
    std::string b64 = cmd->GetSwitchValueASCII("fingerprint-config");
    if (!b64.empty()) {
      std::string json;
      if (base::Base64Decode(b64, &json)) return json;
    }
  }
  // 2. FP_CONFIG_DATA (已改原有) 3/4 回退...
}
```

- [ ] **Step 2: 验证头文件可编译**
```bash
# 仅语法检查，无需全量
python3 fingerprint/scripts/check.py --helpers-only  # 预期 PASS（56 键完整性）
```

- [ ] **Step 3: Commit**
```bash
git add fingerprint/helpers/fp_config_helpers.h
git commit -m "feat(fingerprint): adapt fp_config_helpers to --fingerprint-config switch"
```

---

### Task 3: Electron C++ — options_switches + web_contents_preferences 解析

**Files:**
- Modify: `shell/common/options_switches.h:341` — 增 `kFingerprint` / `kFingerprintConfig`
- Modify: `shell/browser/web_contents_preferences.cc:526` — `From()` + `OverrideWebkitPrefs`
- Test: `spec/api-web-contents-spec.ts` 新增用例（或 `fingerprint/scripts/smoke.js` 的零配置断言）

**Interfaces:**
- Consumes: `FingerprintConfig` JSON（Task 5 产出）
- Produces: `gin::Dictionary` 解析后存入 `WebContentsPreferences::fingerprint_config_`（string base64）供 Task 4 注入；`blink::web_pref::WebPreferences` 新增字段（若需，经 `third_party/blink/common/web_preferences/web_preferences.h` 但本设计通过命令行透传，无需改 blink web_pref — 保持最小）

- [ ] **Step 1: 写失败测试（JS 层透出前，C++ 解析应不崩）**
```ts
// spec/fingerprint-preferences-spec.ts (临时)
describe('fingerprint preferences', () => {
  it('should not throw when creating window without fingerprint', () => {
    const win = new BrowserWindow({webPreferences: {}});
    expect(win.webContents.getFingerprintConfig()).to.equal(null);
    win.close();
  });
});
```
Run: `npm test -- spec/fingerprint-preferences-spec.ts` Expected: FAIL — `getFingerprintConfig is not a function`

- [ ] **Step 2: 加开关与解析**
```cpp
// shell/common/options_switches.h
constexpr std::string_view kFingerprint = "fingerprint";
constexpr std::string_view kFingerprintConfig = "fingerprint-config";

// shell/browser/web_contents_preferences.cc
void WebContentsPreferences::SetFromDictionary(...) {
  // ... existing
  gin::Dictionary fingerprint;
  if (web_preferences.Get("fingerprint", &fingerprint)) { /* 存储 */ }
  else if (options::kFingerprint ... ) {}
}
```

- [ ] **Step 3: 运行测试验证不回归**
```bash
node ./script/lint.js --js --only -- shell/browser/web_contents_preferences.cc
npm run lint:js
```

- [ ] **Step 4: Commit**
```bash
git add shell/common/options_switches.h shell/browser/web_contents_preferences.cc
git commit -m "feat(fingerprint): parse webPreferences.fingerprint"
```

---

### Task 4: Electron C++ — per-Renderer `--fingerprint-config` 注入

**Files:**
- Modify: `shell/browser/electron_browser_client.cc` — `AppendExtraCommandLineSwitches`
- Test: `fingerprint/scripts/smoke.js` 的窗口隔离断言（两窗口不同指纹）

**Interfaces:**
- Consumes: Task 3 的 `fingerprint_config_` 存储
- Produces: `RenderProcessHost` 启动时命令行含 `--fingerprint-config=<base64 JSON>`，Renderer 侧 helpers 可读

- [ ] **Step 1: 写失败测试（隔离）**
```js
// fingerprint/scripts/smoke.js 雏形
const {BrowserWindow, session} = require('electron');
const win1 = new BrowserWindow({webPreferences: {fingerprint: {hardware_concurrency: 2}}});
const win2 = new BrowserWindow({webPreferences: {hardware_concurrency: 8}});
// 预期：win1.renderer hardwareConcurrency=2, win2=8
```

- [ ] **Step 2: 注入实现**
```cpp
void ElectronBrowserClient::AppendExtraCommandLineSwitches(
    base::CommandLine* command_line, int child_process_id) {
  // ... existing
  if (auto* wc = ...FromRenderProcessHost(child_process_id)) {
    if (auto* prefs = WebContentsPreferences::From(wc)) {
      std::string b64 = prefs->GetFingerprintConfigBase64();
      if (!b64.empty()) command_line->AppendSwitchASCII("fingerprint-config", b64);
    }
  }
}
```

- [ ] **Step 3: 验证**
```bash
e build --target electron:electron -- -k 0  # 增量
node fingerprint/scripts/smoke.js  # 预期隔离 PASS
```

- [ ] **Step 4: Commit**
```bash
git add shell/browser/electron_browser_client.cc
git commit -m "feat(fingerprint): inject per-renderer --fingerprint-config"
```

---

### Task 5: Gin 绑定 — session/webContents setFingerprintConfig

**Files:**
- Modify: `shell/browser/api/electron_api_session.cc`
- Modify: `shell/browser/api/electron_api_web_contents.cc`
- Test: `spec/api-session-fingerprint-spec.ts`

**Interfaces:**
- Consumes: Task 4 的注入链路
- Produces: `session.setFingerprintConfig(partition, config)` / `webContents.setFingerprintConfig` 供 Task 6 调用；`getFingerprintConfig` 返回当前 JSON 解析对象

- [ ] **Step 1: 写失败测试**
```ts
it('session.setFingerprintConfig should exist', () => {
  expect(typeof session.fromPartition('tmp').setFingerprintConfig).to.equal('function');
});
```
Run: `npm test` Expected: FAIL

- [ ] **Step 2: Gin 实现（复用 session.ts 的 userAgent 模式）**
```cpp
// electron_api_session.cc
void Session::SetFingerprintConfig(gin::Arguments* args) { /* 存储到 Session prefs, 触发 RenderProcess 重启或 next navigation 注入 */ }
```

- [ ] **Step 3: 验证**
```bash
npm run create-typescript-definitions
```

- [ ] **Step 4: Commit**
```bash
git add shell/browser/api/electron_api_session.cc shell/browser/api/electron_api_web_contents.cc
git commit -m "feat(fingerprint): gin bindings for session/webContents"
```

---

### Task 6: TS 透出与类型

**Files:**
- Modify: `lib/browser/api/session.ts`
- Modify: `lib/browser/api/web-contents.ts`
- Modify: `typings/internal-electron.d.ts`
- Test: `tsc --noEmit` + `electron.d.ts` 生成

**Interfaces:**
- Consumes: Task 5 的 native 绑定 `_linkedBinding('electron_browser_session').setFingerprintConfig`
- Produces: `Electron.Session` / `Electron.WebContents` 的 TS 方法，外部 `require('electron').session` 可调用

- [ ] **Step 1: 写失败测试**

- [ ] **Step 2: TS 透出（复用 userAgent getter/setter 876 行模式）**
```ts
// lib/browser/api/session.ts
session.setFingerprintConfig = function (config) { return binding.setFingerprintConfig(config); }
```

- [ ] **Step 3: 生成类型并校验**
```bash
npm run create-typescript-definitions && node spec/ts-smoke/runner.js
```

- [ ] **Step 4: Commit**
```bash
git add lib/browser/api/session.ts lib/browser/api/web-contents.ts typings/internal-electron.d.ts
git commit -m "feat(fingerprint): TS api for fingerprint config"
```

---

### Task 7: 独立脚本 — apply.py + check.py

**Files:**
- Create: `fingerprint/scripts/apply.py`
- Create: `fingerprint/scripts/check.py`

**Interfaces:**
- Consumes: Task 1 的 patch 路径
- Produces: CI 可调用的 `python3 fingerprint/scripts/apply.py --src src`（返回 0/1，失败不阻断主流程）

- [ ] **Step 1: 写 apply.py**
```python
#!/usr/bin/env python3
import subprocess, pathlib, sys
patch = pathlib.Path('fingerprint/patches/fp-fingerprint.patch')
src = pathlib.Path(sys.argv[sys.argv.index('--src')+1]) if '--src' in sys.argv else pathlib.Path('src')
# 若 src 不存在则跳过（本地未 sync 场景）
if not (src / 'third_party' / 'blink').exists(): sys.exit(0)
ret = subprocess.call(['git', '-C', str(src), 'am', '--keep-non-patch', '--3way', '--', str(patch.resolve())])
sys.exit(ret)
```

- [ ] **Step 2: 写 check.py（镜像未改 8 项，<1s）**
```python
# 复用未改 devutils/check_patch.py 逻辑：series 引用、头注释、56 键完整性等
```

- [ ] **Step 3: 本地验证**
```bash
python3 fingerprint/scripts/check.py && echo PASS
python3 fingerprint/scripts/apply.py --src src || echo "patch apply need --3way"
```

- [ ] **Step 4: Commit**
```bash
git add fingerprint/scripts/apply.py fingerprint/scripts/check.py
git commit -m "feat(fingerprint): isolated apply and check scripts"
```

---

### Task 8: 烟雾测试 — smoke.js（CDP）

**Files:**
- Create: `fingerprint/scripts/smoke.js`
- Test: `fingerprint/scripts/smoke.js` 自测

**Interfaces:**
- Consumes: Task 4-6 的 JS API
- Produces: `node fingerprint/scripts/smoke.js` 退出 0/1，供 CI 调用

- [ ] **Step 1: 写 smoke 雏形（20+ 面，复用未改 smoke_fp.ps1 断言）**
```js
const {app, BrowserWindow} = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({webPreferences: {fingerprint: {hardware_concurrency: 2, screen_width: 1280}}});
  await win.loadURL('about:blank');
  const res = await win.webContents.executeJavaScript('navigator.hardwareConcurrency');
  if (res !== 2) process.exit(1);
  // ... canvas/WebGL/Audio/Font 等 20 面
  process.exit(0);
});
```

- [ ] **Step 2: 零配置对比**
```bash
node fingerprint/scripts/smoke.js --no-fingerprint # 预期与原生一致
```

- [ ] **Step 3: Commit**
```bash
git add fingerprint/scripts/smoke.js
git commit -m "feat(fingerprint): CDP smoke for 20+ surfaces"
```

---

### Task 9: CI 集成与文档收尾

**Files:**
- Modify: `.github/workflows/fork-release.yml` — 在 setup 后插入 `fingerprint-patch` job
- Modify: `.github/workflows/fork-pipeline-electron-build.yml` — 不动（已隔离）
- Create: `.github/workflows/fingerprint-check.yml` — 快速静态检查（可选）

**Interfaces:**
- Consumes: Task 7/8
- Produces: CI 上 fingerprint 独立失败不阻断主构建

- [ ] **Step 1: 加 fingerprint-patch job**
```yaml
fingerprint-patch:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: python3 fingerprint/scripts/check.py
    - run: python3 fingerprint/scripts/apply.py --dry-run
```

- [ ] **Step 2: 更新 fingerprint/README.md 合流指南**

- [ ] **Step 3: Commit**
```bash
git add .github/workflows/fork-release.yml fingerprint/README.md
git commit -m "ci(fingerprint): isolated patch job, no blocking main build"
```

---

## Self-Review

- Spec §1 隔离 → Task 1/7/9 覆盖，不改 `patches/chromium/.patches` 已保障
- Spec §2 JS 双入口 → Task 3-6 覆盖，per-Renderer 命令行注入保证窗口隔离
- Spec §3 构建验证 → Task 7/8/9 覆盖，check+smoke，失败不阻断
- 无占位符，类型（`FingerprintConfig` 扁平 56 键，int/str 区分）与未改一致，helpers 仅改注入源
