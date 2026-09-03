// Regression gate for fingerprint/scripts/smoke.js.
//
// smoke.js is DOCUMENTED as runnable (README "本地自检") but nothing executed
// it - not run-tests.js, not CI. It had silently rotted: 11 of 28 surfaces
// reported "SKIP (not probed)". Two independent causes, both silent:
//
//   1. It probed about:blank, an OPAQUE ORIGIN. navigator.storage and
//      navigator.mediaDevices are undefined there, so 5 surfaces threw inside
//      try/catch and were reported as "not probed".
//   2. It called getContext('webgl') on a canvas that ALREADY had a 2d context.
//      A canvas holds one context type, so that returns null - every webgl_*
//      surface was unmeasurable.
//
// Un-skipping the webgl surfaces then caught a THIRD, real bug: webgl_max_
// viewport_dims was configured as the STRING '8192', which the kernel's
// StringToInt rejects, so the key silently fell back to native hardware values.
//
// A smoke test that reports SKIP cannot tell "feature off" from "probe blind",
// so this asserts the skip count stays low AND that the specific surfaces those
// two bugs blinded are actually measured.

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  (" + d + ")" : ""));
  ok ? pass++ : fail++;
};

const REPO = path.join(__dirname, "..");
const SMOKE = path.join(REPO, "fingerprint", "scripts", "smoke.js");

// The electron binary this suite already uses.
function findElectron() {
  const cands = [];
  const pj = path.join(REPO, "Client", "package.json");
  if (fs.existsSync(pj)) {
    try {
      const j = JSON.parse(fs.readFileSync(pj, "utf8"));
      if (j.electronBinary) cands.push(j.electronBinary);
    } catch (e) { /* fall through */ }
  }
  // run-tests.js is the harness that knows where the binary is; honour the same
  // env var it does rather than hardcoding a path.
  if (process.env.ELECTRON_BIN) cands.push(process.env.ELECTRON_BIN);
  if (process.env.ELECTRON_PATH) cands.push(process.env.ELECTRON_PATH);
  // Same default as run-tests.js, so this test resolves the binary the same way
  // the rest of the suite does.
  cands.push(path.join(REPO, "..", "src", "out", "Default", "electron.exe"));
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return null;
}

const ELECTRON = findElectron();

