# Current Architecture（现状审计，2026-09-24）

> 只描述现状，不做设计。所有结论带精确路径+行号证据。行号为审计时实测值，改动后以 grep 复核为准。

---

## 1. Main 入口与生命周期（Client）

- `Client/main.js:1330-1333`：`app.whenReady().then(() => { setupIPC(); createMainWindow(); })`。
- `Client/main.js:1335-1337`：`window-all-closed → app.quit()`；`activate → createMainWindow()`（`:1339-1341`）。
- `Client/main.js:486-493`：首屏 `did-finish-load` 后开 3 个 tab：1 个 default 空白 + `FP_AUDIT_SITES`（`:55-58`，browserleaks + creepjs）2 个审计站，最后焦点交还 tab 1。

## 2. 主窗口 BrowserWindow（Client）

- `Client/main.js:445-457`：`1400x900`（min 600x400），`webPreferences: { preload, contextIsolation:true, nodeIntegration:false, sandbox:false }`，`loadFile renderer/index.html`（`:459`）。
- `resize` 事件调 `resizeActiveView()`（`:462-465`）；`closed` 时逐个 `close()` tab view（`:467-473`）。

## 3. per-tab BrowserView（Client）

- `Client/main.js:185-191`：`createTabView(tabId, profileId)`，每 tab 独立 partition `` `fp-tab-${tabId}` ``（`:191`），cookie/storage 全隔离。
- `Client/main.js:217-227`：BrowserView flags 与主窗口一致（`contextIsolation:true, nodeIntegration:false, sandbox:false`）+ `partition` + `fingerprint: blinkFp`（null 即原生，不传）。
- `Client/main.js:269-277`：`recreateTabView` 复用**同一 partition**（cookie 保留），respawn renderer 使新 `--fingerprint-config` 生效；H2 冻结只比对上报（`:287-293`）。

## 4. MClient：per-group 隔离模型

- `MClient/main.js:482-484`：`createGroupView(group, tabId)`，partition 按组共享 `` `fp-group-${group.id}` ``（`:484`）；组内 tabs 共享 cookie/storage/UA/TLS/H2，组间隔离（`:473-480` 注释）。
- `MClient/main.js:521-582`：`recreateGroupViews` 重建组内**全部** view，同一 partition；H2 drift 比对（`:534-541`），TLS 先行（`:548-555`）。
- `MClient/main.js:136-154`：`applyTabUserAgent` 与 Client 同构（H2 搭首次 `fromPartition` 便车，`:147-150`）。

## 5. mini-browser 参考实现

- `fingerSDK/samples/mini-browser/main.js:14`：`PARTITION = 'persist:sdk-mini'`（唯一带 `persist:` 的生产路径）。
- `:38-71` 顺序不可换（注释写明镜像 `MClient/main.js createGroupView`）：① H2 搭首次 `fromPartition`（`:44-46`）→ ② `setUserAgent` 先于 view 构造（`:51`）→ ③ `setSSLConfig` 先于首 socket（`:55`）→ ④ `fingerprint` webPreference 经 `--fingerprint-config` 注入（`:61-67`）。

## 6. Renderer

- `Client/renderer/app.js` 924 行 + `Client/renderer/index.html`（169 行）+ `Client/renderer/style.css`（638 行）。
- `Client/renderer/index.html` 右侧 `#ap-panel`（Wave16）：嵌入 automation 面板（`automation-panel/panel.js` DOMContentLoaded 自动挂载），与 `#fp-panel` 共用同一 420px 列且互斥；`app.js applyPanelLayout()` 统一 `panel:set-open` 布尔（任一列开即让位）。真窗验证 `Client/test-automation-panel.js` 19 PASS + 真桥 E2E `test-automation-panel-bridge.js` 6 PASS + 降级 E2E `test-automation-panel-degrade.js` 5 PASS（templates 区 `#ap-templates` 兄弟节点、`#ap-panel-body` 为滚动容器、probeBridge 对 no-handler 降级）；默认运行带 runtime：`resources/automation` ← `automation/{electron,runtime,package.json}`（守护 `Client/test-packaged-automation.js` 12 检查；CommonJS 标记防 `out/Default/package.json` 的 `type:module` 把 require 变 ESM）。
- `MClient/renderer/app.js` 1478 行，Client 的超集：+ groups（`:42` 起 proxy 段、`:1456` agent 事件）、proxy UI（`:518-573`）、`fp-group-tls/h2` 分组渲染（`:817-841`）。
- `Client/layout.js` / `MClient/layout.js`（各 52 行）：`TOP_HEIGHT=72 / STATUS_HEIGHT=22 / PANEL_WIDTH=420` + 纯函数 `viewBounds()`，main 与 test-panel 共用，防漂移。

