# 行为拟人化（humanize）

> 性质：bounded doc write。只定行为层拟人化约束，不改代码、不改 SDK 签名。
> 上游：`script-sdk.md` §2（API 面）、`security.md` §2（沙箱能力）、`runtime.md` §2–§4（Adapter/白名单/外部接入）、`task.md` §4（队列语义）、`acceptance.md` §2–§3（P0/P1 + 三个裁定）。
> 并行 lane 产物按 NAME 引用，数值以实跑为准：`seeded-rng.js`、isolated-world 默认、`probe-cdp-evasion` 探针结果（以实跑为准）。

---

## 1. 威胁定位

值层 intact（见 `acceptance.md` #34：`fingerprint/` 零改动、FP 载体 scrub、env 通道门控 ADR-5、partition 隔离策略已证）。当前最大暴露面是**行为层**：值再真，操作节奏一机械即被聚类。

判定信号排序（强 → 弱）：

1. **evaluate 伪影** — 主 world 求值留下的可检测痕迹（函数 toString、栈 markers、属性污染），一票否决级。
2. **webdriver 旗** — `navigator.webdriver` 等显式自动化标志。
3. **跨 profile 节奏一致** — 多身份 timing 分布不可区分（同一种子/同一步调），批量执行最易露。
4. **鼠标/打字/滚动机械** — 直线轨迹、恒速按键、无惯性滚动。
5. **Input 辅助信号** — `Input.dispatchMouseEvent` 等与可信输入的细微差异（isTrusted 相关）。
6. **domain-enable（页面不可见）** — 过度 `Domain.enable` 本身一般页面看不见，排最末，只做卫生项。

---

## 2. 已拍板决策（4 条）

| # | 决策 | 理由（一行） |
|---|------|--------------|
| D1 | 默认 `Input.sendInputEvent`，CDP 兜底 | 进程内 `webContents.debugger` 零 TCP 暴露（`runtime.md` §2.1），不断 allowlist 单一 choke 点。 |
| D2 | SendInput（OS 级）仅高价值 opt-in | 保真最高但强制单机串行、抢焦点，批量并行直接死，不做默认。 |
| D3 | mistake 模型 v1 做 | 真人会敲错字，回退键是最便宜的人味，性价比最高。 |
| D4 | seed 派生即弃（`seed=hash(profileId)`，不落盘） | 换 seed = 换人设；seed 落盘即跨会话可链接，比不用更糟。 |

---

## 3. Seeded RNG 契约（`seeded-rng.js`，以实跑为准）

- `seed = hash(profileId)`：每次执行派生，用完即弃，不持久化、不进日志、不进审计。
- 所有 timing 只吃 seeded rng：worker poll 间隔、scheduler 步进 jitter、task backoff jitter（`task.md` §5.2 的 `uniform(0.8,1.2)` 即一例）、type delay、wait 超时抖动。
- 禁裸 `Math.random`（runtime 计时路径）：任何影响可观测节奏的随机必须走 seeded rng；非计时路径（id 生成等）不限。
- 换 seed = 换人设：同一 profile 同一 seed 复现同一节奏分布；跨 profile seed 不同，节奏分布不可互相预测。

---

## 4. Input 后端政策

- **默认**：`Input.sendInputEvent`（经 Adapter，`runtime.md` §3.1 白名单内）。
- **兜底**：CDP 其他 Input 域方法（白名单内），后端差异如实上报（`runtime.md` §2.3），不伪造。
- **opt-in**（同时满足才用 OS 级 SendInput）：① 高价值登录/签约类单点；② 调用方接受单机串行 + 前台焦点；③ 经 capability 显式授权 + 审计行。
- **NOT DO**：JS 伪造 `isTrusted`。`isTrusted` 是浏览器派发的不可伪造位，任何 JS 层 `dispatchEvent` 伪造只会留下 evaluate 伪影（§1 信号 #1），禁止。

---

## 5. 鼠标 / 打字 / 滚动规格（P1 Adapter 实现，SDK 签名不变）

`script-sdk.md` §2 的 `click/fill/type/scroll` 签名冻结；以下全在 Adapter 内实现：

- **鼠标**：Bezier 曲线（2 控制点）+ 落点 overshoot 回正 + Fitts 定律时长（距离越远越久，封顶）+ 采样率 60–120Hz 抖动。禁止两点直线 + 恒速。
- **打字**：digraph 间隔表 + lognormal 抖动；`delay` 参数只做均值缩放，不做固定步进。mistake 模型 v1 要点：低概率错字（邻键优先）+ 回退键删除 + 重敲，回退序列同样走 digraph timing；mistake 概率本身吃 seeded rng。
- **滚动**：分帧 + `easeOutCubic` 缓动 + 惯性尾（结束后续小步衰减）。禁止一次性 `scrollTo` 到位。

