# UA 覆盖与 navigator.platform 内核覆盖 — 设计

日期：2026-08-29
状态：已批准，实施中
范围：`Client/`（客户端级 UA）+ 内核 `navigator_platform` key（第二步）

---

## 1. 背景

实测确认 UA 存在泄露：真实 UA 为

```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
Chrome/154.0.8015.0 Electron/45.0.0-nightly.20260825 Safari/537.36
```

`Electron/45.0.0-nightly.20260825` 直接暴露 Electron 身份。schema 中 UA/platform 类 key 为 **0 个**
（注意 `webgl_vendor` / `webgpu_vendor` 是 GPU 厂商名，与 UA 无关）。

后果：`profiles.json` 的 `macOS / Safari-like` 预设只改了 GPU 与屏幕，UA 仍报
`Windows NT 10.0 ... Electron/45.0.0`。**声称 macOS 却在网络层报 Windows + Electron，该组合本身即
是强检测信号**——这比单纯"没有 UA 伪装"更糟。

---

## 2. 实测结论（本设计的全部依据）

以下每条均由实际运行 Electron 验证，非推断。

| # | 结论 | 证据 |
|---|---|---|
| 1 | `session.setUserAgent()` 同时覆盖 JS 与 HTTP header | 探针：`navigator.userAgent` 与远端回显的 `user-agent` 头均等于设定值 |
| 2 | UA 按 partition 隔离 | 不同 partition 设不同 UA，各自独立生效 |
| 3 | **UA 必须在创建 view 之前设置** | **T4**：对已打开的 session 设 UA 后 reload，`navigator.userAgent` **仍是原生值**。但同 partition 的**新** view 会生效 |
| 4 | `setUserAgent("")` 复位到原生 UA | T3：设定后设空串，回落到原生 UA（非空字符串） |
| 5 | 重建 view 可继承 UA，且跨 tab 隔离 | 探针 3：`recreate picks up UA: true`、`cross-tab isolation: true` |
| 6 | **UA 不影响 `navigator.platform`** | 实测 platform 恒为 `Win32`；Electron 无 platform setter |
| 7 | UA 不能放进 `fingerprint` 对象 | `fpNormalizeConfig()` 会丢弃未知 key；且 `test-schema.js` 断言与内核 56 key **精确相等** |
| 8 | `platform` 有清晰内核注入点 | `NavigatorID::platform()`（`third_party/blink/renderer/core/frame/navigator_id.cc:61`） |
| 9 | 增量编译成本低 | `ninja -n` 改一个 Blink 文件仅 **16 个目标**。工具链在 `third_party/ninja/ninja.exe`（**不在 PATH**） |

**结论 3 是本设计最关键的一条**。它决定了实现顺序：必须先 `setUserAgent` 再创建 view。
幸运的是 `recreateTabView()` 本就销毁并重建 renderer，因此"切换 profile 时重建 view"这一既有
机制天然满足了 UA 的生效条件。

---

## 3. 数据模型

`profile.userAgent` —— 与 `fingerprint` **平级**的字符串字段：

```json
{
  "id": "macos-safari",
  "name": "macOS / Safari-like",
  "fingerprint": { "...56 keys..." },
  "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...",
  "createdAt": "..."
}
```

**为什么不是放进 `fingerprint`**（结论 7）：

- `fpNormalizeConfig()` 逐 key 过滤，未知 key 被**静默丢弃** → UA 会无声失效，正是本项目反复出现的失效模式
- `test-schema.js:44` 断言 `no client key unknown to kernel`，新增 key 会破坏与内核 56 key 的精确匹配

UA 属 **Electron 层**能力，与 56 个内核 key 是不同层级。平级字段让这个层级差异显式化，
而不是伪装成内核能力。

---

## 4. 实现

### 4.1 应用时机（由结论 3 决定）

```js
function applyTabUserAgent(partition, userAgent) {
  // 必须在创建 BrowserView 之前调用 —— 已验证：对已打开的 session
  // 设 UA 后 reload 不生效（T4），但同 partition 的新 view 会生效（T2）。
  session.fromPartition(partition).setUserAgent(userAgent || '');
}
```

调用点两处，均在 `new BrowserView(...)` **之前**：

- `createTabView()` — 新建 tab
- `recreateTabView()` — 切换 profile / 应用配置

空字符串即复位（结论 4），因此"无 UA 的 profile"用 `''`，无需特判。

### 4.2 IPC

- `tab:get-ua` → 返回该 tab 当前生效的 UA
- `tab:set-ua` → 设置并重建 view

复用既有 `recreateTabView()`，不引入新的重建路径。

### 4.3 随机 UA

按用户决策：**完全独立的随机 UA**，不跟随平台原型。

记录此决策的代价：会产生「Mac 屏幕 + Windows UA」这类跨组不一致组合。这违反了既有
C17 约束的精神，但用户明确选择独立性优先。因此在 UI 上**明确标注** UA 与平台原型无关，
让使用者自己判断，而不是假装两者协调。

### 4.4 预设

5 个预设各自获得与其宣称身份一致的 UA，消除自相矛盾。

### 4.5 UI

面板新增 UA 区：输入框 + Apply + Reset。标注 platform 未覆盖。

---

## 5. 第二步：内核 `navigator_platform` key

新增第 57 个内核 key，注入点 `NavigatorID::platform()`：

```cpp
String NavigatorID::platform() const {
  std::string fp = FpConfigString("navigator_platform");
  if (!fp.empty()) return String::FromUtf8(base::as_byte_span(fp));
  // ...原有原生分支
}
```

触及面（据 `webgl_vendor` 全仓库追踪）：

- `fingerprint/scripts/check.py` — `EXPECTED_KEYS` 增至 57
- 4 个 split patch + `fp-fingerprint.patch` monolith（由 `split_patch.js` 从源码重新生成）
- `Client/fp-schema.js` — 新增 key
- `devutils/gen_patch6.py` — key 表
- `fingerprint/scripts/smoke.js` — 冒烟项
- `Client/test-schema.js` — 自动跟随（从 check.py 抓取，无需改死数字）

**分两步交付的理由**：内核改动必须重编译才能验证（结论 9）。若与客户端改动混在一起，
一旦出现问题无法区分是客户端逻辑错误还是编译/内核注入错误。先交付可立即验证的
客户端 UA 功能，再单独编译验证内核部分。

---

## 6. 测试

`Client/test-ua.js`（live，需 Electron）：

1. 空 UA → 原生 UA
2. 设定 UA → `navigator.userAgent` 等于设定值
3. 设定 UA → **HTTP header** 等于设定值（本地 server 回显，不依赖外网）
4. 切换回空 → 复位到原生
5. 两个 tab 不同 partition 设不同 UA → 互不影响
6. 预设 UA 与其宣称平台一致

HTTP header 校验用本地 HTTP server 回显，避免依赖外网服务（外网依赖会让 CI 不稳定）。

---

## 7. 已知限制（交付时必须显式标注）

- **`navigator.platform` 在第一阶段仍未覆盖**（结论 6）。仅改 UA 会让
  「Mac UA + Win32 platform」成为新的不一致组合。这在 UI 与 README 中明确标注，
  由第二步内核补丁解决。
- **Sec-CH-UA Client Hints 未覆盖**（方案 B 范围）。
- **TLS/JA3/JA4 仍未覆盖**，见 `fingerprint/README.md`。
