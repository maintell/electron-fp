# 01 · 竞品官方资料索引（Source Catalog）

> 范围：本方案要求的 **8 款**竞品——Multilogin、GoLogin、AdsPower、Dolphin Anty、Incogniton、Octo Browser、Undetectable、MoreLogin。
> 方法：以官方帮助中心 / API 文档 / 官方 SDK / 官方 GitHub 为主；第三方资料仅在明确标注为「间接证据」时使用。
> **访问日期：2026-10-09**（全表统一；个别页面自带 "last updated" 日期在条目内注明）。
> 证据等级：**A** 官方明确证实 · **B** 官方可运行示例可验证 · **C** 公开资料推断 · **D** 证据不足。
> 硬规则：官方未说明即记「官方资料未确认」，**不**推断为「不支持」；URL 一律给原始入口，不给搜索摘要；发现冲突记录双方版本。

## 0. 8 款产品一句话定位（供矩阵与选型交叉引用）

| # | 产品 | 控制面形态 | 是否有内置脚本引擎 | 官方 SDK | 自动化门槛 |
|---|------|-----------|------------------|---------|-----------|
| 1 | Multilogin | 云端 REST + 本地 Launcher（:45001） | 有（Python Script Runner） | 无（仅参考脚本 + 社区） | Pro 10 及以上 |
| 2 | GoLogin | 云端 REST + 本地 SDK 启动 Orbita | 无（Cookie Bot / Run-with-Sync） | **有**（Node + Python） | Free 计划排除 API |
| 3 | AdsPower | 本地 REST（local.adspower.net:50325） | 有（RPA / RPA Plus 可视化） | 无（仅示例仓库） | 需付费版 |
| 4 | Dolphin Anty | 本地 REST（:3001）+ 远程 v2 | 有（Script Builder 可视化） | 无（官方建议自生成 client） | 付费（Free 不可用） |
| 5 | Incogniton | 本地 REST（:35000，无 token） | 无（外部脚本） | **有**（Node + Python + CLI + MCP） | Entrepreneur 起 |
| 6 | Octo Browser | 云端 v2 + 本地（:58888，无鉴权） | 无（外部脚本） | 无 | Base 起 |
| 7 | Undetectable | 本地 REST（:25325） | 有（WebEngine JS 用户脚本，手动） | 无（官方 MCP + 示例仓库） | Base+ 可用（见 §7） |
| 8 | MoreLogin | 本地 REST（:40000）+ Open API（api.morelogin.com） | 无（浏览器）；有（云手机 RPA） | 官方 demo 仓库 + CLI + MCP | **Free 计划即含 Local API** |

---

## 1. Multilogin

| 字段 | 内容 | 等级 |
|------|------|------|
| 官方帮助中心 | https://multilogin.com/help/en_US | A |
| 自动化文档入口 | https://multilogin.com/help/en_US/api · 初学者指南 `/multilogin-x-api-beginners-guide` · 自动化 FAQ `/getting-started-with-multilogin-x-automation/automation-faq` | A |
| API 文档 | Postman Documenter：https://documenter.getpostman.com/view/28533318/2s946h9Cv9 （新版 `…/2sBXqJLM99`）；云端 `https://api.multilogin.com`（官方示例基址；`.org` 为同 API 可用别名，两域均活）；Launcher `https://launcher.mlx.yt:45001`（REST）/`:45003`（WSS） | A（端点 schema 仅 C，页面 SPA 抓取为空） |
| SDK / CLI / 仓库 | 官方 CLI `xcli`（`~/mlx/deps/cli`）；**无官方 SDK / 无官方 GitHub**；社区（C）：`github.com/multilogin-automation/multilogin-automation`、`multilogin-labs/multilogin-labs` | A（无 SDK 系官方未见） |
| 访问日期 | 2026-10-09 | — |
| 版本 | 端点按 v1/v2/v3 分版（v2 用于启动，推荐）；无产品级语义版本 | A |
| 已确认能力 | Python Script Runner（`script_params` 传参、多 profile）；Selenium/Puppeteer/Playwright 连接（Puppeteer/Playwright **仅 Mimic**）；`headless_mode`；Docker；`xcli`；cookies 导入导出；RPM 按套餐 | A/B |
| 未确认 | 内置调度器 / 队列 / 重试 / 优先级 / 运行历史；脚本超时；localStorage/sessionStorage/IndexedDB；启动前 init / 关闭前 cleanup 钩子；官方 SDK | D |
| 关键限制 | 普通 token 30 分钟；automation token 可配；RPM 50/75/100/100；核心版本仅保留最新 5 个；**RPA 明确不支持**；本地 WebDriver 不支持（仅 remote） | A |
| 证据位置 | 见 `03-competitor-technical-analysis.md` §Multilogin；原始 URL 见本表 | — |

