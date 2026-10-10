# 05 已实测的坑

每条都曾真实踩过；共同点是**静默**——面板显示已应用，实际跑原生。
"声称一个并未产生的指纹"被视为最坏结果，所以修法一律是"拒绝/报告"，
而不是"假装生效"。

## 1. 字符串键传数字静默失效（32 键）

`SetFingerprintConfig` 用 `base::WriteJson` 直接序列化传入对象，
**不经过** `fpNormalizeConfig()`。内核用 `FpConfigString()` 读这些键，
遇到 JSON 数字返回 `""`：无报错、无日志、回落真实值。
实测：`device_pixel_ratio: 3`（数字）→ dpr 仍是 1；`"3"`（字符串）→ dpr 3。
最先在 `audio_data_strength` 上发现，后证实共 32 键。
修法：进内核前一律过 `fpNormalizeConfig()`（UI 路径已做；手写脚本最易踩）。

## 2. H2 冻结

见 02。`fromPartition(p)` 后再 `setHttp2Profile()` → GREASE=0；
同名再带参调一次 → 仍是 0。改 H2 只能换 partition，并把差异报给用户
（MClient 话术："HTTP/2 settings are fixed when the tab is created;
close and reopen the tab to change them."）。

## 3. UA 必须先设

`setUserAgent()` 一定要在 view 创建**之前**；已打开 session 上调用，
reload 也不生效，只有之后新建的 view 能捡到。传 `''` 回到原生 UA。

## 4. TLS 1.3 密码名导致全会话握手失败

`fpCipherList: 'TLS_AES_128_GCM_SHA256'` 会被 `setSSLConfig` 接受、
再被 BoringSSL 整体拒绝：该 session **每个请求都失败**
（`net::ERR_UNEXPECTED`，0 字节 ClientHello），而面板显示已应用。
BoringSSL 的 cipher list 只管 TLS ≤ 1.2，且是**连字符名**
（`ECDHE-RSA-AES128-GCM-SHA256`）。修法：先过
`fpTlsValidateCipherList()`，它只拦三个实测过的 TLS 1.3 名并给出
可用的 TLS 1.2 等价名（未知名不拦，避免名单过期误杀）。

## 5. GREASE 预设语义

Chromium 按 RFC 8701 插 GREASE；WebKit 与 NSS 不实现。所以
"Chrome 系 UA + 开 GREASE"、"Safari/Firefox UA + 关 GREASE"；
Firefox 另需 `fpAdvertisedVersionMax: 771`（这是去掉 TLS 1.3 套件的
唯一办法，`fpCipherList` 去不掉 1301/1302/1303）。配反了本身就是
检测信号（Safari UA 配 GREASE hello = 当场自首）。

## 6. media / speech 只缩不增

`media_devices_*` 与 `speech_voices_count` 按**截断**实现：
要的比宿主机真实列表短才生效，要得更多是静默 no-op。
宿主机 0 音频输入时要 3 个，读数仍是 0。

## 7. 自测没有行的 5 个键（不是没实现，是页面 JS 读不到）

`canvas_noise_strength` / `audio_data_strength` 是修饰量，seed 为 0
时内核直接返回、无独立可观测面；`geo_*` 三个需要特权通道改真实定位
（`getCurrentPosition()` 直接 code 2 拒绝）。验证它们要走专用测试
（audio/canvas 种子测试、CDP 注入），不是自测面板。

## 8. WebGPU device/description 要 Feature flag

键生效了也读不到，除非 `--enable-blink-features=WebGPUDeveloperFeatures`；
否则 `adapter.info.device/description` 读 `''`。上游 Blink 的门槛，
不是本包能改的。

## 9. 自测必须 http 源

`about:blank` 是不透明源，`navigator.storage` 与
`navigator.mediaDevices` 为 `undefined`，直接盲掉 5 个面。
tab 不在 http(s) 上时先借一个 loopback 页跑探针、跑完载回原页。

## 10. TLS 值类型错静默忽略

内核 `options.Get()` 类型不符返回 false 然后**跳过该键**：
`fpGreaseEnabled: 1` 与 `fpAdvertisedVersionMax: "771"` 都"成功"且都不动
（仍是原生 GREASE=3 / 仍提供 TLS 1.3）。两个 `u16list` 键倒是会抛，
但信息是 `conversion failure from `（键名类型全无）。修法：
`fpTlsValidateTypes()` 预检（报错点名键、要的类型、给的值）；
`u16list` 要真 JS 数组（`[23, 65281]`），`"0,23,65281"` 这类字符串
先过 `fpTlsCoerce()`。

## 11. 引号三连

- 数值键加引号 → 内核 `StringToInt` 拒绝，静默回真实硬件值
 （`webgl_max_viewport_dims: "8192"` → 真机 `32767,32767`）。
- `webgpu_limits` 含引号 → `FpConfigString()` 在首个闭合引号处截断，
  值变 `{`，整段静默丢弃。正确写法是无引号花括号式 `{k:v}`。
- `ua_brands` 用配置式 `Brand=99,Chromium=131`，线上式 `"Brand";v="99"`
  同样死在引号截断上。

## 12. `fpExtensionOrder` 未实现，且故意报错

BoringSSL 没有"指定扩展顺序"的 API（只有 permute 开关），
实现它要改安全关键路径。所以设了它的连接直接失败
（`ERR_NOT_IMPLEMENTED` + 日志），而不是发出与声明不符的 hello。
这是取舍，不是待办。

## 13. 安全源门槛

`mediaDevices` / `storage` / `getBattery` 在非安全源（`data:` URL 等）
是 `undefined`。测它们一律起 `127.0.0.1` 本地服务。

## 14. 首个握手必须丢弃

GREASE 按 RFC 8701 随机，首个 ClientHello 不可比（JA4 会差一位）。
不断言前先预热一次，否则会把噪声误读成"配置生效/失效"。
