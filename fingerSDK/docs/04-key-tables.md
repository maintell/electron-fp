# 04 键表

来源：`sdk/fp-schema.js`（`FP_KEYS` 63 键 / 15 组、`FP_TLS_KEYS` 9 键、
`FP_H2_KEYS` 3 键；`FP_SCHEMA_VERSION = 2`）。内核侧由
`test-schema.js` 断言 63/63 精确对应，数量由 `test-readme-counts.js` 钉死。

## 63 Blink 键（15 组；`kind` = 值编码）

- hardware（Hardware）：`hardware_concurrency:int`、`device_memory:int`、`max_touch_points:int`
- screen（Screen）：`screen_width:int`、`screen_height:int`、`screen_avail_width:int`、`screen_avail_height:int`、`screen_color_depth:int`、`device_pixel_ratio:str`
- audio（Audio）：`audio_sample_rate:int`、`audio_max_channels:int`、`audio_output_latency_ms:int`、`audio_data_seed:int64`、`audio_data_strength:str`
- webgl（WebGL）：`webgl_max_texture_size:int`、`webgl_max_renderbuffer_size:int`、`webgl_max_viewport_dims:int`、`webgl_aliased_point_size_range:dims`、`webgl_aliased_line_width_range:dims`、`webgl_vendor:str`、`webgl_renderer:str`、`webgl_extensions:csv`、`webgl_shader_precision_highp:sp`
- webgpu（WebGPU）：`webgpu_vendor:str`、`webgpu_architecture:str`、`webgpu_device:str`、`webgpu_description:str`、`webgpu_features:json`、`webgpu_limits:json`
- geo（Geolocation）：`geo_latitude:str`、`geo_longitude:str`、`geo_accuracy:str`
- speech（Speech）：`speech_voices_count:int`、`speech_voices_lang:str`
- media（Media Devices）：`media_devices_audio_input:int`、`media_devices_video_input:int`、`media_devices_audio_output:int`、`media_codecs_denylist:csv`
- canvas（Canvas & Text）：`canvas_noise_seed:int`、`canvas_noise_strength:int`、`measure_text_seed:int64`、`client_rects_seed:int`
- env（Locale & Privacy）：`tz_id:str`、`prefers_color_scheme:str`、`do_not_track:str`
- network（Network）：`net_effective_type:str`、`net_rtt_ms:int`、`net_downlink_mbps:str`、`webrtc_ip:str`
- storage（Storage & Perf）：`permissions_status:str`、`storage_usage_bytes:int`、`storage_quota_bytes:int`、`perf_now_precision_ms:int`
- fonts（Fonts）：`fonts_blocklist:csv`、`fonts_whitelist:csv`
- battery（Battery）：`battery_charging:bool`、`battery_level:str`
- navigator（Navigator ID）：`navigator_platform:str`、`ua_brands:str`、`ua_platform:str`、`ua_mobile:str`、`navigator_vendor:str`、`navigator_languages:str`

## 9 TLS 键（独立表 `FP_TLS_KEYS`，走 `setSSLConfig`）

`fpCipherList:cipherlist`、`fpSignatureAlgorithms:u16list`、
`fpGreaseEnabled:bool`、`fpGreaseSigalgsEnabled:bool`、
`fpPermuteExtensions:bool`、`fpExtensionOrder:u16list`（内核显式拒绝实现，
设了连接直接失败，见 05）、`fpOmitAlpn:bool`、`fpOmitSessionTicket:bool`、
`fpAdvertisedVersionMax:int`。

## 3 H2 键（独立表 `FP_H2_KEYS`，走 `fromPartition` 选项，创建时冻结）

`settingsGrease:bool`、`endStreamWithDataFrame:bool`、`greaseFrame:greaseframe`
（`{type, flags, payload}` 对象；留空 = 与真实 Chrome 一致）。

## 值编码规则（内核解析器口径）

- `int` / `int64`：JSON 数字；必须 `> 0` 才生效，**0 = 关闭 = 原生透传**。
- `str` / `bool` / `csv`：JSON 字符串；**空字符串 = 关闭 = 原生透传**。
  `bool` 以 `"true"` / `"false"` 字符串形式出现（`fp-schema` 负责强制类型，
  手写 JSON 时别写成裸 `true`——先过 `fpNormalizeConfig()` 最稳）。
- `dims`：`"min,max"`（WebGL ALIASED_*_RANGE）。
- `sp`：`"rangeMin,rangeMax,precision"`（highp 着色器精度）。
- `json`：`webgpu_features` 为**替换**（配置列表即 adapter 全部特性）、
  `webgpu_limits` 为**合并**，且必须**无引号花括号式**（`{k:v}`，见 05）。