## 2. GoLogin

| 字段 | 内容 | 等级 |
|------|------|------|
| 官方帮助中心 | https://gologin.com/docs（llms.txt：`/docs/llms.txt`） | A |
| 自动化文档入口 | Quickstart `/api-reference/introduction/quickstart` · Headless `/introduction/headless` · Cloud Browser `/cloud-browser/getting-started` · AI agents `/ai/cloud-browser-with-agents` | A |
| API 文档 | 基址 `https://api.gologin.com`；Swagger `https://api.gologin.com/docs/`；OpenAPI `https://docs-download.gologin.com/openapi.json`（`openapi:3.0.0, version:'1.0'`）；Cloud Browser `https://cloudbrowser.gologin.com/connect?token=…&profile=…` | A |
| SDK / CLI / 仓库 | 官方 Node SDK `github.com/gologinapp/gologin`（npm `gologin`）；官方 Python SDK `github.com/gologinapp/pygologin`；3 个官方 CLI（`gologin-web-access` / `gologin-agent-browser` / `gologin-local-agent-browser`，org `GologinLabs`）；MCP `gologinapp/gologin-mcp` | A |
| 访问日期 | 2026-10-09 | — |
| 版本 | OpenAPI `1.0`；REST 路径 `/browser/v2`、`/browser/{id}/web`；无单一产品版本号 | A |
| 已确认能力 | Node/Python SDK；Puppeteer/Playwright/Selenium 连接；Cloud Browser（远程 Chromium）；Cookie Bot；Run with Sync；CLI runbooks/batch/jobs；localStorage 导出导入；MCP + 4 个 Claude skill | A/B |
| 未确认 | 内置调度器/队列/优先级/超时/幂等；sessionStorage/IndexedDB；GoLogin 层的网络拦截（仅底层框架有）；脚本版本管理；脚本市场 | D |
| 关键限制 | 速率 300/500/800/1200 RPM（定价分档，2026-08-10 权威；rate-limits「1200」过时）；**429 会永久吊销 token**；Cloudflare 1015；新账号约 300 profile/天；Cloud 并发 1–4；本地建议并发 10–20、每 profile 约 300–500MB | A |
| 证据位置 | `03-competitor-technical-analysis.md` §GoLogin | — |

## 3. AdsPower

| 字段 | 内容 | 等级 |
|------|------|------|
| 官方帮助中心 | https://help.adspower.com/ （自动化 hub：`/docs/discover`） | A |
| 自动化文档入口 | RPA `/docs/rpa`；RPA Plus `https://rpa-plus-doc-en.adspower.com/docs/Process`（Task/Web Actions/Listener-Request/Marketplace）；API `/docs/api`；MCP `/docs/MCP` | A |
| API 文档 | 本地 API：`https://localapi-doc-en.adspower.com/`（概览 `/docs/Rdw7Iu`，示例 `/docs/K4IsTq`）；Postman `https://documenter.getpostman.com/view/45822952/2sB34hEzQH`；基址 `http://local.adspower.net:50325`（或 `localhost:50325`），`Authorization: Bearer <api-key>` | A |
| SDK / CLI / 仓库 | 官方示例仓库 `https://github.com/AdsPower/localAPI`（JS+Python）；**无官方打包 SDK**；无 CLI（仅 headless 启动器 `AdsPower Global.exe --headless=true`）；官方 MCP 用 `local-api-mcp-typescript` | A |
| 访问日期 | 2026-10-09 | — |
| 版本 | 路径分版 v1/v2（`/api/v1/...`、`/api/v2/browser-profile/...`）；无产品级 API 版本 | A |
| 已确认能力 | RPA V1 + RPA Plus 可视化（Execute-JS 步骤、Listener Request、子流程复用）；本地 API 启动返回 `ws.selenium`/`ws.puppeteer`/`webdriver`；Selenium/Puppeteer/Playwright（5 语言 + Firefox 示例）；定时 once/daily/weekly/monthly；任务线程 ≤100；单任务 profile ≤5000；Marketplace + 分享码 | A/B |
| 未确认 | 录制回放；启动前 init / 清理脚本（仅有清理「选项」）；RPA 内的 Node/npm 依赖；localStorage/sessionStorage/IndexedDB 端点；流程版本管理；优先级；重试/退避；幂等 | D |
| 关键限制 | Local API 需付费版；限流 5/15/25 req/s（=300/900/1500 req/min，v8.7.23 起；旧 2/5/10 与 1 req/s 过时）；key 重置需重启服务；headless 与 GUI 不可同机同开；进程 ≤3000、每组 ≤500 | A（含冲突） |
| 证据位置 | `03-competitor-technical-analysis.md` §AdsPower | — |

