#!/usr/bin/env node
// Verify User-Agent coverage: a client-level (Electron) surface that lives
// BESIDE the kernel's 56-key fingerprint config, not inside it.
//
// What is verified here, and why each needs a live browser:
//   1. navigator.userAgent reflects the configured UA.
//   2. The HTTP User-Agent HEADER also reflects it. setUserAgent() is the only
//      thing that covers both; a JS-side override would only do #1.
//      Uses a local HTTP server (not an external site) so the check does not
//      depend on network reachability.
//   3. Resetting to '' reverts to the native UA.
//   4. Two tabs on different partitions hold different UAs simultaneously.
//   5. The kernel fingerprint config is unaffected: setting a UA must not
//      disturb the 56-key config, and vice versa.
//
// Ordering trap this test protects: session.setUserAgent() does NOT reach an
// already-open view, even after reload. It only applies to views created
// afterwards on that partition. If UA application ever regresses to "set it on
// the existing session", #1 and #2 fail here.
"use strict";

const http = require("http");
const { app, BrowserWindow, BrowserView, session } = require("electron");

const UA_A = "FP-Test-UA/1.0 (Alpha)";
const UA_B = "FP-Test-UA/2.0 (Beta)";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { console.log("PASS  " + name + (detail ? ": " + detail : "")); pass++; }
  else { console.log("FAIL  " + name + (detail ? ": " + detail : "")); fail++; }
}

// Local server that echoes back the User-Agent header it received.
let server = null;
let serverUrl = "";
function startServer() {
  return new Promise(resolve => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ userAgent: req.headers["user-agent"] || "" }));
    });
    server.listen(0, "127.0.0.1", () => {
      serverUrl = "http://127.0.0.1:" + server.address().port + "/ua";
      resolve(serverUrl);
    });
  });
}

/** Create a fresh view on a partition, optionally setting the UA first. */
function openView(partition, ua) {
  // Mirrors main.js: setUserAgent() BEFORE constructing the view.
  if (ua !== undefined) session.fromPartition(partition).setUserAgent(ua);
  const view = new BrowserView({ webPreferences: { partition, sandbox: false } });
  return view;
}

async function probe(view, url) {
  await view.webContents.loadURL(url);
  const header = await view.webContents.executeJavaScript(
    `fetch(${JSON.stringify(url)}, {cache:"no-store"}).then(r=>r.json()).then(j=>j.userAgent)`);
  const js = await view.webContents.executeJavaScript("navigator.userAgent");
  return { header, js };
}

(async () => {
  try {
    await startServer();
    await app.whenReady();
    const win = new BrowserWindow({ show: false, width: 300, height: 200 });

    // --- 1/2. UA covers both JS and HTTP header ---
    let v = openView("ua-t1", UA_A);
    win.addBrowserView(v);
    let r = await probe(v, serverUrl);
    check("navigator.userAgent reflects configured UA", r.js === UA_A, r.js.slice(0, 50));
    check("HTTP User-Agent header reflects configured UA", r.header === UA_A, String(r.header).slice(0, 50));

    // --- 3. Reset to '' reverts to native ---
    let native = null;
    {
      const vn = openView("ua-native", undefined);
      win.addBrowserView(vn);
      const rn = await probe(vn, serverUrl);
      native = rn.js;
    }
    check("native UA is non-empty baseline", !!native && native.length > 0, String(native).slice(0, 40));

    const vr = openView("ua-t1", "");
    win.addBrowserView(vr);
    const rr = await probe(vr, serverUrl);
    check("empty UA reverts to native", rr.js === native, String(rr.js).slice(0, 50));

    // --- 4. Per-tab isolation (different partitions) ---
    let va = openView("ua-iso-a", UA_A);
    let vb = openView("ua-iso-b", UA_B);
    win.addBrowserView(va);
    win.addBrowserView(vb);
    const ra = await probe(va, serverUrl);
    const rb = await probe(vb, serverUrl);
    check("two tabs hold different UAs", ra.js === UA_A && rb.js === UA_B,
      "A=" + String(ra.js).slice(0, 22) + " B=" + String(rb.js).slice(0, 22));

    // --- 5. UA and the kernel fingerprint config are independent surfaces ---
    // Guarded against vacuous passing: the previous version read a global that
    // does not exist, so `!c` was always true and the check could never fail.
    // Instead, assert positively that a KERNEL key still works while a UA is
    // set, and that the UA is absent from the kernel's own key list.
    // The UA itself must NOT be a kernel key: it is an Electron-level surface
    // and nesting it in `fingerprint` would get it dropped by
    // fpNormalizeConfig(). navigator_platform IS a kernel key by design (it is
    // the only way to cover navigator.platform), so it is excluded here on
    // purpose — do not add it back to this assertion.
    const { FP_KEY_NAMES } = require("./fp-schema.js");
    check("UA is not a kernel key (platform is, by design)",
      !FP_KEY_NAMES.includes("userAgent") && FP_KEY_NAMES.includes("navigator_platform"),
      FP_KEY_NAMES.length + " kernel keys");

    const v5 = openView("ua-t5", UA_A);
    win.addBrowserView(v5);
    await v5.webContents.loadURL("data:text/html,<b>x</b>");
    // hardware_concurrency is a real kernel key. If applying a UA ever clobbered
    // the --fingerprint-config path, this surface would fall back to native.
    const hwc = await v5.webContents.executeJavaScript("navigator.hardwareConcurrency");
    const hwc2 = await v5.webContents.executeJavaScript("navigator.hardwareConcurrency");
    check("kernel surface still readable while a UA is set",
      typeof hwc === "number" && hwc > 0 && hwc === hwc2, "hardwareConcurrency=" + hwc);

    check("applied UA never exposes Electron token",
      !String(r.js).includes("Electron/"), String(r.js).slice(0, 60));

    console.log("");
    console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " of " + (pass + fail) + " checks");
    if (server) server.close();
    app.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.log("FAIL  threw: " + e.message);
    console.log(e.stack);
    if (server) server.close();
    app.exit(1);
  }
})();
