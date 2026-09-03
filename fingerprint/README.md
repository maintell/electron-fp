# fingerprint — 隔离目录

本目录与 Electron 主 patch 完全隔离（见 `docs/superpowers/specs/2026-08-26-electron-fingerprint-design.md`）。

- `patches/*.patch` 补丁集（按运行时子系统拆分为 4 个，按文件名顺序施加）；整块替换源仍为 `ungoogled-chromium-windows`，升级时按需替换单个补丁
- 不改 `patches/chromium/.patches` / `patches/config.json`，施加由 `fingerprint/scripts/apply.py` 独立完成
- `helpers/fp_config_helpers.h` 仅改注入源为 `--fingerprint-config`（per-Renderer，`ElectronBrowserClient::AppendExtraCommandLineSwitchesForRenderer`），其余 60 键语义与上游一致

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
- `scripts/check.py` — 本地未接 `devutils/check_patch.py` 8 项静态检查（<1s）：60 配置项（跨全集合校验）/ 头注释 / doc-segment 匹配 / empty-segment / debug 残留 / hunks / 头计数 / 隔离 / 文件不得被多个补丁重复拥有
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

# 方式 B：用上游 devutils/gen_patch6.py 在新 src 重生成后覆盖（推荐，含 60 键完整性校验）
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

## 网络层指纹（TLS/JA3/JA4 与 HTTP/2）— 已实现

> **2026-09-01 更新（状态变更：未覆盖 → 已实现）**
> 网络层指纹现在由 `40-net-tls.patch` 提供。此前此节标题为"已知未覆盖"，
> 该结论已被下面的实测数据推翻，文档同步更新以免与代码矛盾。

`00/10/20/30` 四个补丁全部位于 Blink 与 WebRTC，因为唯一配置入口
`fp_config_helpers.h` 只能被 Blink 包含。`40-net-tls.patch` **不复用该入口**，
而是走 Electron 已有的、本就逐 profile 隔离的通道：

```
session.setSSLConfig({ fp* })
  → ElectronBrowserContext::SetSSLConfig
  → mojo OnSSLConfigUpdated  (network::mojom::SSLConfig)
  → 网络服务 MojoSSLConfigToSSLContextConfig
  → net::SSLClientContext（per-URLRequestContext，天然逐 profile）
  → SSLClientSocketImpl::Init()   ← ClientHello 在此成形
```

关键点：`SSLClientContext` 是 **per-URLRequestContext** 的
（`net/http/http_network_session.h`），而每个标签页已独占 partition
（`Client/main.js` 的 `fp-tab-${tabId}`），所以"逐 profile 独立网络上下文"
不需要新建机制，只需把字段挂到已有的 `SSLContextConfig` 上。

### 覆盖范围（逐字段，含未实现项的诚实标注）

| 字段 | 作用 | 层级 |
|---|---|---|
| `fpCipherList` | 替换 Chromium 硬编码 `ALL:!aPSK:!ECDSA+SHA1:!3DES` | per-SSL |
| `fpSignatureAlgorithms` | 替换签名算法偏好列表 | per-SSL |
| `fpGreaseEnabled` / `fpGreaseSigalgsEnabled` | GREASE 开关 | **per-SSL_CTX** |
| `fpPermuteExtensions` | 扩展顺序随机化开关 | per-SSL |
| `fpExtensionOrder` | **未实现，且会显式报错拒绝** | — |
| `fpOmitAlpn` / `fpOmitSessionTicket` | 移除 ALPN / session_ticket | per-SSL |
| `fpAdvertisedVersionMax` | 仅压低 supported_versions 的**对外**版本 | per-SSL |
| HTTP/2 `settingsGrease` 等 | `HttpNetworkSessionParams::fp_*` | per-URLRequestContext |

**两个入口点不同，这是有意的**：

```js
// TLS：可随时设置（SSLConfig 有 OnSSLConfigUpdated 实时通道）
session.setSSLConfig({ fpCipherList: 'ECDHE-RSA-AES128-GCM-SHA256', ... })

// HTTP/2：必须在构造时传入（见下"构造期约束"）
session.fromPartition('persist:x', { http2Profile: { settingsGrease: true } })
```