## 4. Dolphin Anty

| 字段 | 内容 | 等级 |
|------|------|------|
| 官方帮助中心 | https://docs.dolphin-anty.com/ （提供 `llms.txt` 与 `.md` 变体） | A |
| 自动化文档入口 | API 索引 `/en/api`；基础自动化 `/en/api/basic-automation-dolphin-anty`；Script Builder `/en/script-builder/script-builder-dolphin-anty`；MCP `/en/api/connecting-chrome-devtools-mcp-to-dolphin-anty` | A |
| API 文档 | Swagger `https://docs.dolphin-anty-cdn.com/index.html`；OpenAPI `http://docs.dolphin-anty-cdn.com/openapi.yaml`；**双面**：Remote API `https://apiv2.dolphin-anty-api.com/api/v2`（+Darkwing 远程 cookie v1）与 Local API `http://localhost:3001/v1.0/...`；JWT Bearer | A |
| SDK / CLI / 仓库 | **无官方 SDK / CLI / 官方 GitHub**；官方建议用 `openapi-generator` / `openapi-typescript` 自生成；随浏览器分发改版 ChromeDriver；官方 MCP 指引用社区 `chrome-devtools-mcp` | A |
| 访问日期 | 2026-10-09 | — |
| 版本 | 本地路径 v1.0，远程 v2（部分 team 端点仍 v1）；社区 MCP 称基于 OpenAPI v1.0.7（**C**） | A/C |
| 已确认能力 | Script Builder 可视化（Eval 块、Extensions 块、Popups 块、文件读写）；Local API 启动返回 `automation:{port,wsEndpoint}`；Puppeteer/Playwright（`connectOverCDP`）/Selenium；cookie/localStorage 导入导出（本地+远程）；场景转移（e-mail） | A/B |
| 未确认 | 调度/触发/队列/优先级/重试/退避/幂等；录制回放；启动前 init / 清理；Script Builder 的截图/下载块；sessionStorage/IndexedDB；官方并发上限；市场/版本管理/付费脚本 | D |
| 关键限制 | Local API 1500 req/min；Remote API 500 req/min→429（`x-ratelimiter-*`）；端口默认 3001（占用自动改）；JWT 到期可配；**Free 计划自动化/脚本/Synchronizer/远程 cookie 均 402**；ChromeDriver 须匹配浏览器版本 | A |
| 证据位置 | `03-competitor-technical-analysis.md` §Dolphin Anty | — |

## 5. Incogniton

