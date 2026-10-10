# 07 启动期静默退出诊断（0x80000003 / STATUS_BREAKPOINT / exit 1）

> 适用：在目标宿主上 `electron.exe` 无任何输出即退出。
>
> **现象分成两类，先看退出码再对号入座：**
>
> | 退出码 | 含义 | 本节位置 |
> |---|---|---|
> | `0x80000003` | Chromium `LOG(FATAL)` → `__debugbreak()`（**有**错误信息，只是被丢弃） | 第 1–3 节 |
> | `1` + 完全无输出 | **缺少 `resources/default_app.asar`**（本包曾真实存在此缺陷，已修复） | **第 4 节** |

## 1. 0x80000003 是什么

`0x80000003` = NTSTATUS **`STATUS_BREAKPOINT`**（CPU 执行 `int 3`）。

```
Chromium LOG(FATAL) → IMMEDIATE_CRASH() → base/immediate_crash.h:108/115
                                        → #define TRAP_SEQUENCE1_() __debugbreak()
```

| 平台 | 信号 | 退出码 |
|---|---|---|
| Windows | `STATUS_BREAKPOINT` | `0x80000003`（有符号 `-2147483645`） |
| Linux / macOS | `SIGTRAP`(5) | `133` = 128+5 |

Linux 侧已复现同一现象，确认同源。

## 2. 为什么「静默」

`electron.exe` 的 PE 子系统为 **`IMAGE_SUBSYSTEM_WINDOWS_GUI`（值 2）**——GUI 子系统进程**没有控制台**，FATAL 文本写往不存在的 stderr，于是只留下退出码。

**消息是生成了的，是被丢弃了，不是不存在。** 上游官方 Electron 同样如此。

## 3. 会触发 0x80000003 的启动检查

### 3.1 缺 ICU 数据文件（**已实测复现**）

把 `electron.exe` 单独拷到空目录运行，实测：

```
ExitCode: -2147483645        <-- 即 0x80000003
[ERROR:base\i18n\icu_util.cc:237] Invalid file descriptor to ICU data received.
[FATAL:base\i18n\icu_util.cc:310] Check failed: result.
```

**成因**：`icudtl.dat` 缺失或不可读。打包/拷贝时若漏掉该文件，就是这个错。

### 3.2 NUL 设备不可用（Windows 专有）

```cpp
// shell/app/node_main.cc:210-217（node_bindings.cc:713-719 同理）
#if BUILDFLAG(IS_WIN)
  if (!platform_util::IsNulDeviceEnabled())      // _open("nul", _O_RDWR)
    LOG(FATAL) << "Unable to open nul device...try starting with --no-stdio-init";
#endif
```

触发于裁剪版/容器化 Windows、安全软件拦截、或当前目录有 `nul` 造成遮蔽。
**解法**：`--no-stdio-init`。

### 3.3 以 root 运行且未禁用沙箱（Linux 专有）

`electron_main_delegate.cc:223`，位于 `#if BUILDFLAG(IS_LINUX)` 内，**Windows 不会触发**。
Linux 解法：`--no-sandbox`。

## 4. exit 1 且完全静默：缺 `default_app.asar`（**本包已修复的真实缺陷**）

### 症状

```
electron.exe --version          -> ExitCode 1，stdout/stderr 全空
electron.exe <任意外部 app 路径> -> ExitCode 1，全空
```

### 实测定位过程

同一份 `electron.exe` 字节不变，只换目录：

| 位置 | `resources/` 内容 | 结果 |
|---|---|---|
| `MClient/dist/`（有 `app/`） | app + default_app.asar | **启动** |
| `fingerSDK/bin/`（两者都无） | accessibility + inspector_overlay | **exit 1，静默** |

把 `default_app.asar` 补回 `bin/resources/` 后立刻恢复：

```
ExitCode: 0
stdout: v45.0.0-nightly.20260825
```

`samples/mini-browser` 也随之正常启动。

### 成因

该 exe 带 **EnableEmbeddedAsar** fuse（二进制内含 sentinel
`dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`）。启用该 fuse 时，Electron 启动时**必须**
能加载 `resources/default_app.asar`；打包时把它连同 `app/` 一起剔除了，
于是 exe 无内容可启动，直接以 1 退出，且**不打印任何信息**。

### 修复

确保 `bin/resources/default_app.asar` 存在（108.6 KB，取自 `out/Default/resources/`）。
**不要**把 `app/` 目录打进去——`resources/app` 会**遮蔽**命令行传入的路径
（Electron 会静默改道去跑打包好的 app，且不提示），这正是 01 文档列的头号陷阱。

> 正确组合：`resources/` 内含 `default_app.asar`，**不含** `app/`。

## 5. 指纹补丁是否引入了这些问题？—— 否

- `fingerprint/patches/` 下**零**新增 `CHECK`/`LOG(FATAL)`；新增日志仅 `LOG(ERROR)`/`LOG(WARNING)`
- 未触及 `electron_main_delegate.cc` / `node_main.cc` 等启动路径
- `shell/` 中匹配 `fingerprint|Fp|fp_` 的文件，FATAL/CHECK 数量为 **0**

## 6. 诊断步骤

```powershell
# 第 1 步：看清退出码（用 Start-Process 才能拿到 GUI 进程的真实码）
$p = Start-Process -FilePath .\bin\electron.exe -ArgumentList '--version' `
      -Wait -PassThru -NoNewWindow -RedirectStandardOutput o.txt -RedirectStandardError e.txt
$p.ExitCode

# 第 2 步：按退出码分支
#   0x80000003 / -2147483645 -> 第 3 节（查 icudtl.dat 是否缺失，或试 --no-stdio-init）
#   1 且无输出               -> 第 4 节（查 resources/default_app.asar 是否存在）
```

抓 GUI 进程的输出：`2>&1 | Out-File` 或上例的 `-RedirectStandardError`；
普通 `2>err.txt` 对 GUI 子系统进程通常无效。

## 7. `--log-file` 抓不到启动期 FATAL

实测：以会触发 FATAL 的方式启动并加 `--enable-logging --log-file=...`，
**日志文件根本不会创建**——FATAL 早于日志系统初始化。FATAL 只无条件写 stderr。
所以别依赖 `--log-file` 诊断启动崩溃。

## 8. 结论

| 问题 | 结论 |
|---|---|
| 是否存在内核启动阻塞缺陷？ | **否**——指纹补丁不含任何启动期崩溃路径。 |
| `0x80000003` | Chromium `LOG(FATAL)` 的标准行为，消息被 GUI 子系统丢弃。 |
| exit 1 + 静默 | **曾是本包的真实打包缺陷**：漏了 `default_app.asar`（已修复）。 |
| Windows 上 0x80000003 的常见成因 | 缺 `icudtl.dat`（已实测）、NUL 设备（试 `--no-stdio-init`）。 |