### 构造期约束（HTTP/2，踩过坑，勿"简化"）

`HttpNetworkSessionParams` 只在 **NetworkContext 构造时读取一次**；而
StoragePartition 的构造发生在 `session.fromPartition()` **内部**，早于任何
Session 方法。因此事后调用的 `session.setHttp2Profile()` **静默无效**——
该函数曾完整实现并接通 mojom，实测无效果（在
`ConfigureNetworkContextParams` 插桩，事后调用一律观测到 profile 未设置）。

故 setter 被保留但 `LOG(WARNING)` 明确告警，而不是假装生效；
受支持写法是 `fromPartition(name, { http2Profile })`，与 `cache` 选项一致。

#### 三个 HTTP/2 字段的实测证据

三者均已证明能改动真实线路字节（非仅"被接受"），由
`Client/test-http2-wire.js` / `test-http2-profile.js` 覆盖：

| 字段 | 观测到的线路证据 |
|---|---|
| `settingsGrease:true` | SETTINGS 多出 GREASE 项 `0x1a8a`；同进程未打 profile 的 session 仍为 0 |
| `greaseFrame:{type:0x2a,...}` | SETTINGS 后出现 `type=0x2a payload=deadbeef` 保留类型帧 |
| `endStreamWithDataFrame` | HEADERS flags `0x25`→`0x24`（END_STREAM 被移走），空的 END_STREAM DATA 帧出现 |

> **测试陷阱**：验证 `endStreamWithDataFrame` 时，探针若在收到 HEADERS 时立即
> settle，会截断紧跟其后的空 DATA 帧，导致"字段无效"的误判。需在 HEADERS 后
> 留出短暂窗口再 settle。flags 位翻转已能证明字段被读到，此时缺帧应优先怀疑
> 捕获窗口而非实现。

### 外部验证（约束 12）

`Client/test-external-validation.js` 用第三方（`tls.browserleaks.com/json`）
比对内核结果——这是唯一能发现"自洽但与真实浏览器不符"的手段，内部测试看不到。

结果：**密码套件集合 15/15 完全一致；扩展集合 14/14 一致。**

#### 已知偏差：SNI（0x0000）

本地探针监听 `127.0.0.1`，测试连 `https://127.0.0.1:PORT/`；而 Chromium 对
**IP 字面量不发送 SNI**。因此本地 baseline 少了 `0x0000`，与真实站点看到的
ClientHello 天然不同（JA4 哈希覆盖扩展列表）。

- 这不是产品缺陷，但意味着：**本地 JA4 ≠ 真实站点算出的 JA4**。
  "未打 profile == 原生"的结论成立，但跨上下文比较 JA4 字符串无效。
- 该行为由 `Client/test-probe-realism.js` 钉死：IP 无 SNI、hostname 有 SNI、
  二者恰差这一个扩展。
- 曾误判为"GREASE 随机化"：本地连跑三次稳定 15，排除该解释。

> HTML 页面（`browserleaks.com/ssl`、`creepjs.com`）会尝试并打印但不计入
> 成败——经沙箱代理会间歇性失败，与本项目无关。用"狼来了"的门禁只会让人
> 忽略失败。JSON 端点既稳定，又直接给出 `ja4_r`（解码后的原始列表），更适
> 合做断言。

两个刻意的设计约束：

1. **未设置 = 原生 Chromium。** 所有字段都是 `std::optional`／空值即"未设置"。
   实测：不打 profile 时 JA4 与改动前基线**逐字节相同**
   （`t13i1515h2_dea800f94266_31b5f215ee45`）。
2. **`fpExtensionOrder` 不静默忽略。** BoringSSL 只提供
   `SSL_[CTX_]set_permute_extensions(on|off)`，没有指定扩展顺序的 API；
   实现它需要改 BoringSSL 的 ClientHello 拼装（安全关键路径）。因此设置了该
   字段的连接**直接失败**（`ERR_NOT_IMPLEMENTED` 并 `LOG(ERROR)`），
   而不是发出一个与 profile 声明不符的 ClientHello——静默忽略比缺失更糟，
   因为 profile 会声称一个它并未产生的指纹。

