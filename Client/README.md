# Electron FP Client

Multi-tab fingerprint browser built on electron-fp.

## Run

```bash
# From the project root (electron-fp/):
# 1. Build Electron first (if not built):
e build

# 2. Run the client:
out/Release/electron.exe Client/
# or on Linux/macOS:
# out/Release/electron Client/
```

## Features

- **Multi-tab** with Ctrl+T / Ctrl+W / middle-click close
- **Per-tab fingerprint isolation** — each tab gets:
  - Unique `BrowserView` with independent renderer
  - Unique `partition` for full cookie/session/storage isolation
  - Independent 63-key fingerprint config
  - Independent User-Agent
  - Independent 9-key TLS/HTTP2 config (`session.setSSLConfig()`)
- **User-Agent coverage** (client-level) — per-tab UA applied via
  `session.setUserAgent()`, covering **both** `navigator.userAgent` and the HTTP
  `User-Agent` header. Presets, a preset dropdown, and free-form entry.
- **5 preset profiles**: Default, Windows 10/Chrome, macOS/Safari, Linux/Firefox, Mobile/Android — each now configures the TLS plane too, so a profile named "macOS/Safari" does not speak Chromium's GREASEd ClientHello (see below)
- **Random profile generator** — one-click randomize all fingerprint parameters
- **JSON editor** — edit fingerprint config directly
- **Import/Export** profiles as JSON files
- **Live fingerprint switching** — apply profile to active tab without restart
- **Always-on fingerprint sidebar** — permanent right-side panel showing the
  **active tab's own config**; switch tabs and the panel auto-syncs per tab
