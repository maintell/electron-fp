// Verify the navigator_platform kernel key works in the freshly built binary.
const { app, BrowserWindow, BrowserView } = require("electron");

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log("PASS  " + n + (d ? ": " + d : "")); pass++; }
  else { console.log("FAIL  " + n + (d ? ": " + d : "")); fail++; }
};

function openView(fp) {
  const v = new BrowserView({
    webPreferences: {
      partition: "plat-" + Math.random().toString(36).slice(2),
      sandbox: false,
      ...(fp ? { fingerprint: fp } : {})
    }
  });
  return v;
}

async function uaOf(view) {
  await view.webContents.loadURL("data:text/html,<b>x</b>");
  return view.webContents.executeJavaScript(
    "({platform: navigator.platform, ua: navigator.userAgent})");
}

(async () => {
  try {
    await app.whenReady();
    const win = new BrowserWindow({ show: false, width: 300, height: 200 });

    // 1. baseline: no config -> native platform
    const vn = openView(null);
    win.addBrowserView(vn);
    const native = await uaOf(vn);
    check("native platform is a non-empty baseline", !!native.platform,
      "platform=" + native.platform);

    // 2. platform override via the kernel key
    const v2 = openView({ navigator_platform: "MacIntel" });
    win.addBrowserView(v2);
    const r2 = await uaOf(v2);
    check("navigator_platform overrides platform",
      r2.platform === "MacIntel", "got " + r2.platform);
    check("override differs from native", r2.platform !== native.platform,
      native.platform + " -> " + r2.platform);

    // 3. a different value
    const v3 = openView({ navigator_platform: "Linux armv8l" });
    win.addBrowserView(v3);
    const r3 = await uaOf(v3);
    check("a second value also applies", r3.platform === "Linux armv8l",
      "got " + r3.platform);

    // 4. empty string = disabled -> native
    const v4 = openView({ navigator_platform: "" });
    win.addBrowserView(v4);
    const r4 = await uaOf(v4);
    check("empty navigator_platform falls back to native",
      r4.platform === native.platform, "got " + r4.platform);

    // 5. UA + platform together (the combination the feature exists for).
    // The UA MUST be set before the view is constructed — measured: setting it
    // on an already-open session does not reach existing views. The earlier
    // version of this test set it afterwards and failed for that reason, which
    // is correct behaviour, not a bug in the kernel key.
    const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
    const part5 = "plat-ua-" + Math.random().toString(36).slice(2);
    require("electron").session.fromPartition(part5).setUserAgent(MAC_UA);
    const v5 = new BrowserView({
      webPreferences: {
        partition: part5, sandbox: false,
        fingerprint: { navigator_platform: "MacIntel" }
      }
    });
    win.addBrowserView(v5);
    const r5 = await uaOf(v5);
    check("Mac UA and MacIntel platform agree",
      r5.ua.includes("Macintosh") && r5.platform === "MacIntel",
      "ua=" + r5.ua.slice(0, 34) + " platform=" + r5.platform);
    check("no Electron token in the UA", !r5.ua.includes("Electron/"));

    // 6. Every shipped preset must be internally consistent: a Mac UA with the
    // host's real "Win32" is exactly the contradiction this key exists to
    // remove, and profiles.json is edited by hand so it can drift.
    const fs = require("fs");
    const pathm = require("path");
    const schema = require("./fp-schema.js");
    const profiles = JSON.parse(fs.readFileSync(
      pathm.join(__dirname, "profiles.json"), "utf8")).profiles;
    let bad = [];
    for (const prof of profiles) {
      if (!prof.userAgent || !prof.fingerprint) continue;
      const want = schema.fpPlatformForUserAgent(prof.userAgent);
      if (prof.fingerprint.navigator_platform !== want) {
        bad.push(prof.id + " (want " + want + ", got " +
          JSON.stringify(prof.fingerprint.navigator_platform) + ")");
      }
    }
    check("every preset's platform matches its UA", bad.length === 0, bad.join("; "));

    // 7. The shipped macOS preset, applied for real, must not report Win32.
    const mac = profiles.find(p => p.id === "macos-safari");
    if (mac && mac.userAgent) {
      const part7 = "plat-mac-" + Math.random().toString(36).slice(2);
      require("electron").session.fromPartition(part7).setUserAgent(mac.userAgent);
      const v7 = new BrowserView({
        webPreferences: {
          partition: part7, sandbox: false, fingerprint: mac.fingerprint
        }
      });
      win.addBrowserView(v7);
      const r7 = await uaOf(v7);
      check("macos-safari preset reports MacIntel, not Win32",
        r7.platform === "MacIntel" && r7.platform !== native.platform,
        "platform=" + r7.platform);
    }

    console.log("");
    console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " checks");
    app.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.log("FAIL  threw: " + e.message);
    app.exit(1);
  }
})();