### 实测（本地探针读真实 ClientHello，非推断）

```
无 profile      JA4 = t13i1515h2_dea800f94266_31b5f215ee45   （= 改动前基线）
fpCipherList    JA4 = t13i0415h2_2561529f22d6_...            （密码套件收窄）
GREASE 关闭     GREASE 码点 = 0（对照组基线 = 5）
omitSessionTicket  session_ticket 消失，exts 17 → 16
fpAdvertisedVersionMax=0x0303   JA4 → t12i1210h2_...
HTTP/2          SETTINGS 8 项；GREASE SETTINGS = 无
```

测法纪律（曾因违反它得出过错误结论，故写入测试）：
- **首次握手必须丢弃**：GREASE 随机，首个 ClientHello 不可比。
- 断某 profile"无效果"前，先用**非法值**验证链路是否真的到达 BoringSSL
  （非法 cipher list 必须连接失败）；否则无法区分"被忽略"与"值本身无效"。
- BoringSSL 的 cipher list **只管 TLS ≤ 1.2**，且名字是**连字符形式**
  （`ECDHE-RSA-AES128-GCM-SHA256`，不是 `ECDHE_RSA_WITH_...`）。
  用长名或只列 TLS 1.3 套件都会得到"看起来没生效"的假阴性。

### HTTP/2 与 Chrome 的差异（实测，且**已有现成开关**）

`enable_http2_settings_grease` 在 `net/` 默认为 `false`；`enable_http2_settings_grease`
由 `components/network_session_configurator` 的 `--http2-grease-settings` 打开。
**该开关在本构建中实测有效**，不需要内核补丁：

```
无开关         SETTINGS = 4 项（1,2,4,6）          GREASE = 0
--http2-grease-settings  SETTINGS = 5 项  0xfa9a / 0xfa2a（随机）GREASE = 1
```

故：**要模拟 Chrome，直接加 `--http2-grease-settings` 即可**，
`HttpNetworkSessionParams::fp_http2_settings_grease` 仅为"需要逐 profile 而非
进程级控制"时预留（开关是 process-wide 的，profile 字段是 per-URLRequestContext）。
注意两者默认值都是"未设置"，以保持原生行为。

**测量方法警告（曾据此得出错误结论）**：不要用 Node `http2` 的
`remoteSettings` 事件读对端 SETTINGS。它返回的是 Node 认为对端的值，
不是线上字节；实测同一连接上：

```
线上原始字节：4 项（1,2,4,6）
remoteSettings：8 项（额外补入 maxFrameSize/maxConcurrentStreams/
                      maxHeaderSize/enableConnectProtocol）
```

Node 用协议默认值补齐了 4 项，且会**丢弃未知（GREASE）id**——恰恰是我们
关心的信号。因此 `Client/test-http2-fingerprint.js` 自行解码 SETTINGS 帧字节。
（该文件的旧版本曾基于 `remoteSettings` "通过"了 4 项断言，实际在测 Node
而非 Electron。）

> **2026-08-29 更新**：User-Agent 与 `navigator.platform` **已覆盖**，不再是缺口。
> UA 由客户端 `session.setUserAgent()` 处理（非内核 key，`Client/main.js`）；
> `navigator.platform` 由内核 key `navigator_platform`（60 键之一）处理，注入点为
> `NavigatorBase::platform()`（**不是** `NavigatorID::platform()`，后者在
> Windows/macOS/Linux 上是死代码，详见 `10-blink-core.patch` 中的注释）。
> 两者均需在 `profiles.json` 中显式配置：UA 为 `profile.userAgent`（平级字段），
> platform 为 `fingerprint.navigator_platform`（默认 `''` 禁用）。
> 仍需注意二者需**手动保持一致**——内核不会校验 Mac UA 是否配了 `MacIntel`。
> 见 `Client/README.md` § Known Limitations。

### 事实（实测确认，非推断）