| 字段 | 内容 | 等级 |
|------|------|------|
| 官方帮助中心 | https://docs.incogniton.com/ ；开发者门户 https://docs.incogniton.com/developers | A |
| 自动化文档入口 | 自动化设置 `/automation-api-and-sdks/automation-settings`；示例索引 `https://api-docs.incogniton.com/how-to-guides/automation-examples`；Puppeteer 抓取指南；CLI `https://api-docs.incogniton.com/cli` | A |
| API 文档 | https://api-docs.incogniton.com/apis ；本地 REST `http://localhost:35000`（Debug 设置可改）；**无 API token**；云 MCP `https://v5api.incogniton.com/mcp` | A |
| SDK / CLI / 仓库 | 官方 Node/TS SDK（npm `incogniton`）、Python SDK（PyPI `incogniton`）、CLI `incogniton-cli`；官方 org `https://github.com/WorkingGreen`；示例仓库 `WorkingGreen/incogniton-automation-examples`（11 Playwright + 2 Puppeteer + Python，标注 verified 2026-10-08）；MCP `@incogniton/mcp`（19 工具） | A |
| 访问日期 | 2026-10-09 | — |
| 版本 | **API 版本号官方未确认**（文档无版本）；profile 绑定浏览器版本（示例 129/131） | D/A |
| 已确认能力 | Node/Python SDK；Playwright（推荐，`connectOverCDP`）/Puppeteer/Selenium；headless；`launchPuppeteerCustom` 返回 DevTools URL；cookie/localStorage（框架级）；网络拦截（官方 Playwright 示例）；MCP 19 工具（不浏览）；Cookie Collector / Synchronizer | A/B |
| 未确认 | IndexedDB；启动前 init / 清理；速率限制（无 token、未公布 RPM）；脚本编辑器能力；运行统计；脚本版本管理/团队共享 | D |
| 关键限制 | **仅 Windows/macOS 桌面**，**Linux/Docker/托管 CI 不可用**；本地 API 仅 `127.0.0.1:35000`；每 profile 单会话（对已开启 profile 再启动即失败）；**不幂等**（明确警告不要「出错就重启」）；Synchronizer 1 主 + ≤4 子（Windows only） | A |
| 冲突 | Synchronizer 上限 = 5（1 主+4 子，Windows only；营销「20」为软性，已裁决）；框架支持以新 SDK 文档为准（Playwright+Puppeteer+Selenium） | — |
| 证据位置 | `03-competitor-technical-analysis.md` §Incogniton | — |

## 6. Octo Browser

| 字段 | 内容 | 等级 |
|------|------|------|
| 官方帮助中心 | https://docs.octobrowser.net/en/ （自动化分类 `/category/automation-and-api/`） | A |
| 自动化文档入口 | Working with API `/api/start-api/`；Puppeteer `/api/puppeteer-automation/`；One-Time Profiles `/api/one-time-profile/`；移动 CDP `/api/cdp-automation/`；Cookie Robot `/profiles/cookie-robot/` | A |
| API 文档 | 云端基址 `https://app.octobrowser.net/api/v2/automation`；OpenAPI 3.0 `https://octobrowser.github.io/documentation/openapi.json`；本地 `http://localhost:58888`（无鉴权）；Postman `documenter.getpostman.com/view/1801428/UVC6i6eA`；鉴权头 `X-Octo-Api-Token` | A |
| SDK / CLI / 仓库 | 官方文档仓库 `https://github.com/octobrowser/documentation`（CC BY 4.0，含 llms.txt/OpenAPI）；**无官方 SDK / CLI**（仅多语言片段） | A |
| 访问日期 | 2026-10-09 | — |
| 版本 | **API v2**（路径 `/api/v2/automation`）；本地 `force_stop` 需客户端 ≥1.7、auth login 需 ≥1.8.0 | A |
| 已确认能力 | 云端 v2 + 本地 REST；Puppeteer/Pyppeteer/Playwright/Selenium/CDP；one-time 临时 profile（auto-delete，4× RPM）；Cookie Robot；Docker/K8s 配方；Action Log WS（10 事件，24h 流 / UI 30 天）；profile 任务（提醒）；移动 profile CDP | A/B |
| 未确认 | profile 任务能否触发执行（API 明确「不提供」）；队列/优先级/重试/退避；启动前 init / 清理；IndexedDB；脚本版本管理；官方 SDK/CLI；token 过期语义 | D |
| 关键限制 | 限流 Lite/Starter 无，Base 50 RPM/500 RPH，Team 100/1500，Advanced 200/3000；请求加权（start=1、force_stop=2、one-time=4；400 错误扣 6 RPM/1 RPH）；`debug_port` 范围 1024–65534；**2FA 开启时本地 API 无法登录**；Docker 需 NET_ADMIN+SYS_ADMIN+/dev/shm≥1–4GB；移动 CDP 多项限制；**整 profile cookie 导出 API 不可能**；**Cookie Robot 不可经 API 启动** | A |
| 证据位置 | `03-competitor-technical-analysis.md` §Octo Browser | — |

