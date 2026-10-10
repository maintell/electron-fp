# 03 API 参考（主进程）

指纹版 Electron 在原生 API 之上只加了三个入口；其余全是"调用顺序约束"。
约束都有实测依据，违反时**静默不生效**（面板显示已应用、实际跑原生），
所以本节先写顺序，再写函数。

## 调用顺序（一句话版）

`fromPartition(name, {http2Profile})` → `setUserAgent()` →
`setSSLConfig()` → `new BrowserView({webPreferences:{partition, fingerprint}})`
→ `loadURL()`。示例见 `samples/mini-browser/main.js`。

## BrowserView `webPreferences.fingerprint`

- 用途：把 63 键 Blink 配置注入该 view 的 renderer（经
  `--fingerprint-config`，renderer 启动时读一次）。
- 参数：`fpSplitConfig()` 拆出的 `fingerprint` 对象（或 null = 原生）。
- 约束：生后不可改；改配置 = 同 partition 重建 view + 重载页面。

## `webContents.getFingerprintConfig()`

- 用途：读回该 view **实际运行**的指纹配置（解码后对象）。
- 参数：无。自测用它当期望值来源，而不是用当初传进去的那份。

## `session.setUserAgent(ua)`

- 用途：覆盖该 partition 的 UA（`navigator.userAgent` + HTTP `User-Agent`
  头两个面一起覆盖）。
- 约束：必须在 view 创建**之前**调用；已打开 session 上调用对现存 view
  无效（reload 也不行），但之后新建的 view 生效。传 `''` 恢复原生 UA。

## `session.setSSLConfig(tlsObj)`

- 用途：把 9 键 TLS 配置送到网络服务，影响该 session 后续握手的 ClientHello。
- 约束：首个会开 socket 的请求**之前**设置，否则首个握手是原生形状。
  类型错会被静默跳过（见 `05-traps.md`），先用 `fpTlsValidateTypes()` 预检，
  `fpCipherList` 再用 `fpTlsValidateCipherList()` 挡掉 TLS 1.3 名。

## `session.fromPartition(name, {http2Profile})`

- 用途：创建（或取回）partition；同名**首次**调用可携带 3 键 H2 配置。
- 约束：之后任何方式再传 H2 都静默丢弃；H2 终身冻结，改它 = 换 partition。

## `sdk/fp-schema.js` 导出（一句话）

- `fpSplitConfig(obj)`：把混装配置路由成 `{fingerprint, tls, h2, h2Error,
  unknown}` 三平面；拆分前唯一允许的入口。
- `fpNormalizeConfig(obj)`：把 Blink 键强制转成内核要的类型（数字→字符串等）；
  不认识的键（含全部 TLS/H2 键与 UA）直接丢弃——所以只能喂 Blink 面。
- `fpCoverage(cfg)`：对一份配置算覆盖率报告（Inspector 与面板的数据来源之一）。
- `fpIsActive(key, value)`：判定某键的值是否算"已配置"（`0` / 空串 = 关闭 =
  原生透传，不计入）。
- `FP_UA_PRESETS` / `fpRandomUserAgent()`：UA 预设表与随机取一条 UA。
- `fpNormalizeUserAgent(ua)`：UA 规范化（去首尾空等），存 profile 前过一遍。
- `fpPlatformForUserAgent(ua)` 等 UA 派生函数（`fpVendorForUserAgent`、
  `fpPixelRatioForUserAgent`、`fpLanguagesForUserAgent`、`fpUaMetadataForUserAgent`）：
  从实际选用的 UA 推导 `navigator_platform` / vendor / DPR / languages /
  client-hints 元数据，保证"UA 与派生面不自相矛盾"（内核不校验一致性，
  应用层自己负责；显式配置的值无条件压过派生值）。