- 补丁触及 36 个文件：`third_party/blink` 32 个 + `third_party/webrtc` 4 个。**无 `net/`、`ssl/`、`boringssl/` 文件。**
- 全文关键词命中数为 0：`boringssl`、`SSL_`、`cipher`、`client_hello`、`alpn`、`grease`、`ja3`、`ja4`、`quic`、`http2`、`tls`。
- 唯一配置入口 `fp_config_helpers.h` 位于 `third_party/blink/renderer/core/frame/`，只能被 Blink 包含；TLS 指纹由网络栈产生，该头文件进不去。

实测（真实 HTTPS 请求，由对端读取 ClientHello）：

```
空配置   x4 → JA4 = t13d1517h2_8daaf6152771_a87ad97598a9
明确配置 x4 → JA4 = t13d1517h2_8daaf6152771_a87ad97598a9
不同 JA4 数量：1   ⇒ fingerprint 配置对 TLS 指纹零影响
```

测法说明：**首次连接必须丢弃**。Chromium 按 RFC 8701 插入 GREASE 随机保留值，首个 ClientHello 的 JA4 为 `t13d1516h2_...`，之后稳定为 `t13d1517h2_...`。若不预热，会把 GREASE 噪声误读成"配置生效了"。

### 为什么不能套用现有机制

配置优先级见 `fp_config_helpers.h`：

```
1) --fingerprint-config  (base64 JSON, Electron per-renderer)
2) FP_CONFIG_DATA        (env)
3) FP_CONFIG             (file)
4) FP_<KEY>              (env)
```

第 1 条是 **per-renderer** 的，这是"每个标签页独立指纹"的实现基础。而 TLS 指纹产生于网络栈，**跨标签页共享**。因此网络层指纹不只是"还没做"，还额外要求解决一个现有架构未覆盖的问题：如何在共享网络栈上做 per-tab 差异化。环境变量（第 2/4 条）网络栈能读到，但那是进程级全局的，做不出 per-tab 隔离。

### （已解决）User-Agent 与 navigator.platform 泄露

> 本节保留原始记录，因为「为什么 UA 不是内核 key」与「为什么注入点在
> `NavigatorBase` 而非 `NavigatorID`」这两个结论仍然有效。

原实测 UA：

```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
Chrome/154.0.8015.0 Electron/45.0.0-nightly.20260825 Safari/537.36
```

- `Electron/45.0.0-nightly.20260825` **曾直接暴露 Electron 身份**。
- 后果：`profiles.json` 的 `macOS / Safari-like` 预设只改了 GPU 与屏幕，UA 仍报
  `Windows NT 10.0 ... Electron/45.0.0`。**声称 macOS 却在网络层报 Windows + Electron。**

**2026-08-29 已解决**（方案 A + platform）：

| 方案 | 解决什么 | 状态 |
|---|---|---|
| A. UA 覆盖 | 消除 `Electron/` 暴露与预设自相矛盾 | **已完成**。客户端 `session.setUserAgent()`，`profile.userAgent` 平级字段 |
| B. `navigator.platform` | 让预设名副其实 | **已完成**。内核 key `navigator_platform`（60 键之一） |
| B′. Sec-CH-UA 客户端提示 | 与 UA 保持一致 | **已完成**。键 58-60（`ua_platform`/`ua_mobile`/`ua_brands`），两个面都已打补丁：`navigator.userAgentData`（`NavigatorBase::GetUserAgentMetadata()`）与 `Sec-CH-UA*` 请求头（`LocalFrameClientImpl::UserAgentMetadata()`）。未显式配置时从 UA 派生 |
| C. TLS/JA3 定制 | 真正的网络层指纹 | 未做，见上节 |
| D. 明确不实现 | — | TLS 仍属此类 |

**两个易踩的坑（均已实测）**：

1. **UA 不是内核 key。** `fpNormalizeConfig()` 会丢弃内核不认识的 key，所以 UA
   若放进 `fingerprint` 对象会被静默丢弃。它必须作为 `profile.userAgent`
    平级字段存在——UA 属 Electron 层，60 个 key 属 Blink 层。
2. **`setUserAgent()` 必须在创建 `BrowserView` 之前调用。** 实测：对已打开的
   session 设 UA 后 reload 也不生效，但同 partition 的**新** view 会生效。

#### 内核是纯函数，一致性归应用层

`ua_platform` / `ua_mobile` / `ua_brands` 三个键遵循一条统一原则：

