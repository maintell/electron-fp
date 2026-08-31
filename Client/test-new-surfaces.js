// Kernel regression guards for keys 61-63: navigator_vendor,
// navigator_languages, device_pixel_ratio.
//
// These three were found by an external audit against browserleaks.com and
// creepjs: with all 60 original keys set they still reported the host's real
// values, each contradicting the spoofed UA. This test exists so they cannot
// silently regress - an ordinary schema test would not catch the kernel hook
// being placed on the wrong class (which is exactly how the vendor fix failed
// on the first attempt: NavigatorID::vendor() does not exist, and hooking
// NavigatorBase::vendor() does not compile).
//
// Run with: node test-new-surfaces.js   (expects the built electron on PATH
// via run-tests.js, or run it under electron directly)
"use strict";

const fs = require("fs");
const { app, BrowserWindow, BrowserView } = require("electron");
const http = require("http");
const schema = require("./fp-schema.js");

// Opposite of the Windows host, so every controlled surface must change.
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const CFG = {
  navigator_platform: "iPhone",
  navigator_vendor: "Apple Computer, Inc.",
  navigator_languages: "en-US,en",
  device_pixel_ratio: "3"
};

const PROBE = `(function(){
  return JSON.stringify({
    vendor: navigator.vendor,
    language: navigator.language,
    languages: (navigator.languages || []).join(','),
    dpr: window.devicePixelRatio,
    platform: navigator.platform
  });
})()`;

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  (" + d + ")" : ""));
  ok ? pass++ : fail++;
};

let url = "";
const srv = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end("<html><body>new-surfaces</body></html>");
});