## 7. Undetectable

| 字段 | 内容 | 等级 |
|------|------|------|
| 官方帮助中心 | https://docs.undetectable.io/ （FAQ `/faq/faq/`，页面标注 last updated 2026-07-31） | A |
| 自动化文档入口 | 本地 API 参考 `https://docs.undetectable.io/api/`；自动化指南（博客）`/blog/automating-with-undetectable-browser-api/`；AI/MCP 指南 `/blog/ai-automation-of-undetectable/`；WebEngine 用户脚本 `/undetectable-settings/webgine-scripts/` | A |
| API 文档 | 本地 API `http://127.0.0.1:25325`；Postman `https://api-docs.undetectable.io/`（collection `2sAYQfC8sn`）；**无 OpenAPI 下载**；**未发现鉴权头** | A（鉴权 C） |
| SDK / CLI / 仓库 | **无官方 SDK / CLI**；官方 org `https://github.com/undetectable-io`：`undetectable-selenium-connection`、`Undetectable-profile-creation-Selenium`、`Undetectable-browser-MCP`、`chromium-cdp-mcp`；MCP npm `undetectable-local-api-mcp-ts`（v1.1.4，2026-07-22） | A |
| 访问日期 | 2026-10-09 | — |
| 版本 | **API 版本号官方未确认**（collection tag=latest，无语义版本） | D |
| 已确认能力 | 本地 REST 端点齐全（profile CRUD/start/stop、browser opentab/openurl/click/fill/select/scroll/focus/press/evaluate/getpage/screenshot、cookies、proxies）；`/profile/start` 返回 `debug_port`+`websocket_link`；Selenium 官方示例；MCP；WebEngine JS 用户脚本（Chromium 外核） | A/B |
| 未确认 | 鉴权/令牌过期；速率/并发上限；headless；启动前 init / 清理；网络拦截与 per-store 缓存控制；脚本编辑器 DX；脚本版本/共享/市场；任务调度/重试/日志/幂等；Puppeteer/Playwright 是否有一方示例（仅博客声明） | D/C |
| 关键限制 | 端口 25325；无速率文档；无鉴权文档；**Local API 仅 Chromium 核 profile**；`websocket_link: ws://127.0.0.1:<port>/devtools/browser/<id>` | A/D |
| 冲突 | 计划门槛已裁决：Local API 非 Free，Base/Pro/Custom 可用（定价页 DOM 为准）；文档 bullet「all plans」过宽 | — |
| 证据位置 | `03-competitor-technical-analysis.md` §Undetectable | — |

## 8. MoreLogin

| 字段 | 内容 | 等级 |
|------|------|------|
| 官方帮助中心 | https://support.morelogin.com/en/ ；API 指南 https://guide.morelogin.com/ | A |
| 自动化文档入口 | Browser API `/api-reference/browser`；Local API `/api-reference/browser/local-api`（页面日期 2026-09-05）；Open API `/api-reference/browser/open-api`；端点行为矩阵 `/api-reference/browser/endpoint-behavior`（53 操作）；MCP `/mcp/overview`；CLI `/cli`；RPA `/rparobotic-process-automation/` | A |
| API 文档 | Local API `http://127.0.0.1:40000`（可配）；Open API `https://api.morelogin.com`；OpenAPI 下载 `local-api.json/.yaml`；鉴权：本地可选静态 token（仅回环）、Open API OAuth2（token 3600s） | A |
| SDK / CLI / 仓库 | 官方 demo `https://github.com/MoreLoginBrowser/MoreLogin-API-Demos`；Agent Skills `MoreLoginBrowser/morelogin-skills`；CLI `ml-cli`；内置 MCP（客户端 ≥2.50.0） | A |
| 访问日期 | 2026-10-09 | — |
| 版本 | 无语义版本；文档快照 2026-09-05；客户端门槛 v2.9.0（API）/v2.14.0（create/update）/v2.15.0（start/local API）/v2.28.0（cache/fingerprint refresh）/v2.36.0（isHeadless/cdpEvasion）/v2.50.0（MCP）/v2.56.0（closeCheckIPPage） | A |
| 已确认能力 | Local API（`/api/env/start|close|status|closeAll`、`removeLocalCache` 支持 localStorage/indexedDB/cookie/extension、fingerprint/refresh）；Open API + 云运行时（返回 `cdpUrl`+`accessUrl`）；Selenium/Puppeteer/Playwright（官方示例）；`ml-cli`；内置 MCP；RPA 可视化（**云手机**）；端点重试/完成矩阵；团队锁 | A/B |
| 未确认 | sessionStorage 清除；浏览器侧网络拦截（无原生端点）；浏览器任务优先级/暂停恢复/持久日志历史；RPA 编辑器代码级 DX；公开幂等键（明确未文档化）；API 语义版本 | D |
| 关键限制 | 限流 GCRA `rate=200,burst=10,period=1m`（业务码 35000，**未设 HTTP 429**）；创建量：Local API 1–50 / Open API 1–200（Local 页「1–200」为误抄）；云手机创建 1–10；本地并发 create 受团队锁；Open API token 1 小时；云运行时 URL 短时效（`connect` 重发使旧 viewer 失效）；Firefox 仅 Win/macOS | A（含冲突） |
| 冲突 | 限流=GCRA 200/min burst 10（120/min 过时）；创建量 Local 1–50 / Open 1–200；拒绝为 body code:35000（非 HTTP 429） | — |
| 证据位置 | `03-competitor-technical-analysis.md` §MoreLogin | — |