> **内核只负责完成功能——显式配置了什么，就输出什么。UA 与 platform 是否一致，
> 由应用层决定，内核不做校验、不做纠正。**

实测（`test-client-hints.js` 已覆盖）：

- **显式值无条件生效，完全不参考 UA。** 配置
  `{ua_platform:"Plan9", ua_mobile:"true", ua_brands:"AcmeBrowser=42"}` 且
  **不设任何 UA** 时，两个面都照常输出 `Plan9` / `?1` / `AcmeBrowser;v=42`。
- **显式值压过矛盾 UA。** 同一配置配一条 Windows UA，结果仍是 `Plan9`，
  不是 `Windows`。
- **空值 = 从 UA 派生**，这是默认值（`fpDefaultConfig()` 与 `profiles.json`
  预设都留空），也是让 `navigator.userAgentData` 与 `navigator.userAgent`
  自动保持一致的便捷路径。
- `navigator_platform` 的一致性由**客户端** `main.js` 负责：生成器用
  `fpPlatformForUserAgent(ua)` 从实际选中的 UA 推导。改 UA 忘了同步
  platform 是应用层的事，内核不管。

**`ua_brands` 必须写成无引号的配置式**（`Brand=99,Chromium=131`）。
带引号的线上式（`"Brand";v="99"`）传不过去——`FpConfigString()` 遇到第一个
闭合引号就截断，实测得到的是一个内容为空的垃圾条目。内核解析器同时接受两种
形式，但引号在到达解析器之前就已经被截断了。

### 剩余未决：TLS/JA3 定制（方案 C，仍未做）

需先决策：接受全局统一 TLS，还是投入改造网络栈做 per-tab 隔离。后者受架构约束——
配置注入是 per-renderer 的，而 TLS 指纹产生于共享网络栈。


（该节此前被截断在此处，已在实现 Inspector 后补齐。）

---

## Inspector：`electron://fingerprint/`（已实现）

一个特权 WebUI，报告它所在 BrowserContext 的**当前生效**指纹配置：全部 63 个
`fp_*` key 的分组覆盖率，以及跨层一致性发现。

覆盖率数据从 `SessionPreferences` 读回，而不是重新推算——一个展示"某个 profile
应该长什么样"的面板只是装饰品，价值在于展示运行中的浏览器实际持有什么；读实时值
同时保证页面不会与它描述的对象产生漂移。

在任一 BrowserContext 下打开 `electron://fingerprint/` 即可。Inspector 按
BrowserContext 隔离（指纹配置本身就是按 BrowserContext 存的），所以在查看某个
partition 时显示默认 context 的配置是明确错误的。

### 配置有两个存储位置，两处都必须读

`SessionPreferences` 和 `WebContentsPreferences` 是两个独立的存储：

| 存储 | 写入方式 |
| --- | --- |
| `SessionPreferences` | `session.setFingerprintConfig({...})` |
| `WebContentsPreferences` | `new BrowserView({ webPreferences: { fingerprint } })` |

Client 用的是**第二个**（`Client/main.js` 每个 tab 建一个 BrowserView，把
`fingerprint` 放在 `webPreferences` 里）。只读 `SessionPreferences` 会对真实
Client tab 显示空 profile——而这正是 Inspector 存在的意义所在。更糟的是它会显示
"未发现问题"，而实际上什么都没读。

两处合并必须在覆盖率统计**之前**完成。但**合并规则必须跟随渲染进程，而不是
"看起来更合理"的那个**——渲染进程用的是**整体替换**，不是逐键覆盖：

```
// electron_browser_client.cc（AppendCommandLineSwitches 路径）
fp_b64 = web_preferences->GetFingerprintConfigBase64();
if (fp_b64.empty())          // 注意：判断的是整份配置是否为空
  fp_b64 = session_prefs->GetFingerprintConfigBase64();
```

即：per-tab 配置非空时**整份替换** session 配置，渲染进程根本看不到 session 的键。
逐键覆盖（"更具体的优先"这句直觉）是错的，而且错在危险的方向：tab 设 `{vendor}`、
session 设 `{platform, hw}` 时，渲染进程只应用 vendor，而逐键覆盖会报三处都已
配置——面板把两个实际跑原生的面说成已伪装。实测：渲染进程 `platform=Win32
hw=16`（原生），Inspector 却报 active=3（正确值是 1）。

