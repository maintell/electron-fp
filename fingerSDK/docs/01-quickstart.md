# 01 快速开始

## 环境要求

- **Win64**。`bin/` 下的全部 DLL / pak / locales 均为 Windows 构建产物，
  不可搬到 Linux / macOS 运行。
- 目录结构保持原样：`bin/electron.exe` 通过相对 `exe` 目录定位
  `resources/`、`locales/`；挪动单个文件即破坏运行。
- `bin/resources/` **故意不带 `app/` 目录**（见下"常见首错"）。

## 跑示例

```bat
cd fingerSDK\samples\mini-browser
..\..\bin\electron.exe .
```

有窗口弹出并打开 `https://example.com/` 即成功。
改指纹：编辑 `profile.json`，**重启应用**（`..\..\bin\electron.exe .` 再跑一次）。
热重载不生效——`settingsGrease` 之类在 partition 首次创建时冻结，
Blink 配置在 renderer 启动时注入，UA 只对之后创建的 view 生效
（详见 `docs/02-architecture.md` 与示例 `main.js` 注释）。

## 常见首错：`resources/app` 遮蔽

`electron.exe <script-or-dir>` 在 `resources/app` **存在时静默改道**：
它启动打包好的 app 而不是你传的路径参数，且**不打印任何东西**
（仓库 `Client/README.md` "Testing" 节-running 测试必须先把 `app` 移开，
正是这个原因）。

- 本包的 `bin/resources/` 出厂就没有 `app/`，所以示例能直接跑。
- 如果你某天把自己的应用拷进 `bin/resources/app/` 做"安装版"，
  此后 `bin\electron.exe <anything>` 都会启动它而忽略参数——这是
  Electron 的既定行为，不是 bug。双击 `bin\electron.exe` 即运行内置 app。
