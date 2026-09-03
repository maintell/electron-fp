# Agent Constraints — electron-fp

Project-level constraints for AI agents working in this repo. In addition to the
global rules in `~/.config/opencode/AGENTS.md`, the constraints below apply to
**every** command this project runs.

---

## 1. Compilation and test processes MUST run at LOW priority

**Rule:** any process that compiles, links, or runs the test suite — and every
process it spawns — must have its Windows priority class set to **Idle**
(`IDLE_PRIORITY_CLASS`, the lowest class) for its entire lifetime.

Applies to, at minimum:

| Category | Examples |
|---|---|
| Compile / link | `e build`, `ninja`/`autoninja`, `gn`, `cl.exe`/`clang-cl`, `lld-link`, `e sync` |
| Test runners | `e test`, `node script/spec-runner.js`, `node Client/run-tests.js`, `electron.exe` (spec runs), `mocha` |
| Fingerprint probes | any `Client/test-*.js` script, TLS/HTTP2 probe servers |
| Heavy lint/CI | `npm run lint`, `lint:clang-tidy`, `lint:docs` (long, multi-process) |

Rationale: full Electron links take 30–40 minutes and saturate every core. At
normal priority the machine becomes unusable for interactive work. **Idle**
priority yields CPU only when nothing else wants it, so the build still finishes
but never starves the desktop.

### 1.1 Correct method (verified on this machine)

Lower the priority **after** launch and wait on the handle. Launching via
`Start-Process` gives you a real process object, so the **exit code survives** —
which `start /LOW` does not (see §1.3).

```powershell
# . .\Set-LowPriorityTree.ps1   (helper lives at F:\Temp\opencode\Set-LowPriorityTree.ps1)
$p = Start-Process -FilePath "F:\code\src\third_party\ninja\ninja.exe" `
      -ArgumentList '-C','F:\code\src\out\Default','electron' `
      -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput "$env:TEMP\build.out" `
      -RedirectStandardError  "$env:TEMP\build.err"

Start-Sleep -Milliseconds 1500
$null = Set-LowPriorityTree -RootId $p.Id      # root + all descendants -> Idle

$p.WaitForExit()                                # no timeout: links take 30-40 min
"exitcode = $($p.ExitCode)"
Get-Content "$env:TEMP\build.out"
```

The `Start-Sleep` before downgrading lets the direct children spawn; the helper
then walks the tree, so **compiler/linker grandchildren are covered too** — not
just the parent `ninja.exe`.

Long builds must be launched this way (detached + polled) rather than run
inline: the shell tool kills commands at 120 s, and a killed build shows up as a
hang stuck on `[n/m]`. Poll with `Get-Process -Name ninja` instead.

### 1.2 Helper: `Set-LowPriorityTree`

Recursive tree downgrade (root + every descendant), verified to catch
grandchildren that a single-process downgrade misses:

```powershell
function Set-LowPriorityTree {
    param(
        [Parameter(Mandatory)][int]$RootId,
        [System.Diagnostics.ProcessPriorityClass]$Priority =
            [System.Diagnostics.ProcessPriorityClass]::Idle
    )
    $queue   = [System.Collections.Generic.Queue[int]]::new()
    $queue.Enqueue($RootId)
    $seen    = [System.Collections.Generic.HashSet[int]]::new()
    $applied = 0

    while ($queue.Count -gt 0) {
        $id = $queue.Dequeue()
        if (-not $seen.Add($id)) { continue }
        $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($proc) { try { $proc.PriorityClass = $Priority; $applied++ } catch { } }
        Get-CimInstance Win32_Process -Filter "ParentProcessId = $id" `
            -ErrorAction SilentlyContinue |
            ForEach-Object { $queue.Enqueue([int]$_.ProcessId) }
    }
    return $applied
}
```

Re-apply periodically (every few minutes) for long builds: ninja spawns new
compiler processes continuously, and new children start at Normal.

### 1.3 Methods that DO NOT work — do not use

| Method | Why it fails |
|---|---|
| `Start-Process -PriorityClass Idle` | Parameter does not exist in PowerShell 7+ (Windows PowerShell 5.1 only). Errors with *"A parameter cannot be found that matches parameter name 'PriorityClass'"*. |
| `cmd /c start /LOW /WAIT …` | **Silently discards the exit code** — `exit 42` comes back as `0`. A failed build/test looks green. Never use this for anything whose result you check. |
| `Start-Process -WindowStyle` + `-NoNewWindow` together | Fatal: *"Parameters '-NoNewWindow' and '-WindowStyle' cannot be specified at the same time"*. Pick one. |
| Downgrading only the parent | Compiler/linker grandchildren keep Normal priority — the processes that actually burn the CPU. |

### 1.4 Reference commands on this machine

`e` is **not installed** here (no `e` shim on `PATH`, no `@electron/build-tools`).
Use the direct invocations, all confirmed present:

```powershell
# Build (chromium checkout is the parent dir F:\code\src)
F:\code\src\third_party\ninja\ninja.exe -C F:\code\src\out\Default electron

# Test suite
node .\script\spec-runner.js
node .\Client\run-tests.js

# Built binary
F:\code\src\out\Default\electron.exe
```

If `e` is ever installed, wrap it the same way — `e build` / `e test` are
node shims that spawn ninja/electron as children, so the tree walk covers them.

---

## 2. Related project constraints

- **Hard-won traps are documented in `fingerprint/README.md`** — read it before
  touching anything in `fingerprint/`. The expensive ones:
  - *"注册一个新 WebUI scheme 需要三处独立注册"* — three independent scheme
    registrations, each with a DIFFERENT failure mode; plus
    `ShouldServiceRequest` must be overridden or the data source is found and
    then silently rejected.
  - *"配置值格式陷阱"* — five measured traps where a config value looks set but
    is silently ignored (`FpConfigString()` quote truncation, quoted numeric
    keys, `audio_data_strength` as a number, …).
  - *"构造期约束（HTTP/2，踩过坑，勿"简化"）"* — HTTP/2 settings must be sent at
    a specific point in construction.

- **Never use `npx`** — silently fetches and executes arbitrary packages. Spawn
  from `node_modules/.bin/` or use `yarn <tool>`. (See `CLAUDE.md`.)
- **`Client/run-tests.js` only counts lines starting with `PASS`/`FAIL`/`SKIP`** —
  test output must use those exact prefixes.
- **Before running standalone Electron scripts**, `F:\code\src\out\Default\resources\app`
  must be renamed to `_app_off`; otherwise the packaged app shadows the script and
  it produces no output. `Client/run-tests.js` handles this automatically.
- **Destroy every `BrowserWindow` before `app.exit()`** — otherwise the
  `render_process_host_impl.cc` FATAL CHECK aborts the process and test results
  never print.
- **`openssl` must be on `PATH`** (`C:\OpenSSL-Win64\bin`) for probe cert generation.
- **Do not run `e test` / `e start` unless asked** — leave verification to the user.