Inspector 的唯一职责就是报告**实际**伪装了什么，所以即便渲染进程的规则看起来
"不帮忙"，也必须照跟。

### 一致性规则：8 条全量，且必须能说"没检查"

面板运行 `Client/browser-profile.js` 里的**全部 8 条**规则（4 error + 4 warn），
包括 pass/fail/**skip** 三段契约：输入缺失的规则报告"无法判定"，而不是"通过"。
`skipped[]` 会显示出来，不隐藏。

其中 4 条以 UA 为锚，因此读 `ElectronBrowserContext::GetUserAgent()`（含
`session.setUserAgent()` 的生效值），否则它们只能永远 skip。

页面同时报告 `ruleCount` / `rulesEvaluated`，并按 `skipCount` 判定：当半数以上
规则因输入未设置而无法运行时，显示"Nothing to check"而**不是**"Profile is
consistent"。一个因为规则没跑而显示"干净"的面板，比没有面板更糟。

> 历史教训：初版只跑了 8 条里的 1 条，且 `warnCount` 硬编码为 0，于是 4 条 warn
> 规则永不可达、任何 profile 都显示"一致"。另有一个 use-after-move：`skipCount`
> 从已 move 的 list 上读，恒为 0。两者都表现为"看起来没问题"，只有把断言写成
> "count 必须与 findings 数组长度一致"才暴露出来。

### 注册一个新 WebUI scheme 需要三处独立注册

这是本次实现中代价最高的部分。三者互相独立，缺任何一个都会失败，且**失败方式不同、
且具有误导性**——特别是第 3 点，它的表现与"数据源根本没注册"完全一致：

| # | 缺什么 | 失败表现 |
|---|--------|----------|
| 1 | `url::AddStandardScheme`（browser + renderer 都要） | URL 无法解析，跳转 `ERR_INVALID_URL (-300)` |
| 2 | `GetAdditionalWebUISchemes` | content 不把它当 WebUI，跳转 `ERR_FAILED (-2)` |
| 3 | `URLDataSource::ShouldServiceRequest` 覆写 | 数据源**被找到后被拒绝**：再次 `ERR_INVALID_URL`，且 `StartDataRequest` 从不被调用 |

第 3 点的原因：`URLDataSource::ShouldServiceRequest` 的默认实现只放行 `chrome:` 和
`devtools:`（见 `content/public/browser/url_data_source.h`）。在新 scheme 上，数据源
查找成功、随后被拒，日志里看不出任何痕迹。

第 1 点还有一个时序约束：注册必须发生在构造任何 GURL 之前。
`PreMainMessageLoopRun` 太晚，会命中 `url/url_util.cc:503` 的 DCHECK
（"Trying to add a scheme after the lists have been used"）。正确的是
`PreCreateMainMessageLoop`。

### 为什么页面是自包含的

常规 WebUI 的做法是：输出 HTML，然后 `fetch()` JSON、`<script src>` 加载脚本。
在这个构建里**这三条子资源路径全都不可用**，而且这不是新 scheme 的问题——
在原生 `chrome://accessibility` 上实测同样失败：

```
fetch('chrome://resources/js/cr.js')  ->  "Failed to fetch"
addWebUiListener                      ->  undefined
```

`cr`（WebUI 的 JS 模块）加载不出来，所以 `cr.addWebUiListener` 也没有；而
`chrome.send` / `FireWebUIListener` 的回程依赖它，因此 WebUI IPC 同样无法投递回复。

唯一可用的路径是**主文档加载**，所以数据源把脚本和数据一起内联进 index 响应：
`window.__fp` 携带数据，脚本直接内联在页面里。

### 覆盖率分组表需要同步

`fingerprint_ui.cc` 里的分组/key 表镜像了 `Client/fp-schema.js`（C++ 无法读取 JS
schema）。这个重复是有意为之，但两边必须保持一致；`test-inspector.js` 断言总数为
63，key 数量对不上会直接失败。
