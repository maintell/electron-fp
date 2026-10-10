# sdk-mini-browser

Minimal fingerSDK sample: one window, one partition, profile driven by
`profile.json`.

## Run

```bat
cd fingerSDK\samples\mini-browser
..\..\bin\electron.exe .
```

## Change the fingerprint

1. Edit `profile.json` (Blink keys under `fingerprint`, UA as `userAgent`,
   TLS keys as `fp*`, HTTP/2 keys as `settingsGrease` / `endStreamWithDataFrame`).
2. **Restart the app** (`..\..\bin\electron.exe .` again).

Restart is required, not a shortcut: the HTTP/2 plane freezes at the first
`fromPartition()` for the partition name, the Blink plane is injected at
renderer startup, and the UA only reaches views created after `setUserAgent()`.
Editing the file cannot move any of those. See `main.js` step comments and
`docs/02-architecture.md`.
