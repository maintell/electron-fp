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
  - Independent 56-key fingerprint config
  - Independent User-Agent
- **User-Agent coverage** (client-level) — per-tab UA applied via
  `session.setUserAgent()`, covering **both** `navigator.userAgent` and the HTTP
  `User-Agent` header. Presets, a preset dropdown, and free-form entry.
- **5 preset profiles**: Default, Windows 10/Chrome, macOS/Safari, Linux/Firefox, Mobile/Android
- **Random profile generator** — one-click randomize all fingerprint parameters
- **JSON editor** — edit fingerprint config directly
- **Import/Export** profiles as JSON files
- **Live fingerprint switching** — apply profile to active tab without restart
- **Always-on fingerprint sidebar** — permanent right-side panel showing the
  **active tab's own config**; switch tabs and the panel auto-syncs per tab
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
├── profiles.json    # Persistent profile storage
├── package.json
└── renderer/
    ├── index.html   # Browser chrome UI
    ├── style.css    # Dark theme styling
    └── app.js       # Renderer: tab bar, address bar, profile panel
```

### Isolation Model

Each tab creates a `BrowserView` with:
- `partition: fp-tab-{tabId}` — full cookie/session/storage isolation
- `fingerprint: { ... }` — 56-key config injected per-renderer via `--fingerprint-config`
- `userAgent` — applied per-partition via `session.setUserAgent()`
- Separate renderer process — no shared JS heap

The User-Agent lives **beside** `fingerprint` in a profile, never inside it.
`fpNormalizeConfig()` drops every key the kernel does not know, so a UA nested
in the fingerprint object would be silently discarded. It is also a different
layer: the 56 keys are read by Blink, whereas the UA is applied by Electron.

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

# Client schema vs kernel patch: 56 keys, 14 groups, no orphans (14 checks)
node Client/test-schema.js

# Random profile coherence over 300 samples (7 checks)
node Client/test-random.js

# Grouped panel UI renders 14 sections / 56 fields
electron Client/test-ui-groups.js

# Two-way JSON <-> group field sync (11 checks)
electron Client/test-ui-sync.js

# webrtc_ip reaches the kernel via --fingerprint-config (4 checks)
electron Client/test-webrtc-ip.js

# Upstream fingerprint smoke (window-level isolation, 20+ surfaces)
electron fingerprint/scripts/smoke.js --isolation --verbose
```

### Fingerprint Keys (56 keys / 14 functional groups)

Generated from `fp-schema.js`, the single source of truth. Every key is implemented
in the kernel patch and verified by `test-schema.js` (56/56 exact match).

| Group | Description | Keys |
|-------|-------------|------|
| Hardware | CPU cores, memory, touch points | `hardware_concurrency`, `device_memory`, `max_touch_points` |
| Screen | Resolution, avail area, color depth | `screen_width`, `screen_height`, `screen_avail_width`, `screen_avail_height`, `screen_color_depth` |
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

Value encoding (kernel parser rules):
- `int` / `int64` — JSON number; must be `> 0` to take effect (0 = disabled)
- `str` / `bool` / `csv` — JSON string; empty string = disabled (native passthrough)
- `dims` — `"min,max"` (WebGL ALIASED_*_RANGE)
- `sp` — `"rangeMin,rangeMax,precision"` (highp shader precision)
- `json` — JSON-encoded object (`webgpu_features` replaces, `webgpu_limits` merges)

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
| `navigator.platform` | **no** | stays `Win32`. Unaffected by `setUserAgent()`; Electron exposes no setter. Needs a kernel key (`navigator_platform`), tracked separately |
| `Sec-CH-UA` client hints | **no** | would need to stay consistent with the UA |
| TLS / JA3 / JA4 | **no** | network-stack fingerprint; see `fingerprint/README.md` |

Note on the randomizer: the UA is drawn from its **own** pool, independent of the
platform archetype, so a random profile can carry a Mac screen with a Windows
UA. This is deliberate but it is a cross-group inconsistency — worth reviewing
per profile rather than assuming the generator keeps them aligned.

## Testing

```bash
# Static (no browser)
node Client/test-schema.js     # 56-key schema vs kernel (15 checks)
node Client/test-random.js     # randomizer invariants (20 checks)

# Live (needs the built Electron; rename out/Default/resources/app first)
node Client/test-ua.js         # UA: JS + HTTP header, isolation, reset (8 checks)
node Client/test-fonts.js      # font blocklist via text metrics (6 checks)
node Client/test-webgpu.js     # WebGPU features/limits (10 checks)
```

`test-ua.js` guards the ordering rule above: moving `setUserAgent()` to after
view construction fails it immediately (verified by mutation).
