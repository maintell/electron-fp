# 08 指纹配置的注入通道（全部实测）

> 本文的每一条结论都有代码位置 + 运行时实测支撑。此前版本有两条**错误**，已更正：
> `--fingerprint-config` 不是用户可用的命令行开关；`FP_<key>` 单键回退**只对 Int 键有效**。

## 1. 四个通道的实测结论

| # | 通道 | 谁能用 | 实测 |
|---|---|---|---|
| 1 | `--fingerprint-config=<base64 JSON>` | **仅浏览器进程注入给 renderer** | ⚠️ 用户命令行手输**无效** |
| 2 | `FP_CONFIG_DATA` 环境变量 = 原始 JSON | 用户/宿主进程（推荐） | ✅ 生效 |
| 3 | `FP_CONFIG` 环境变量 = JSON **文件路径** | 用户 | ✅ 生效（但见 §6 前导空白陷阱） |
| 4 | `FP_<key>` 环境变量 = 单键回退 | 用户 | ⚠️ **仅 Int/Int64 键有效，String 键完全无效** |

读取顺序即上表优先级，见 `FpConfigContent()`：
`electron/fingerprint/helpers/fp_config_helpers.h:45`（blink 侧同逻辑，`:64`）。

### 实测数据

```text
通道 2  FP_CONFIG_DATA={"tz_id":"Asia/Tokyo","hardware_concurrency":9}
        -> tz=Asia/Tokyo, cores=9                    ✅

通道 3  FP_CONFIG=<file>              cores 4->9, platform->Win32   ✅
        FP_CONFIG=<file>+"   "         尾部空格：正常               ✅
        FP_CONFIG="   "+<file>         前导空格：静默失效           ❌
        FP_CONFIG="\t"+<file>          前导制表：静默失效           ❌
        FP_CONFIG=<不存在的路径>        无效果、不崩溃               ✅（安全降级）

通道 4  FP_hardware_concurrency=12     cores 4->12                  ✅（Int 键）
        FP_HARDWARE_CONCURRENCY=12     无效果（名字必须小写原样）   ❌
        FP_tz_id=Asia/Tokyo            无效果（String 键）          ❌
        FP_navigator_platform=Win32    无效果（String 键）          ❌

通道 1  手输 --fingerprint-config=<b64>  无效果                     ❌
```

## 2. 为什么命令行手输 `--fingerprint-config` 无效

该开关由**浏览器进程在启动每个 renderer 时注入**，数据来源是 preferences 对象：

```cpp
// electron/shell/browser/electron_browser_client.cc:700-709
std::string fp_b64 = web_preferences->GetFingerprintConfigBase64();
if (fp_b64.empty()) {
  if (auto* sp = SessionPreferences::FromBrowserContext(...))
    fp_b64 = sp->GetFingerprintConfigBase64();
}
if (!fp_b64.empty())
  command_line->AppendSwitchASCII(switches::kFingerprintConfig, fp_b64);
```

顶层命令行不会写入 `WebContentsPreferences`/`SessionPreferences`，所以手输被忽略。
它是**浏览器→renderer 的内部传输通道**，不是用户接口。

## 3. 正确用法：Electron API

**推荐**（传 **JS 对象**，不是 base64 字符串）：

```js
// 会话级（该 session / partition 下所有 renderer）
session.defaultSession.setFingerprintConfig({
  navigator_platform: 'Win32',
  hardware_concurrency: 9,
});

// 单窗口级，优先于 session
win.webContents.setFingerprintConfig({ /* ... */ });
```

实现在内部自行序列化并 base64：

```cpp
// electron/shell/browser/api/electron_api_session.cc:1182-1203
if (!gin::ConvertFromV8(isolate, val, &fingerprint_val) || !fingerprint_val.is_dict()) {
  args->ThrowTypeError("fingerprint config must be an object");   // 传字符串走到这里
  return;
}
std::string b64 = base::Base64Encode(*base::WriteJson(fingerprint_val));
prefs->SetFingerprintConfig(b64);
```

**注意**：传已编码的字符串会抛 `TypeError`；若不捕获，应用会挂住（易被误判为缺陷）。
传 `null` / `undefined` / `false` / `{}` 表示清除配置、恢复原生行为。