**落地状态（P1，2026-09-24 实跑）**：`human-input.js` 纯轨迹规划（25 PASS+SKIP） + `input-adapter.js` send-first 执行（10 PASS，含 A/B 缝线 contract 回归：planner 输出直驱 adapter） + `session.input.send`（browser-session 20 PASS，缺 send 后端抛 `NO_SEND_BACKEND` 走 CDP 兜底）；SDK 签名零改动；mistake 回退 Backspace 双事件映射已验。

---

## 6. Evaluate 最小化

- **isolated world 默认**：所有 `Runtime.evaluate` 走 isolated world（以实跑为准，见 `test-browser-session` 锚点 §8），主 world 零注入。
- **主 world 审计告警**：任何主 world 求值必须记审计行（含调用方、表达式哈希，不记原文），默认拒绝，opt-in 才放。
- **DOM-domain-first**：P1 补 `page.querySelector` 面（走 `DOM` 域 + `Runtime.callFunctionOn`），读文本/属性优先 DOM 域，不开 evaluate。
- **data-extraction 单 evaluate 约束**：一次数据抽取最多一次 evaluate（query 在 DOM 域做，组装在一次求值内完成）；`waitForFunction` 轮询同样计数，能用 smart waits（`script-sdk.md` §2.2）就不用 poll。

---

## 7. Recorder 去机械化

- `WAIT_GAP` jitter 化：录制器生成的等待间隔必须经 seeded rng 抖动后落盘，固定值只允许出现在草稿。
- `wait-ms` 模板禁入发布版：含裸 `waitForTimeout(ms)`（`script-sdk.md` §2.2 禁令，>1000ms 打 warning）的 ScriptVersion 不得发布；发布前 lint 拦截。
- 录制回放默认把固定延时替换为 smart waits（`page.wait` 统一入口），替换失败则标 warning 而不是静默保留。

---

## 8. 测试锚点（规格预期，以实跑为准）

- **`test-seeded-rng`**：同 seed 同序列（两次派生输出一致）；异 seed 异序列；timing 路径无裸 `Math.random`（静态断言：runtime 计时文件无 `Math.random` 直接调用）；seed 不落盘（执行后无含 seed 文件产物）。
- **`test-browser-session`（isolated）**：evaluate 默认走 isolated world；主 world 调用记审计行；`DOM` 域读文本零 evaluate 计数。
- **`probe-cdp-evasion`**：`navigator.webdriver` 值符合预期分布；CDP dispatch 与 `sendInputEvent` 的 `isTrusted` 行为一致性；movementX/Y 非零且非恒定；eval-stack 无 markers 残留。以上均为规格预期，数值以实跑为准。
- **`test-human-input`**：Fitts 单调/封顶/负距抛错；移动首末端点精确、dt 和=duration、N∈[2,200]、overshoot；同 seed JSON 一致、异 seed 分歧；hold∈[30,120]；mistake 三元组计数；scroll 和值精确；源码无 `Math.random`。
- **`test-input-adapter`**：moves 先于 down、send 抛单次→mixed、全抛→dispatch、Backspace 双映射、wheel 顺序透传、sleep 序列精确、**contract 回归（planner→adapter 端到端）**。

---

## 9. 探针待填表 + NOT DO

| 探针项 | 结果（`probe-cdp-evasion.js` 自跑实测，exit 0，Idle） |
|---|---|
| `navigator.webdriver` 值 | `false`（debugger attach 下）——无需补指纹键 |
| `isTrusted`（CDP dispatch） | `true`（mousedown/mouseup/keydown 三事件全 trusted） |
| `isTrusted`（sendInputEvent） | `true`（与 CDP 路径逐事件一致，无差别） |
| movementX/Y 分布 | 全 0/null——press/release+key 无移动增量（mousemove 缺失，P1 mouse 路径补 Bezier 移动序列） |
| eval-stack markers | `[]`（`at <anonymous>:1:21` 干净栈，无 evaluate/debugger/VM 标记） |

> 含义：两条 input 后端当前行为一致（press 级 trusted，打字/点击不断），D1 切 `sendInputEvent` 的理由是零 TCP 暴露+单一 choke 点，而非行为差异；真正的行为差距在**移动序列缺失**，归 P1 mouse 路径。

**NOT DO**（明确不承诺）：

- 不碰 BoringSSL / TLS 指纹面（值层已封，见 `acceptance.md` #34）。
- 不重开 env-port（`security.md` §5 + ADR-5：env 通道默认禁用）。
- 不调 `Browser.close`（`runtime.md` §3.2 拒绝清单：跨 target 浏览器级控制）。
- 不承诺 Playwright `newContext`（`runtime.md` §4.1 低保真声明：外部连接不新建 context）。