## 7. preload（隔离桥）

- `Client/preload.js:3-63`：`contextBridge.exposeInMainWorld('api')`，全部 `ipcRenderer.invoke`，无 Node 直通（`:5-6` 注释）。
- `Client/preload.js:51-59`：`on()` 白名单仅 6 个 `tab:*` 事件（created/closed/activated/title-updated/navigated/profile-changed）。
- `MClient/preload.js`（77 行）：增量 `group:*`（create/close/activate/list/set-profile）、proxy（`get/setGroupProxy :22-23`）、agent（`agentStart/Stop/GetConfig/SetConfig/Approve :62-66`）、事件白名单 + `group:*/agent:event`（`:75-81`）。

## 8. IPC（风险点）

- `Client/main.js:499-665`：20 个 `ipcMain.handle`：`tab:*`（create/close/activate/navigate/list/get-active/get/set-fingerprint/get/set-ua/toggle-devtools）、`panel:set-open`（`:618`）、`profile:*`（list/get/create/update/delete/randomize，`:625-654`）、`app:versions`（`:668`）、`ua:*`（`:676,682`）、`fp:schema/coverage`（`:689,706`）、`selftest:run`（`:728`）。
- **IPC sender 校验（原审计结论已过时）**：原文称全部 handler 忽略 `e`；现 Client / MClient 的全部 `ipcMain.handle` 已包 `checked()`（`senderAllowed`：仅接受主窗口 webContents 或其同 URL 帧），伪造 `tabId`/`groupId` 被拒——Client `main.js:521-549`、MClient `main.js:888-915`。Automation 通道另在 `automation/electron/wire` 内层 allowlist。
- MClient 增量：`group:set-proxy/get-proxy`（`:883-884`）、`agent:start/stop/config/approve`（`MClient/main.js:1293-1297`，经 `MClient/agent/engine.js`）。

## 9. Window / View / WebContents

- `shell/browser/api/electron_api_web_contents.cc:1365-1392`：`WebContentsCreatedWithFullParams` 承接 `setWindowOpenHandler` 传下的 child prefs。
- `Client/main.js:400-439`：`activateTab` 先 `removeBrowserView` 全部再 `addBrowserView` 当前（`:405-416`）；`navigateTab`（`:422-439`）正则补 `https://`/search fallback（`:427-434`），裸 `loadURL`（`:438`）。
- **导航守卫（原审计结论已过时）**：原文称 Client、MClient 主进程无 `setWindowOpenHandler` / `will-navigate` 守卫、grep 零命中；现均已补齐——Client `main.js:462-463`、MClient `main.js:822-825`（`setWindowOpenHandler(() => ({ action: 'deny' }))` + `will-navigate` 拦截）。

## 10. Chromium 参数层

- `shell/browser/web_contents_preferences.cc:100-120`：prefs 解析（sandbox/nodeIntegration/offscreen/blinkFeatures）。
- `:129-145` `AppendCommandLineSwitches`：sandbox→`kEnableSandbox`，否则 `kNoSandbox + kNoZygote`。
- 默认 `contextIsolation=true`（`:210`）、`webSecurity=true`（`:216`）。
- `shell/browser/web_contents_preferences.h:126-139`：`CanUseSpareRenderer()` 在 fp 非空时返回 false（防无 fp 的 spare renderer 被复用）。

## 11. Profile（扁平 JSON，无 DB）

- `Client/main.js:26-38` / `MClient/main.js:29-41`：`PROFILES_PATH = __dirname/profiles.json`，`load/saveProfiles` 同步读写，无 DB（sqlite/leveldb/lowdb grep 零命中）。
- `Client/profiles.json` 形如 `{profiles:[{id,name,fingerprint,userAgent,createdAt}]}`。
- CRUD 经 IPC `profile:list/get/create/update/delete/randomize`（`Client/main.js:625-654`）。
- 无账号概念；MClient `originProfileId` 不可变（`:621`，proxy 密码 key）vs `profileId` 可变（`:409,424` 置 `custom`）。
- `Client/test-app-copy-sync.js:19-20`：`profiles.json` 被排除在 copy-sync 比对外（用户数据）。

