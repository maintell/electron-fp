# fingerSDK 二次�?发包

基于自编译指纹版 Electron（`bin/electron.exe`）的脱仓二次�?发包�?
JS 应用层完全脱�? `electron-fp` 仓库可用；内核新�? / 改补丁必须回仓库走补丁流程�??

## 目录清单

| 路径 | 内容 | 出处 |
|---|---|---|
| `VERSION.txt` | SDK 日期 / Electron 版本 / 仓库 commit | 实测填入 |
| `bin/` | 可运行的指紋�? Electron（含 locales、resources�?**�?** `resources/app`�? | 原样复制 `MClient/dist` 已验证产物，`MClient.exe` 改回 `electron.exe` |
| `sdk/` | `fp-schema.js`、`fp-probe.js`、`tls-probe.js`、`browser-profile.js`、`tls/` 全目�? + 新建 `package.json` / `index.js` 聚合入口 | 原样复制 `MClient/`，内容未�? |
| `samples/mini-browser/` | �?小示例浏览器（全新编写）：`main.js`、`preload.js`、`profile.json`、`renderer/index.html`、`package.json` | 新写，顺序与 `MClient` �?�? |
| `docs/01-quickstart.md` | 环境要求、示例命令�?�常见首�? | �? |
| `docs/02-architecture.md` | 三平�? / UA / partition / 组模�? | �? |
| `docs/03-api-reference.md` | 主进�? API �? `fp-schema` 导出 | �? |
| `docs/04-key-tables.md` | 63+9+3 键表与�?�编码规�? | �? |
| `docs/05-traps.md` | 已实测的�? | �? |
| `docs/06-kernel-patches.md` | 补丁清单�?"内核层不可脱�?"声明 | �? |
| `docs/07-startup-abort-diagnosis.md` | �����ھ�Ĭ�˳���0x80000003 / STATUS_BREAKPOINT���ĳ�������ϲ��� | ���� |
| `docs/08-config-channels.md` | ָ������ע��ͨ����ʵ��У����`--fingerprint-config` ���ڲ�ͨ�������û� CLI�� | ���� |

## 二次�?发边界（二层�?

1. **JS 应用层（本包内）—�?�完全脱离可用�??** �? `sdk/` 读写配置、用
   `samples/mini-browser` 为起点写自己�? `main.js`、用 `bin/electron.exe`
   运行。不�?要仓库�?�不�?要构建�??
2. **内核层（新键 / 改语�? / 改补丁）—�?�必须回仓库�?** 键的实现�?
   `fingerprint/patches/`，生效要经过 `check.py` �? `apply.py` �? 全量编译�?
   本包没有任何能力新增或修改内核键。流程见 `docs/06-kernel-patches.md`�?
   构建约束见仓�? `AGENTS.md` / `CLAUDE.md`�?

## 快�?�开始（三步跑示例）

```bat
cd fingerSDK\samples\mini-browser
..\..\bin\electron.exe .
```

�? `profile.json` �?**重启应用**生效（原因见示例 `README.md`）�??

## 版本对应关系（占位）

| SDK 日期 | Electron | electron-fp commit |
|---|---|---|
| �? `VERSION.txt` | �? `VERSION.txt` | �? `VERSION.txt` |

> 后续 SDK 发布在此追加�?行：日期 / 二进制版�? / commit 三元组�??