(async () => {
  await new Promise(r => srv.listen(0, "127.0.0.1", () => {
    url = "http://127.0.0.1:" + srv.address().port + "/"; r();
  }));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 500, height: 400 });

  async function probe(fp) {
    const part = "ns-" + Math.random().toString(36).slice(2);
    const v = new BrowserView({ webPreferences: { partition: part, sandbox: false, fingerprint: fp } });
    win.addBrowserView(v);
    await v.webContents.loadURL(url);
    const g = JSON.parse(await v.webContents.executeJavaScript(PROBE, true));
    win.removeBrowserView(v);
    try { v.webContents.destroy(); } catch (e) {}
    return g;
  }

  // 1) Schema: the three keys must exist and be the right kind.
  for (const k of ["navigator_vendor", "navigator_languages", "device_pixel_ratio"]) {
    ck("schema has " + k, !!schema.FP_KEYS[k], "kind=" + (schema.FP_KEYS[k] || {}).kind);
  }
  ck("schema key count is 63", schema.FP_KEY_NAMES.length === 63, String(schema.FP_KEY_NAMES.length));

  // 1b) The SHIPPED PRESETS must set these too. The kernel fix is worthless if
  // a preset omits navigator_vendor: macos-safari originally had a Mac UA and
  // no vendor, so it reported the host's "Google Inc." - the exact leak this
  // file exists to prevent. Each preset's value must also match what the UA
  // derivation would produce, so a preset can never contradict its own UA.
  const profiles = JSON.parse(fs.readFileSync(__dirname + "/profiles.json", "utf8")).profiles;
  let presetMissing = [], presetMismatch = [];
  // Only the four SHIPPED presets are held to this standard. A profile the user
  // generated before these keys existed is legitimately missing them - the
  // kernel treats an absent key as "disabled" and falls back to the host, so
  // old saved profiles keep working. Asserting on them would fail every user
  // who generated a profile before the upgrade.
  const SHIPPED = ["win10-chrome", "macos-safari", "linux-firefox", "mobile-android"];
  for (const p of profiles) {
    if (!p.fingerprint) continue; // 'default' = deliberately no fingerprint
    if (SHIPPED.indexOf(p.id) === -1) continue;
    const ua = p.userAgent || "";
    const isApple = /Macintosh|iPhone|iPad/.test(ua);
    const isMobile = /Android|iPhone|iPad/.test(ua);
    const f = p.fingerprint;

    for (const k of ["navigator_vendor", "navigator_languages", "device_pixel_ratio"]) {
      if (f[k] === undefined || f[k] === null || f[k] === "") presetMissing.push(p.id + "." + k);
    }
    const wantVendor = isApple ? "Apple Computer, Inc." : "Google Inc.";
    if (f.navigator_vendor && f.navigator_vendor !== wantVendor) {
      presetMismatch.push(p.id + ": " + f.navigator_vendor + " under a " + (isApple ? "Apple" : "non-Apple") + " UA");
    }
    const dpr = parseFloat(f.device_pixel_ratio);
    if (f.device_pixel_ratio && isMobile && !(dpr > 1)) {
      presetMismatch.push(p.id + ": mobile UA with dpr " + f.device_pixel_ratio);
    }
  }
  ck("shipped presets set all three new keys", presetMissing.length === 0, presetMissing.join(", "));
  ck("shipped presets agree with their own UA", presetMismatch.length === 0, presetMismatch.join("; "));

  // 2) Defaults must be empty => disabled => real value passthrough.
  const def = schema.fpDefaultConfig();
  ck("navigator_vendor defaults empty", def.navigator_vendor === "");
  ck("navigator_languages defaults empty", def.navigator_languages === "");
  ck("device_pixel_ratio defaults empty", def.device_pixel_ratio === "");

  // 3) An explicit value must survive normalization (NOT a tautology: the
  //    default seed makes presence checks unfalsifiable, so check the VALUE).
  const norm = schema.fpNormalizeConfig(CFG).config;
  ck("navigator_vendor survives normalization", norm.navigator_vendor === "Apple Computer, Inc.", norm.navigator_vendor);
  ck("navigator_languages survives normalization", norm.navigator_languages === "en-US,en", norm.navigator_languages);
  ck("device_pixel_ratio survives normalization", norm.device_pixel_ratio === "3", norm.device_pixel_ratio);

  // 4) Kernel: with no config the host's real values must come through.
  const base = await probe(null);
  ck("baseline vendor is the host value", base.vendor === "Google Inc.", base.vendor);
  ck("baseline dpr is the host value", base.dpr === 1, String(base.dpr));

  // 5) Kernel: the config must actually override all three.
  const spoof = await probe(CFG);
  console.log("");
  console.log("  baseline: " + JSON.stringify(base));
  console.log("  spoofed : " + JSON.stringify(spoof));
  console.log("");
  ck("kernel: navigator_vendor overridden", spoof.vendor === "Apple Computer, Inc.", spoof.vendor);
  ck("kernel: navigator.language overridden", spoof.language === "en-US", spoof.language);
  ck("kernel: navigator.languages overridden", spoof.languages === "en-US,en", spoof.languages);
  ck("kernel: device_pixel_ratio overridden", spoof.dpr === 3, String(spoof.dpr));
  ck("kernel: navigator_platform still works", spoof.platform === "iPhone", spoof.platform);

  // 6) All three must differ from baseline - a hook that silently did nothing
  //    would leave them equal, which is the exact regression being guarded.
  ck("vendor differs from baseline", base.vendor !== spoof.vendor, base.vendor + " -> " + spoof.vendor);
  ck("language differs from baseline", base.language !== spoof.language, base.language + " -> " + spoof.language);
  ck("dpr differs from baseline", base.dpr !== spoof.dpr, base.dpr + " -> " + spoof.dpr);

  // 7) Empty config must NOT override (disabled means passthrough, not spoof).
  const empty = await probe(schema.fpDefaultConfig());
  ck("empty config leaves vendor native", empty.vendor === base.vendor, empty.vendor);
  ck("empty config leaves dpr native", empty.dpr === base.dpr, String(empty.dpr));

  console.log("");
  console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " of " + (pass + fail));
  app.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log("THREW " + e.message); app.exit(1); });