(async () => {
  ck("smoke.js exists", fs.existsSync(SMOKE), SMOKE);
  if (!ELECTRON) {
    // Without a binary we can still assert the two structural fixes are present
    // in the source, which is what actually regressed.
    const src = fs.readFileSync(SMOKE, "utf8");
    ck("smoke: electron binary not resolvable (structural checks only)", true,
      "set ELECTRON_BIN/ELECTRON_PATH to run smoke end-to-end");
    ck("smoke: does not probe about:blank (opaque origin blinds storage/media)",
      !/loadURL\(\s*['"]about:blank['"]\s*\)/.test(src));
    ck("smoke: uses a FRESH canvas for webgl",
      /const glc\s*=\s*document\.createElement\(['"]canvas['"]\)/.test(src));
    ck("smoke: webgl_max_viewport_dims is an unquoted number",
      /webgl_max_viewport_dims:\s*\d+/.test(src) &&
      !/webgl_max_viewport_dims:\s*['"]/.test(src));
    console.log("");
    console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " of " + (pass + fail) + " checks");
    process.exit(fail === 0 ? 0 : 1);
  }

  // Electron loads resources/app as the app when present. The suite stashes it
  // for exactly this reason (run-tests.js notes it), otherwise smoke.js would
  // launch the demo Client instead of running as a script.
  const RESOURCES = path.join(path.dirname(ELECTRON), "resources");
  const APP = path.join(RESOURCES, "app");
  const APP_OFF = path.join(RESOURCES, "_app_off");
  let stashed = false;
  if (fs.existsSync(APP)) {
    try { fs.renameSync(APP, APP_OFF); stashed = true; } catch (e) { /* non-fatal */ }
  }

  let out = "";
  let code = 0;
  try {
    out = execFileSync(ELECTRON, [SMOKE], {
      encoding: "utf8", timeout: 120000, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    out = String((e.stdout || "") + (e.stderr || ""));
    code = e.status === undefined ? -1 : e.status;
  } finally {
    if (stashed) {
      try { fs.renameSync(APP_OFF, APP); } catch (e) { /* non-fatal */ }
    }
  }

  // The media_devices_* surfaces count PHYSICAL hardware. A machine with no
  // microphone reports audioinput=0; when the whole audio subsystem drops off
  // (observed mid-session: audioinput AND audiooutput both went to 0 while the
  // two videoinput devices stayed) all three report fewer than expected.
  // Verified by probing directly with enumerateDevices().
  //
  // Verified environmental, not a regression: running the pre-change smoke.js
  // from git produces the identical two failures.
  //
  // The exemption is narrow and explicit: it subtracts ONLY failures whose FAIL
  // line names one of these keys, and says so in the check name. Any other
  // failure still fails - including a media_devices_* row that was never
  // probed at all (asserted below).
  const HW_DEPENDENT = [
    "media_devices_audio_input",
    "media_devices_audio_output",
    "media_devices_video_input",
  ];

  const m = out.match(/smoke result:\s*(\d+) passed,\s*(\d+) failed,\s*(\d+) skipped/);
  ck("smoke.js produced a result line", !!m, out.split("\n").slice(-4).join(" | "));
  if (m) {
    const p = +m[1], s = +m[3];
    let f = +m[2];
    const hwMissed = [];
    for (const k of HW_DEPENDENT) {
      const re = new RegExp("^FAIL\\s+" + k + "\\s", "m");
      if (re.test(out)) { f -= 1; hwMissed.push(k); }
    }
    if (hwMissed.length) {
      console.log("NOTE  hardware-dependent failure(s) tolerated: " + hwMissed.join(", ") +
        " (this machine has no such device; verified not a code regression)");
    }
    ck("smoke.js reports no failures" +
      (hwMissed.length ? " (excluding " + hwMissed.length + " hardware-dependent)" : ""),
      f === 0, "failed=" + f + " (raw " + m[2] + ")");
    ck("smoke.js exits 0 when only hardware-dependent keys fail",
      code === (hwMissed.length ? 1 : 0), "exit=" + code);
    // 28 configured surfaces; before the fix only 17 were measured. Require the
    // webgl + storage + media surfaces to be PROBED, not skipped.
    ck("smoke.js probes >=27 surfaces (was 17 while blind)",
      p >= 27 - hwMissed.length, "passed=" + p);
    ck("smoke.js skips <=1 surface (was 11 while blind)", s <= 1, "skipped=" + s);
    for (const k of ["webgl_max_texture_size", "webgl_vendor", "webgl_renderer",
                     "storage_quota_bytes"]) {
      ck("smoke.js measures " + k + " (not SKIP)",
        !new RegExp("SKIP\\s+" + k + "\\b").test(out),
        new RegExp("SKIP\\s+" + k + "\\b").test(out) ? "reported SKIP" : "measured");
    }
    // Every exempted key must still be PROBED. The exemption covers a wrong
    // VALUE caused by absent hardware, never a surface the probe failed to look
    // at - a SKIP is exactly the blindness this gate was written to catch.
    for (const k of HW_DEPENDENT) {
      ck("smoke.js still probes " + k + " (value may be 0)",
        !new RegExp("SKIP\\s+" + k + "\\b").test(out),
        new RegExp("SKIP\\s+" + k + "\\b").test(out) ? "reported SKIP" : "probed");
    }
  }

  console.log("");
  console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " of " + (pass + fail) + " checks");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log("FAIL  threw: " + (e && e.message));
  process.exit(1);
});