- **Built-in self-test** — a **Self-test** tab in that sidebar runs the shared
  probe inside the live tab and checks every surface *you* configured against
  what that tab actually reports. See [Self-test](#self-test) below.
- **DevTools** per tab (F12 or button)

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Ctrl+T | New tab |
| Ctrl+W | Close tab |
| Ctrl+L / F6 | Focus address bar |
| F5 / Ctrl+R | Reload |
| F12 | Toggle DevTools |
| F10 | Toggle fingerprint panel |

## Architecture

```
Client/
├── main.js          # Main process: tab lifecycle, IPC, fingerprint injection
├── preload.js       # Secure bridge (contextIsolation)
├── fp-schema.js     # 63-key schema, normalization, coverage, consistency rules
│                    # + 9-key TLS table and fpSplitConfig() (the plane router)
├── fp-probe.js      # SHARED probe: PROBE script + compare(). Used by both the
│                    # self-test panel and fingerprint/scripts/smoke.js
├── tls-probe.js     # ClientHello capture + TLS verdicts. Runs in the MAIN
│                    # process: the handshake is invisible to page JS
├── profiles.json    # Persistent profile storage
├── package.json
├── test-*.js        # Kernel regression tests (run: node run-tests.js)
└── renderer/
    ├── index.html   # Browser chrome UI (incl. the Self-test pane)
    ├── style.css    # Dark theme styling
    └── app.js       # Renderer: tab bar, address bar, profile panel, self-test
```

## Self-test

The sidebar has two tabs — **Config** and **Self-test**. Self-test probes the
**current tab** and compares each surface against **that tab's own config**, so
it answers "did *my* settings apply?" rather than "did some fixed set of values
apply?".

The probe reads **58 of the 63 keys** from inside the page. The 9 TLS keys are
measured separately (see below), from a ClientHello captured in the main process,
so **67 of the 72 configurable surfaces** produce a row. "Produces a row" is not
"can be judged" — with every surface configured at once, a measured run returned
45 pass / 7 fail / 3 unknown / 3 skip, so **52 of 72** could actually be called
pass or fail. The gap is the honest part: `unknown` and `skip` are reported as
such rather than painted green. Each surface gets one of five verdicts:

| Verdict | Meaning |
|---|---|
| `pass` | configured, and the surface reports exactly what was configured |
| `fail` | configured, but the surface reports something else |
| `unknown` | it applied, but this surface cannot be judged from a single reading |
| `skip` | not configured, or the probe cannot read it on this page |
| `error` | the probe itself threw |

`unknown` exists because some surfaces have no value to compare against.
`audio_data_seed`'s observable is a *checksum* — the only honest statement is
"it changed", and one reading has no baseline. `webrtc_ip` with no gathered ICE
candidates means the host found nothing, not that spoofing failed. Reporting
either as `fail` would mark a working key broken; reporting it `pass` would be
a lie.

**`skip` is not a success.** A key you never set was never checked, so painting
it green would let a default profile read as all-clear. Skipped rows are hidden
by default; tick *Show skipped surfaces* to see all of them.

### TLS keys are measured differently

The 9 TLS keys cannot be read from page JavaScript: the ClientHello is built and
sent by the network service, and no page API exposes it. `tls-probe.js` therefore
opens a loopback TCP server, drives one request through the tab's own session
with `electron.net.request`, and parses the handshake bytes off the wire. That
is what JA3/JA4 fingerprint from — the *offered* ClientHello — so it is the
right thing to measure, and it needs no external site.

Four of the nine keys (`fpCipherList`, `fpAdvertisedVersionMax`,
`fpPermuteExtensions`, `fpSignatureAlgorithms`) can only be judged as "the
offered set changed", so the self-test takes a second capture with no TLS config
as a baseline. If that baseline fails, those keys read `unknown` rather than
being guessed at.

### The 5 keys the self-test cannot show

Not "not implemented" — each was measured and is unreadable from page JS:

| Key | Why there is no row |
|---|---|
| `canvas_noise_strength` | a *modifier*: the kernel gates it on `canvas_noise_seed > 0` (`00-core.patch:265`). With no seed there is nothing to perturb, so it has no independent surface. `test-canvas-strength.js` measures it against a seeded baseline. |
| `audio_data_strength` | same shape: `fp-fingerprint.patch:672` returns early when `audio_data_seed == 0`. Covered by the audio-seed test. |
| `geo_latitude` / `geo_longitude` / `geo_accuracy` | `navigator.geolocation.getCurrentPosition()` rejects with code 2 and no position exists to override. Reading them needs a privileged channel, not a page probe. |

Both noise-strength keys are real and verified — they just cannot carry their
own row, because the seed is what makes them observable.

The failure cases are the reason the pane exists. A key can look set — the
config editor shows it, the Inspector counts it as active — while the renderer
quietly uses something else, most often the real hardware value. Failures carry
a one-line explanation drawn from traps that were actually measured:

- `webgl_max_viewport_dims: "8192"` (quoted) → rejected by the kernel, falls
  back to the real `32767,32767`
- `webgpu_limits` with quotes inside → `FpConfigString` truncates at the first
  quote and applies nothing
- `audio_data_strength` as a number → serialised unquoted, so `FpConfigString`
  cannot read it and the `0.0005` default is used
- `webgpu_device` / `webgpu_description` → only exposed when
  `WebGPUDeveloperFeatures` is enabled

### One probe, two callers

`Client/fp-probe.js` holds the probe script and `compare()`. Both the self-test
panel and `fingerprint/scripts/smoke.js` require it — there is deliberately only
one probe, because two copies would silently disagree about what "working"
means. It was extracted verbatim from smoke.js and verified equivalent:
`PROBE` byte-identical, `EXPECTED` 28/28 keys with identical values and order,
`compare()` behaviourally identical across 39 cases.

Tests: `test-selftest.js` (verdict logic, including two real trap cases) and
`test-selftest-ui.js` (the pane's DOM/IPC wiring).

### Isolation Model

Each tab creates a `BrowserView` with:
- `partition: fp-tab-{tabId}` — full cookie/session/storage isolation
- `fingerprint: { ... }` — 63-key config injected per-renderer via `--fingerprint-config`
- `userAgent` — applied per-partition via `session.setUserAgent()`
- Separate renderer process — no shared JS heap

The User-Agent lives **beside** `fingerprint` in a profile, never inside it.
`fpNormalizeConfig()` drops every key the kernel does not know, so a UA nested
in the fingerprint object would be silently discarded. It is also a different
layer: the 63 keys are read by Blink, whereas the UA is applied by Electron.

**Ordering matters:** `setUserAgent()` must be called **before** the
`BrowserView` is constructed. Measured: setting it on an already-open session
does not reach existing views even after a reload, but a **new** view on the
same partition does pick it up. Passing `''` reverts to the native UA.

**Runtime profile switching:** fingerprint is fixed at renderer startup, so applying a
new profile recreates the tab's `BrowserView` (same `partition`, new renderer) and
reloads the page. `setFingerprintConfig()` alone does NOT take effect on a live renderer —
the process must respawn.

**Panel / BrowserView layering:** The fingerprint panel is a **real layout column**
(flex child of `#main-row`), not a floating overlay. The window layout is a vertical
flexbox: `#top-bar` (tab bar + address bar, 72px, full width) / `#main-row`
(`#content-area` flex:1 + `#fp-panel` 420px column) / `#status-bar` (22px, full width).
Because `BrowserView` is a **native layer** rendered on top of the DOM, it is sized via
`setBounds` to occupy only the `#content-area` (left of the panel, below the top bar,
above the status bar). When the panel is toggled off, the `BrowserView` expands to the
full width. The panel is never an overlay — it directly occupies the right column.

### Test Scripts

```bash
# Verify BrowserView rendering + fingerprint injection
electron Client/test-render.js

# Verify per-tab isolation + runtime profile switch (10 checks)
electron Client/test-integration.js

# Client schema vs kernel patch: 63 keys, 15 groups, no orphans (14 checks)
node Client/test-schema.js

# Random profile coherence over 300 samples (7 checks)
node Client/test-random.js

# Grouped panel UI renders 15 sections / 63 fields
electron Client/test-ui-groups.js

# Two-way JSON <-> group field sync (11 checks)
electron Client/test-ui-sync.js

# webrtc_ip reaches the kernel via --fingerprint-config (4 checks)
electron Client/test-webrtc-ip.js

# TLS keys: client table vs kernel setSSLConfig, plane splitting, the
# TLS 1.3 cipher-name trap (49 checks)
node Client/test-tls-keys.js

# TLS verdict table: can this ClientHello be judged, and is 'unknown'
# never reported as 'pass'? (29 checks)
node Client/test-tls-verdicts.js

# TLS end-to-end: a config typed as a user types it reaches the wire and
# changes the real ClientHello (24 checks)
electron Client/test-tls-e2e.js

# TLS through the real GUI: open the panel, apply, click Self-test, read the
# rendered verdicts back (12 checks)
electron Client/test-tls-gui.js

# The probe must finish on a HIDDEN tab (Chromium throttles timers there, and
# a setTimeout-based sampling loop blew the 15s budget) (12 checks)
electron Client/test-probe-hidden-tab.js

# A preset profile's claimed browser must match its real ClientHello (18 checks)
electron Client/test-profile-tls.js

# A TLS value of the wrong type must be refused, not silently ignored (43 checks)
node Client/test-tls-types.js

# The TLS group must be VISIBLE in the Config pane: first section, inside the
# fold, styled distinctly. It once rendered as the 16th section at ~3013px in a
# 2808px pane with no CSS at all, so users reported it as missing (9 checks)
electron Client/test-tls-ui-visible.js

# Opening a tab FROM a preset must apply that preset's TLS plane (9 checks)
# This one caught a real bug: createTabView() passed the raw profile to
# `fingerprint` and never called setSSLConfig(), so a Safari-preset tab
# spoke Chromium's native GREASEd hello.
electron Client/test-profile-tab-tls.js

# Upstream fingerprint smoke (window-level isolation, 20+ surfaces)
electron fingerprint/scripts/smoke.js --isolation --verbose
```

### The self-test works on a hidden tab too

The probe's `perf_now_precision_ms` sampling loop must yield between samples or
every reading lands on the same millisecond — but it must **not** yield with
`setTimeout`. A tab that is not the visible one has
`document.visibilityState === "hidden"`, and Chromium throttles timers in hidden
pages to roughly one tick per second. Measured while hidden:

| yield strategy | 24 samples took |
|---|---|
| `setTimeout(0)` | 17117ms |
| `setTimeout(8)` (the old loop) | ~24000ms — blew the 15s budget |
| `requestAnimationFrame` | never settles |
| **MessageChannel + 2ms spin** (current) | **51ms** |

With the old loop, running Self-test on any tab except the front one reported
**"probe timeout after 15s" for every key** — which reads as a broken
fingerprint rather than a throttled timer. `test-probe-hidden-tab.js` asserts
both halves: the loop uses no timer, and the probe actually completes while
hidden.

### Where to find the TLS settings in the UI

Open the **Fingerprint** panel. The **TLS / HTTP2** group is the **first**
section, marked with an amber left border and labelled `· setSSLConfig`. Its 9
keys are the only ones applied to the network layer rather than the page.

It is first because it was originally appended after the 15 Blink groups, which
put it at roughly 3013px inside a 2808px pane — permanently below the fold, with
nothing to mark it as different, so it read as absent. The amber accent exists
because the distinguishing class (`fp-field-tls`) was being applied in JS with
no CSS rule behind it.

### Preset profiles carry a TLS plane

Each named preset now sets the TLS keys consistent with the browser it claims.
Before this, all four set 29–31 Blink keys and **zero** TLS keys, so the most
browser-distinguishing layer of all still said "Chromium" under a Safari UA.

| preset | TLS shape | why |
|---|---|---|
| `win10-chrome`, `mobile-android` | GREASE on | Chromium GREASEs (RFC 8701) |
| `macos-safari` | GREASE off | WebKit does not implement GREASE |
| `linux-firefox` | GREASE off, `fpAdvertisedVersionMax=771` | NSS does not GREASE; 771 is the only way to drop the TLS 1.3 suites |
| `default` | none | native passthrough — the baseline the self-test compares against |

Only keys with a measured, stable effect are set. `fpGreaseEnabled` was verified
6/6 either way before it was baked into a preset. The remaining keys
(`fpCipherList`, `fpExtensionOrder`, `fpSignatureAlgorithms`,
`fpPermuteExtensions`) are left unset: they change the hello but do not
correspond to a named browser shape, so setting them would be decoration
pretending to be fidelity.

The randomizer derives the same plane from the UA it picked, so a generated
profile cannot pair a Safari UA with a GREASEd hello.

### Fingerprint Keys (63 keys / 15 functional groups)

Generated from `fp-schema.js`, the single source of truth. Every key is implemented
in the kernel patch and verified by `test-schema.js` (63/63 exact match).

Counts in this file are checked by `test-readme-counts.js`, so they cannot
silently go stale again — it found this table listing 56 of 63 keys.

| Group | Description | Keys |
|-------|-------------|------|
| Hardware | CPU cores, memory, touch points | `hardware_concurrency`, `device_memory`, `max_touch_points` |
| Screen | Resolution, avail area, color depth, DPR | `screen_width`, `screen_height`, `screen_avail_width`, `screen_avail_height`, `screen_color_depth`, `device_pixel_ratio` |
| Audio | Sample rate, channels, latency, noise seed | `audio_sample_rate`, `audio_max_channels`, `audio_output_latency_ms`, `audio_data_seed`, `audio_data_strength` |
| WebGL | Vendor/renderer, limits, extensions, precision | `webgl_max_texture_size`, `webgl_max_renderbuffer_size`, `webgl_max_viewport_dims`, `webgl_aliased_point_size_range`, `webgl_aliased_line_width_range`, `webgl_vendor`, `webgl_renderer`, `webgl_extensions`, `webgl_shader_precision_highp` |
| WebGPU | Adapter metadata, features and limits | `webgpu_vendor`, `webgpu_architecture`, `webgpu_device`, `webgpu_description`, `webgpu_features`, `webgpu_limits` |
| Geolocation | Latitude, longitude, accuracy | `geo_latitude`, `geo_longitude`, `geo_accuracy` |
| Speech | Voice count and language | `speech_voices_count`, `speech_voices_lang` |
| Media Devices | Audio/video device counts, codec denylist | `media_devices_audio_input`, `media_devices_video_input`, `media_devices_audio_output`, `media_codecs_denylist` |
| Canvas & Text | Canvas noise, text metrics, element rects | `canvas_noise_seed`, `canvas_noise_strength`, `measure_text_seed`, `client_rects_seed` |
| Locale & Privacy | Timezone, color scheme, Do Not Track | `tz_id`, `prefers_color_scheme`, `do_not_track` |
| Network | Connection type, RTT, downlink, WebRTC IP | `net_effective_type`, `net_rtt_ms`, `net_downlink_mbps`, `webrtc_ip` |
| Storage & Perf | Quota, usage, timestamp precision | `permissions_status`, `storage_usage_bytes`, `storage_quota_bytes`, `perf_now_precision_ms` |
| Fonts | Font family blocklist / whitelist | `fonts_blocklist`, `fonts_whitelist` |
| Battery | Charging state and level | `battery_charging`, `battery_level` |
| Navigator | Platform, vendor, languages, client hints | `navigator_platform`, `navigator_vendor`, `navigator_languages`, `ua_platform`, `ua_mobile`, `ua_brands` |

Value encoding (kernel parser rules):
- `int` / `int64` — JSON number; must be `> 0` to take effect (0 = disabled)
- `str` / `bool` / `csv` — JSON string; empty string = disabled (native passthrough)
- `dims` — `"min,max"` (WebGL ALIASED_*_RANGE)
- `sp` — `"rangeMin,rangeMax,precision"` (highp shader precision)
- `json` — JSON-encoded object (`webgpu_features` replaces, `webgpu_limits` merges)

### TLS / HTTP2 keys (9 keys, a second delivery plane)

**These are not part of the 63.** They live in a separate table (`FP_TLS_KEYS`)
and take a different route to the wire, which is why they have their own section
here rather than a row above:

| | Blink keys (63) | TLS keys (9) |
|---|---|---|
| Read by | Blink | the network service |
| Delivered via | `--fingerprint-config` | `session.setSSLConfig()` |
| Configured in | `net::SSLContextConfig` | same, but a different field set |
| Observable from | page JavaScript | a captured ClientHello only |

Putting a TLS key inside the 63-key table would break both planes:
`fpNormalizeConfig()` drops every key absent from `FP_KEYS`, so the key would be
silently discarded at apply time while the panel showed it as configured. This
is exactly how the 9 keys came to be implemented in the kernel and exposed by
nothing in the client — no test compared the two sides, so nothing failed.
`test-tls-keys.js` now asserts `fpNormalizeConfig()` would drop all 9 and that
`fpSplitConfig()` preserves all 9, so the gap cannot reopen silently.

| Key | Type | Measured effect |
|---|---|---|
| `fpCipherList` | string | offered cipher set changes (16 → 5 with one TLS 1.2 name) |
| `fpSignatureAlgorithms` | list | `signature_algorithms` extension changes |
| `fpGreaseEnabled` | bool | GREASE values appear/disappear (1 → 0) |
| `fpGreaseSigalgsEnabled` | bool | a GREASE value joins the extensions |
| `fpPermuteExtensions` | bool | extension order changes |
| `fpExtensionOrder` | list | the named extensions appear in that order |
| `fpOmitAlpn` | bool | `application_layer_protocol_negotiation` (0x0010) drops out |
| `fpOmitSessionTicket` | bool | `session_ticket` (0x0023) drops out |
| `fpAdvertisedVersionMax` | int | offered cipher set changes entirely |

#### Do not put a TLS 1.3 cipher name in `fpCipherList`

`setSSLConfig()` accepts `TLS_AES_128_GCM_SHA256` and hands it to BoringSSL,
which rejects the whole cipher command — after which **every request on that
session fails** with `net::ERR_UNEXPECTED` and not a single byte of ClientHello
is sent. Measured:

```
fpCipherList: 'TLS_AES_128_GCM_SHA256'        ->  0 bytes, net::ERR_UNEXPECTED
fpCipherList: 'ECDHE-RSA-AES128-GCM-SHA256'   ->  1751 bytes, works
```

`fpTlsValidateCipherList()` rejects the three TLS 1.3 names before they reach
the network service, with a message naming a working TLS 1.2 equivalent. Unknown
names are deliberately *not* whitelisted: a list of every OpenSSL cipher would
go stale and then reject working values. Only the measured foot-gun is caught.

#### A wrong value type is silently ignored

The kernel reads every TLS key with `options.Get(key, &out)`, which returns
`false` on a type mismatch and then **skips the key**. No throw, no warning, no
log — the value is dropped and the session keeps its native shape, so the UI
shows the profile as applied while nothing changed. Measured:

```js
// all of these "succeed" and do nothing:
setSSLConfig({ fpGreaseEnabled: 1 });        // GREASE still 3 (native)
setSSLConfig({ fpAdvertisedVersionMax: "771" });  // still offers TLS 1.3

// the correct types do apply:
setSSLConfig({ fpGreaseEnabled: false });    // GREASE -> 0
setSSLConfig({ fpAdvertisedVersionMax: 771 });    // ciphers 16 -> 13
```

The two `u16list` keys are the loud case — they *throw*, but with `Error
processing argument at index 0, conversion failure from `, naming neither the
key nor the type it wanted. So a wrong type is either silent or undiagnosable.

`fpTlsValidateTypes()` rejects all of them before `setSSLConfig()`, naming the
key, the type it wanted, and the value it got:

```
fpGreaseEnabled wants a boolean, got number (1)
fpExtensionOrder wants an array of numbers, got string ("0,23,65281")
```

This is the same failure class as `FpConfigString`'s silent truncation: a config
that looks applied and is not. `fpSplitConfig()` already coerces every value to
the type the kernel wants, so configurations arriving through the app are safe;
this guard exists for the direct `setSSLConfig()` caller.

Note that `u16list` keys take a real JS **array** (`[23, 65281]`), not a
comma-separated string. `fpTlsCoerce()` converts `"0,23,65281"` — and hex like
`"0x0403"` — into one.

Disabled defaults are deliberate: a profile must never claim a fingerprint surface
it cannot back. Inconsistent surfaces are themselves a detection signal, so the
randomizer keeps `webgl_vendor` == `webgpu_vendor`, geo coordinates aligned with
`tz_id`, and touch points consistent with the screen form factor.

## Known Limitations

The User-Agent is covered, but the surfaces below are **not**. They are stated
explicitly so a deployment does not assume more protection than it has.

| Surface | Covered | Note |
|---|---|---|
| `navigator.userAgent` | yes | via `session.setUserAgent()` |
| HTTP `User-Agent` header | yes | same call covers both |
| `navigator.platform` | yes | kernel key `navigator_platform`. Defaults to disabled (`''`), so a profile opts in explicitly |
| `Sec-CH-UA` client hints | yes | keys 58–60 (`ua_platform`/`ua_mobile`/`ua_brands`); unset derives from the UA, so they cannot drift apart |
| TLS / JA3 / JA4 | **yes** | `40-net-tls.patch`; per-URLRequestContext, so per-tab. Only `fpExtensionOrder` is unimplemented (it errors rather than lying). See `fingerprint/README.md` |
| `webgpu_device` / `webgpu_description` | **partly** | the keys apply, but upstream Blink only exposes `adapter.info.device/description` when `WebGPUDeveloperFeatures` is on (`--enable-blink-features=WebGPUDeveloperFeatures`). Without it they read `''` |

### 32 keys are inert if you pass them as a number

`Session::SetFingerprintConfig()` serialises the raw JS object with
`base::WriteJson` and does **not** run `fpNormalizeConfig()`. So:

```js
sess.setFingerprintConfig({ device_pixel_ratio: 3 });    // JSON number  -> INERT
sess.setFingerprintConfig({ device_pixel_ratio: "3" });  // JSON string  -> applies
```

The kernel reads these keys with `FpConfigString()`, which returns `""` for a
JSON number. There is no error and no log — the key silently does nothing and
the real value is reported. Measured on 11 keys with an observable surface:

| key | as number | as string |
|---|---|---|
| `device_pixel_ratio` | dpr 1 (unchanged) | dpr 3 |
| `navigator_platform` | `Win32` | `12345` |
| `tz_id` | `Asia/Shanghai` | `America/New_York` |
| `net_effective_type` | `3g` | `4g` |
| `prefers_color_scheme` | `light` | `dark` |
| `do_not_track` | `null` | `1` |
| `ua_platform` | `Windows` | `Plan9` |
| `battery_level` | `1` | `0.5` |
| `navigator_vendor` | `Google Inc.` | `12345` |
| `navigator_languages` | `zh-CN,...` | `en-US` |

**The Client UI is safe**: `main.js` runs `fpNormalizeConfig()` before applying,
so typing `3` into the JSON editor works. The trap is for direct API callers —
scripts and tests. `test-string-key-inertness.js` enumerates all 32 keys from
the delivered patches and asserts `fpNormalizeConfig` coerces a number to a
string for every one, so a new string-read key added later is caught.

This was first found on `audio_data_strength` and believed to affect only that
key. It does not.

For consistency, `navigator_platform` should agree with any UA override: a Mac
UA wants `MacIntel`, Android wants `Linux armv8l`. The two are **separate
surfaces with nothing enforcing agreement**, so `fpPlatformForUserAgent()`
derives the platform from the UA that was actually chosen — in the randomizer
and when presets were generated. A mismatched pair is itself a signal, so it is
derived rather than left to the operator.

Note the randomizer deliberately draws its UA from an **independent** pool, not
from the platform archetype, so a random profile can carry a Mac screen with a
Windows UA. The platform follows the UA (so the pair never contradicts itself),
but the screen/GPU does not — that cross-group inconsistency is intentional and
is surfaced here rather than hidden.

### Some keys can only shrink, never grow

`media_devices_*` and `speech_voices_count` are applied by **truncating** the
host's real device/voice list:

```c
if (fp_count > 0 && fp_count < mojom_voices.size())   // shrink only
  mojom_voices.resize(fp_count);
```

Asking for more than the machine actually has is a **silent no-op** — no error,
no log. A profile requesting 3 audio inputs on a host with 0 still reports 0.
Set these below the host's real count, or expect them to do nothing.

Verified both ways by `test-coverage-audit.js`: truncation works (2 video
inputs → 1), and asking for 99 on a host with 0 leaves it at 0.

## Testing

```bash
npm test                       # every Client test (766 checks, 51 files)
npm test -- test-ua.js         # just one file
```

`run-tests.js` exists because running the files by hand is error-prone in two
ways that both fail SILENTLY:

1. **`resources/app` shadows the tests.** If `out/Default/resources/app`
   exists, `electron.exe` launches the packaged app instead of your script and
   prints nothing. Every test then reports 0 passes and looks catastrophically
   broken. The runner moves it aside and restores it on exit (including
   ctrl-c), and refuses to call a no-output run a pass.
2. **One process per test.** Tests build BrowserViews with random partitions;
   a crashed GPU or network service otherwise takes out every check after it.

Set `ELECTRON_BIN` if your binary is not at `../src/out/Default/electron.exe`.

### Two test layers, and why both matter

- **`test-schema.js`** (static) proves the client and kernel *agree* on all 60
  keys. It proves nothing about whether the kernel *honours* a value.
- **`test-coverage-audit.js`** (live, 34 checks) applies a config in a real
  browser and asserts each surface actually reports it. All 63 keys are
  covered and nothing is skipped.

The gap between them is real. When the audit was first written, 10 checks
failed; 9 were bugs in the audit itself and only 1 was a product bug. Verifying
against kernel source - rather than trusting either signal alone - is what
separated them.

Known traps the audit encodes, each found by getting it wrong first:

| Surface | Trap |
|---|---|
| `audio_data_strength` | Scales noise amplitude. `0` means "add nothing", so every seed renders identically. |
| `media_codecs_denylist` | Hooks `MediaCapabilities.decodingInfo()`, **not** `canPlayType()`; matches substrings (`"avc1"`, not `"h264"`). |
| `webgl_vendor`/`renderer` | Only override the `UNMASKED_*` pnames. Plain `VENDOR` is untouched. |
| `mediaDevices`, `storage`, `getBattery` | Secure-origin gated - `undefined` on `data:` URLs. Serve from `127.0.0.1`. |
| `geo_*` | Needs a real position to rewrite; inject one via CDP, and `Page.enable` + focus emulation or the page is not "visible" and Geolocation returns early. |
| `webgpu_device`/`description` | Absent from `GPUAdapterInfo` unless `WebGPUDeveloperFeatures` is on. |
| `speech_voices_*` | Lazy and process-wide: the **first** renderer to touch it sees 0 voices. Warm up before measuring. |

`test-ua.js` guards the ordering rule above: moving `setUserAgent()` to after
view construction fails it immediately (verified by mutation).