## 12. Data dir（持久化缺口）

- Client 主进程无 `userData/setPath` 调用 → 默认 Chromium userData。
- MClient 仅 agent（`MClient/agent/engine.js:80-85`，`appData/mclient-agent` + `MClient/agent-config.json`）与 proxy 密码（`MClient/main.js:357-359`）用 `appData`。
- `fp-tab-*` / `fp-group-*` 均**无 `persist:` 前缀 = 内存 partition**，重启丢 cookie/storage；`persist:*` 只出现在 tests（`record-baseline.js:42` 等）。

## 13. Cookie / Storage

- 主进程零 `clearStorageData` / cookies API 调用（Client、MClient grep 零命中）。
- Client 按 tab 隔离（partition 见 `:191` 创建、`:277` 重建）；MClient 按组共享（组内 tabs 同一 session）。

## 14. Proxy（仅 MClient，第四平面）

- Client 无 proxy 能力。
- `MClient/main.js:253-314` `normalizeGroupProxy`（mode 校验、URL 拆 creds、direct/system 自动升级 fixed/pac、空 rules 拒绝）；`:323-352` `applyGroupProxy`（`fixed_servers` / `pac_script` / direct / system）。
- `:354-379` safeStorage 加密 `.bin`，按 `originProfileId` 一文件（`MCLIENT_PROXY_DIR` 可覆盖供测试）。
- `:1896-1910` 全局 `app.on('login')` 只答持有密码组的 proxy 407。
- `profile.proxy` 持久化平面（`:605-618`，密码被拒收并警告）；`setGroupProxy` 全流程 `:396-430`。

## 15. 指纹四平面

- **Blink**：`fingerprint` webPreference → `--fingerprint-config`（base64 JSON），WC 优先、缺席继承 Session：`shell/browser/electron_browser_client.cc:697-709`，`web_contents_preferences.cc:324-346`。
- **UA**：`session.setUserAgent`，必须先于 view 构造（`Client/main.js:100-114`，实测已开 session 不生效）。
- **TLS**：`session.setSSLConfig`，必须先于首 socket（`Client/main.js:136-163`，类型预检 + cipher foot-gun 拦截）。
- **H2**：`fromPartition(name, {http2Profile})` 首调冻结，后续静默丢弃（`Client/main.js:102-113` 实测矩阵）。
- `Client/fp-schema.js:979` `fpSplitConfig` 唯一分流点；`FP_TLS_KEYS:598`（9 键）；`FP_H2_KEYS:686`（3 键）。
- `Session::Set/GetFingerprintConfig`（`shell/browser/api/electron_api_session.cc:1171-1209`）、`WebContents::Set/Get`（`electron_api_web_contents.cc:3293-3334`）：dict→JSON→b64。
- `fingerprint/helpers/fp_config_helpers.h`：`FpConfigContent()` 优先级 `--fingerprint-config > FP_CONFIG_DATA > FP_CONFIG > FP_<key>`（`:45-72`）；`FpTrim` 只剪尾部（`:32-38`，前导空白陷阱）；`FP_<key>` 回退仅 Int/Int64，String 无（`:44` 注释）。

## 16. 生命周期

- `whenReady → setupIPC + createMainWindow`（Client `:1330-1333`；MClient `:1787-1790` 外加 `MCLIENT_LIB_MODE=1` 守卫 `:1786`，测试可 require 为库）。
- `window-all-closed → quit`（Client `:1335-1337`；MClient `:1792-1794`）。
- MClient 启动同样开审计站（`:847-855`，按组）。

## 17. DevTools / CDP