---

## 9. 官方 URL 汇总（可点击）

1. Multilogin 帮助：https://multilogin.com/help/en_US · API hub：https://multilogin.com/help/en_US/api · 自动化 FAQ：https://multilogin.com/help/en_US/getting-started-with-multilogin-x-automation/automation-faq
2. GoLogin 文档：https://gologin.com/docs · OpenAPI：https://docs-download.gologin.com/openapi.json · Node SDK：https://github.com/gologinapp/gologin · Python SDK：https://github.com/gologinapp/pygologin
3. AdsPower 帮助：https://help.adspower.com/ · Local API：https://localapi-doc-en.adspower.com/ · 示例：https://github.com/AdsPower/localAPI · RPA Plus：https://rpa-plus-doc-en.adspower.com/
4. Dolphin Anty 文档：https://docs.dolphin-anty.com/ · API：https://docs.dolphin-anty.com/en/api · Swagger：https://docs.dolphin-anty-cdn.com/index.html · Script Builder：https://docs.dolphin-anty.com/en/script-builder/script-builder-dolphin-anty
5. Incogniton 文档：https://docs.incogniton.com/ · API：https://api-docs.incogniton.com/apis · 示例：https://github.com/WorkingGreen/incogniton-automation-examples
6. Octo 文档：https://docs.octobrowser.net/en/ · API：https://docs.octobrowser.net/en/api/start-api/ · OpenAPI：https://octobrowser.github.io/documentation/openapi.json
7. Undetectable 文档：https://docs.undetectable.io/ · API：https://docs.undetectable.io/api/ · org：https://github.com/undetectable-io
8. MoreLogin 帮助：https://support.morelogin.com/en/ · API 指南：https://guide.morelogin.com/ · Local API：https://guide.morelogin.com/api-reference/browser/local-api · 示例：https://github.com/MoreLoginBrowser/MoreLogin-API-Demos

## 10. 检索过程与失败记录（诚实披露）

- Multilogin 的 Postman API 参考（两个 Documenter 链接）经 `webfetch` 返回**空**（客户端渲染 SPA），端点 schema 只能依赖搜索引擎渲染与帮助中心交叉印证 → 标 C。
- AdsPower 的 `localapi-doc-en.adspower.com/` 根与 GitHub README 曾超时/失败，改用搜索索引文本；RPA Plus `ThirdParty-Tools` 抓取两次失败。
- Undetectable 的 API 参考为 Scalar/Postman 渲染（JS 重），无 spec 下载，故鉴权/限流标 D/C。
- 所有「第三方 / 社区」证据在 `03-competitor-technical-analysis.md` 中已明确标注，不并入官方结论。

> 下一步：功能矩阵见 [02-competitor-matrix.md](02-competitor-matrix.md)，机制与证据等级见 [03-competitor-technical-analysis.md](03-competitor-technical-analysis.md)。