## 4. 键值类型：双向严格，必须对得上

63 个键各有唯一 reader（与 `check.py` 的 `EXPECTED_KEYS` 完全一致，零差异）：

| reader | 数量 | 值的形式 |
|---|---|---|
| `FpConfigString` | **36** | 必须带引号：`"1.25"`、`"true"` |
| `FpConfigInt` / `FpConfigInt64` | **27** | 必须裸数字：`8`、`1920` |

```c
// FpConfigString: 要求 content[i]=='"'，否则 return ""      -> 数字被静默忽略
// FpConfigInt   : 只跳 '-' 和数字，遇引号 any=false -> fallback -> 引号数字也被忽略
```

**所以两个方向都不宽容。** 典型键：

```jsonc
{
  "hardware_concurrency": 8,        // Int    - 不带引号
  "screen_width": 1920,             // Int
  "device_pixel_ratio": "1.25",     // String - 必须带引号
  "ua_mobile": "true",              // String - 必须带引号
  "tz_id": "Asia/Tokyo"              // String
}
```

**String 类的 36 个键**（其余为 Int）：
`navigator_platform` `navigator_vendor` `navigator_languages`
`ua_platform` `ua_mobile` `ua_brands` `device_pixel_ratio` `do_not_track`
`tz_id` `prefers_color_scheme` `net_effective_type` `net_downlink_mbps`
`geo_latitude` `geo_longitude` `geo_accuracy` `battery_level` `battery_charging`
`permissions_status` `fonts_blocklist` `fonts_whitelist` `media_codecs_denylist`
`audio_data_strength` `webrtc_ip` `speech_voices_lang`
`webgl_vendor` `webgl_renderer` `webgl_extensions` `webgl_shader_precision_highp`
`webgl_aliased_point_size_range` `webgl_aliased_line_width_range`
`webgpu_vendor` `webgpu_device` `webgpu_description` `webgpu_architecture`
`webgpu_features` `webgpu_limits`

## 5. 单键回退（通道 4）的两个限制

实现只存在于 `FpConfigInt` / `FpConfigInt64`：

```cpp
// fp_config_helpers.h:136-140
std::string env_name = "FP_";
env_name += key;                        // key 原样拼接，故为小写
const char* e = getenv(env_name.c_str());
```

1. **`FpConfigString` 没有这条回退**，因此 36 个 String 键无法用单键环境变量设置。
2. 名字是 `"FP_" + key` **逐字拼接**，所以是 `FP_hardware_concurrency`，
   **不是** 大写的 `FP_HARDWARE_CONCURRENCY`。

## 6. `FP_CONFIG` 的前导空白陷阱

```cpp
// fp_config_helpers.h:32
inline std::string FpTrim(std::string s) {
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t' ||
                        s.back() == '\r' || s.back() == '\n')) s.pop_back();
  return s;                       // 只剪尾部，前导空白会保留
}
```

因此 `FP_CONFIG=" /path/x.json"` 会**静默失效**（既不报错也不生效）。
尾部空白无碍。使用时保持路径无前导空白即可（已实测确证）。

## 7. 两个语义易误解点

**`webgl_extensions` 是追加且去重**（`!result.Contains()`）。若配置的扩展名本就存在，
则毫无变化——这不是失效。验证请用唯一标记名：

```text
配置 ZZPROBE_EXT_ONE -> 35:no_marker 变 37:HAS_MARKER   生效
配置已存在的扩展名     -> 数量不变                        去重所致
```

**`ua_platform` / `ua_mobile` / `ua_brands` 只影响 `navigator.userAgentData`（client hints），
不改 `navigator.userAgent` 字符串**；且不存在 `user_agent` 这个 FpConfig 键。
UA 字符串要走 Electron 自己的接口：

```js
win.webContents.setUserAgent(ua);
session.defaultSession.setUserAgent(ua);
```

## 8. 何时生效

配置载体（renderer 命令行开关 / 进程环境变量）在 **renderer 进程创建时**固定，
`FpConfigContent()` 本身不缓存，但改配置不会回灌已存在的进程。
所以修改 `profile.json` 后需要**重启应用**（或新建 partition），并非热重载 bug。