- `--remote-debugging-port` 缺席（默认关闭）；若传入则 `DevToolsManagerDelegate::StartHttpHandler` 绑 `127.0.0.1` 临时端口（`shell/browser/ui/devtools_manager_delegate.cc:63-80`），`/json/list + ws` 全 CDP，`Browser.close → Quit`（`:121-131`）。
- `wc.debugger.attach/sendCommand/detach` 无鉴权（`shell/browser/api/electron_api_debugger.cc:113,148`）；生产代码从不 attach，唯一调用是 `MClient/test-coverage-audit.js:430-435`。
- `tab:toggle-devtools`（`Client/main.js:657-665`，detach 模式）；原生 `enableDeviceEmulation`（`electron_api_web_contents.cc:3442`）；`executeJavaScript(PROBE)` 仅 main 侧自测用（`Client/main.js:769`，15s 超时）。

## 18. Permission

- 原生 `setPermissionRequestHandler`（`shell/browser/api/electron_api_session.cc:1003-1108`）。
- Client/MClient 主进程**从未注册**；唯一注册是测试 geolocation-only（`Client/test-coverage-audit.js:81-82`）。
- 效果：无 handler 时默认 GRANTED（`shell/browser/electron_permission_manager.cc:226-249`，除 MIDI/地理围栏特例），任何站点权限请求无拦截。

## 19. DB / task / log / 账号

- 无 DB（见 §11）；无账号体系（见 §11）。
- Client 无 task/log 概念；MClient agent 日志按 runId 追加 jsonl（`MClient/agent/engine.js:82,107-109`），key 经 safeStorage 存 `agent-key.bin`（`:76-106`）。
- `MAX_ROUNDS = 15`（`MClient/agent/engine.js:11`）。

---

## 20. 可直接复用

- `fpSplitConfig` + `FP_TLS/H2_KEYS`（`Client/fp-schema.js`，MClient 已同文件复用——三份 `fp-schema.js`：`Client/`、`MClient/`、`fingerSDK/sdk/`，内容是否漂移需 `diff` 确认）。
- `layout.js` 纯函数（两 Client 各一份，52 行同构）。
- `applyTabUserAgent / applyTabTLSConfig` 顺序约束注释（Client `:86-179` ≈ MClient `:120-189`）。
- `test-app-copy-sync.js` 白屏守卫思想（`:1-20`）。
- mini-browser 四步顺序（`fingerSDK/samples/mini-browser/main.js:38-71`）。

## 21. 需重构

- Client ↔ MClient `main.js` 约 80% 重复（tab 管理、IPC、selftest、random profile），仅隔离粒度不同。
- `fp-schema.js` 三份并存（见 §20），改一处需同步三处。
- preload 两份 182（Client）/77（MClient）行，能力已不互为超集（Client 增 `automationApi`），可合并为一份条件暴露。

## 22. 缺失能力

- Cookie/storage 清理 API（§13）；`persist:` 持久 partition 选项（§12）。
- ~~`setWindowOpenHandler / will-navigate` 导航守卫（§9）~~ — **已补齐**（Client `main.js:462-463`、MClient `main.js:822-825`）。
- 权限 handler 注册（§18）；Client 侧 proxy（§14）；账号体系（§11、§19）。

## 23. 技术风险

1. ~~**IPC 零校验**（§8）~~ — **已补齐**：全部 handler 经 `checked()` / `senderAllowed` 门控（Client `main.js:521-549`、MClient `main.js:888-915`）。
2. **H2 冻结静默丢弃**：误传即无声失效，仅靠 `h2Refused` 上报（`Client/main.js:287-293`）。
3. **TLS 类型错配静默跳过**：`options.Get()` 失败无日志，靠 `fpTlsValidateTypes` 预检兜底（`:147-151`）。
4. **`FpTrim` 前导空白陷阱**（§15）：`FP_CONFIG` 前导空格静默失效。
5. **内存 partition**（§12）：重启丢会话，用户无感知。
6. **权限默认放行**（§18）+ **无导航守卫**（§9）：外跳 + 权限双开口。

## 24. 禁止重复实现

- 不得新建 Browser / Profile / IPC manager 抽象——两 Client 已有实现，新增即第四份重复。
- Client ↔ MClient 不得 naive 合并：per-tab（`fp-tab-*`）与 per-group（`fp-group-*`）partition 语义不兼容，合并需先统一隔离模型。
- 不得新增第四份 `fp-schema.js`；改动必须三份同步（或先做去重）。
- 不得绕过 `fpSplitConfig` 分流——raw profile 直传即丢 TLS/H2 平面（`Client/main.js:193-201` 实测教训）。
