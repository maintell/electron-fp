# 02 架构：三平面

一个 profile 在传输上是**三个互不相见的平面**（`sdk/fp-schema.js` 的三张表，
`fpSplitConfig()` 是唯一允许拆分它们的函数；`fpNormalizeConfig()` 只认识
Blink 键，直接对整包调用会静默丢掉 TLS/H2 键）。

## 平面 1：63 个 Blink 键 → `fingerprint` webPreference

```js
new BrowserView({ webPreferences: { partition, fingerprint: blink } });
```

- 经 `--fingerprint-config` 在 **renderer 启动时**注入（per-renderer）。
- 之后改配置必须销毁重建 view（同 partition、新 renderer）再 `loadURL`；
  对活 renderer 调 `setFingerprintConfig()` 不生效，进程必须重生。
- 读回活页真实配置：`view.webContents.getFingerprintConfig()`（解码后的
  对象，即内核收到的、后规范化的值——自测拿它当"期望值"的来源）。

## 平面 2：9 个 TLS 键 → `session.setSSLConfig()`

```js
sess.setSSLConfig(tls);   // 同一 session、首个请求（首个 socket）之前
```

- 由网络服务从 `net::SSLContextConfig` 读出（`40-net-tls.patch` 接的线），
  页面 JS 永远看不见，只能抓真实 ClientHello 验证。
- `SSLClientContext` 是 per-URLRequestContext 的，所以天然跟随 partition
  隔离——不需要新机制。

## 平面 3：3 个 H2 键 → `fromPartition` 选项（仅首次调用）

```js
session.fromPartition(name, { http2Profile: h2 });   // 同名首次调用才有效
```

- `HttpNetworkSessionParams` 只在 NetworkContext **构造时读一次**，
  构造发生在 `fromPartition()` 内部、早于任何 Session 方法。
  实测：`fromPartition(p, {http2Profile:{settingsGrease:true}})` → GREASE=1；
  先无参 `fromPartition(p)` 再 `setHttp2Profile()` 或再带参调用 → GREASE=0
  （静默丢弃）。**H2 对 partition 终身冻结**，改它只能换 partition 名
  （关了重开 tab / 组）并如实报告差异，不得假装生效。

## UA：在指纹对象之外

```js
sess.setUserAgent(ua);    // view 创建之前；'' = 恢复原生 UA
```

- UA 是 Electron 层表面，不是 63 键之一：塞进 `fingerprint` 对象会被
  `fpNormalizeConfig()` 静默丢弃，必须作为平级字段（如
  `profile.json` 的 `userAgent`）存放。
- 实测：对已打开的 session 设 UA 后 reload 也不生效，但同 partition 的
  **新** view 会生效——所以顺序永远是：fromPartition（带 H2）→
  setUserAgent → setSSLConfig → 建 view。

## partition = 隔离边界

cookie / storage / UA / TLS / H2 全部跟随 partition。
同名 partition 共享一切，不同名互相隔离。

## MClient 组模型（多 profile 共存的参考实现，不在本包内）

顶层 tab = 独立 profile 浏览器（`Group`），子 tab = 该组内的 view（`Tab`）：

- partition 按**组**共享：`fp-group-{groupId}`。组内所有子 tab 同一
  session（cookie/storage/UA/TLS/H2 共享），组间隔离；组内所有 view
  用同一份 Blink 指纹创建。
- profile 变更 = 同 partition 重建组内**全部** view（各保各的 url），
  UA/TLS 先设后建，H2 差异只报告不假装（沿用"fixed when the tab is
  created"话术）。
- 同一时刻只挂载一个 view（`showActiveView()`：detach 全部、attach
  active 组的 active tab）。
