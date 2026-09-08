// Verify two-way sync between grouped fields and the JSON textarea.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const schema = require("./fp-schema.js");

ipcMain.handle("fp:schema", () => ({ version: schema.FP_SCHEMA_VERSION, keyCount: schema.FP_KEY_NAMES.length,
  keys: schema.FP_KEYS, groups: schema.FP_GROUPS, defaults: schema.fpDefaultConfig() }));
ipcMain.handle("app:versions", () => ({ electron: "0", chrome: "0", node: "0", v8: "0" }));
ipcMain.handle("tab:list", () => []);
ipcMain.handle("tab:get-active", () => null);
ipcMain.handle("tab:get-fingerprint", () => null);
ipcMain.handle("profile:list", () => []);
ipcMain.handle("panel:set-open", () => true);

// Mirror of main.js's UA handlers (see the note in test-ui-groups.js): app.js
// init() calls these on boot, and this probe mirrors main.js rather than
// requiring it, so new channels must be added in both places.
ipcMain.handle("ua:presets", () => schema.FP_UA_PRESETS);
ipcMain.handle("ua:platform-for", (e, ua) => schema.fpPlatformForUserAgent(ua));
ipcMain.handle("tab:get-ua", () => "");
ipcMain.handle("tab:set-ua", () => true);
// The UA apply path now also pushes the kernel config (so navigator_platform
// travels with the UA), which calls this.
ipcMain.handle("tab:set-fingerprint", () => true);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  const errs = [];
  win.webContents.on("console-message", (e, l, m) => { if (l >= 2) errs.push(m); });
  await win.loadFile(path.join(__dirname, "renderer", "index.html"));
  await new Promise(r => setTimeout(r, 1000));

  const out = await win.webContents.executeJavaScript(`(async () => {
    const ta = document.getElementById("fp-json-editor");
    const res = {};

    // --- A) JSON -> fields: set JSON, re-render, read a field back
    ta.value = JSON.stringify({ hardware_concurrency: 16, tz_id: "Asia/Tokyo", webgl_vendor: "Apple" }, null, 2);
    await window.__renderFpGroupsForTest();
    const get = k => document.querySelector('input[data-key="' + k + '"]');
    res.hwField = get("hardware_concurrency").value;
    res.tzField = get("tz_id").value;
    res.gpuField = get("webgl_vendor").value;
    res.hwActive = get("hardware_concurrency").classList.contains("active");
    res.unsetActive = get("device_memory").classList.contains("active");
    res.summaryAfterJson = document.getElementById("fp-groups-summary").textContent.trim();

    // --- B) unknown key surfaces as "ignored by kernel"
    ta.value = JSON.stringify({ hardware_concurrency: 8, totally_bogus: 1 });
    await window.__renderFpGroupsForTest();
    res.bogusWarning = document.getElementById("fp-groups-summary").textContent.includes("totally_bogus");

    // --- C) field -> JSON: edit a field, verify textarea updated
    ta.value = "{}";
    await window.__renderFpGroupsForTest();
    const inp = get("screen_width");
    inp.value = "2560";
    inp.dispatchEvent(new Event("change"));
    await new Promise(r => setTimeout(r, 100));
    res.jsonAfterEdit = JSON.parse(document.getElementById("fp-json-editor").value).screen_width;

    // --- D) clearing a numeric field removes the key
    const inp2 = get("screen_width");
    inp2.value = "";
    inp2.dispatchEvent(new Event("change"));
    await new Promise(r => setTimeout(r, 100));
    res.keyRemovedOnClear = !("screen_width" in JSON.parse(document.getElementById("fp-json-editor").value));

    // --- E) collapse toggle
    const head = document.querySelectorAll(".fp-group-head")[0];
    const label = head.textContent;
    head.click();
    await new Promise(r => setTimeout(r, 100));
    const head2 = document.querySelectorAll(".fp-group-head")[0];
    res.collapseToggled = head2.textContent !== label;

    // --- F) UA box -> navigator_platform sync.
    // The two are separate surfaces with nothing enforcing agreement, so the
    // panel must keep them in step. A Mac UA left beside the host's real
    // "Win32" is the exact contradiction navigator_platform exists to remove.
    const uaInput = document.getElementById("fp-ua-input");
    const jsonOf = () => JSON.parse(document.getElementById("fp-json-editor").value);
    // The UA handlers guard on currentTabId, which is null in this harness since
    // it has no real tabs. Set it rather than weakening the production guard.
    window.__setCurrentTabForTest("tab-sync");

    ta.value = "{}";
    await window.__renderFpGroupsForTest();
    uaInput.value = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
    document.getElementById("fp-ua-apply").click();
    await new Promise(r => setTimeout(r, 400));
    res.platformAfterMacUa = jsonOf().navigator_platform;

    uaInput.value = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    document.getElementById("fp-ua-apply").click();
    await new Promise(r => setTimeout(r, 400));
    res.platformAfterWinUa = jsonOf().navigator_platform;

    // Reset must not leave a stale MacIntel override behind.
    document.getElementById("fp-ua-reset").click();
    await new Promise(r => setTimeout(r, 400));
    res.platformAfterReset = jsonOf().navigator_platform;

    return res;
  })()`, true);

  let pass = 0, fail = 0;
  const ck = (n, c, d) => { if (c) { console.log("PASS  " + n + (d !== undefined ? ": " + d : "")); pass++; } else { console.log("FAIL  " + n + (d !== undefined ? ": " + d : "")); fail++; } };

  ck("JSON -> field (int)", out.hwField === "16", out.hwField);
  ck("JSON -> field (str)", out.tzField === "Asia/Tokyo", out.tzField);
  ck("JSON -> field (gpu)", out.gpuField === "Apple", out.gpuField);
  ck("active key highlighted", out.hwActive === true);
  ck("unset key not highlighted", out.unsetActive === false);
  // Derived from the schema, not hardcoded: adding a kernel key (56 -> 57 when
  // navigator_platform landed) silently broke this until it was made dynamic.
  ck("coverage summary updates",
    new RegExp("3/" + schema.FP_KEY_NAMES.length).test(out.summaryAfterJson),
    out.summaryAfterJson);
  ck("unknown key surfaced", out.bogusWarning === true);
  ck("field -> JSON (int)", out.jsonAfterEdit === 2560, out.jsonAfterEdit);
  ck("clear removes key", out.keyRemovedOnClear === true);
  ck("group collapse toggles", out.collapseToggled === true);
  ck("Mac UA sets navigator_platform to MacIntel",
    out.platformAfterMacUa === "MacIntel", out.platformAfterMacUa);
  ck("switching to a Windows UA updates platform to Win32",
    out.platformAfterWinUa === "Win32", out.platformAfterWinUa);
  ck("resetting the UA clears navigator_platform",
    out.platformAfterReset === undefined, JSON.stringify(out.platformAfterReset));
  ck("no console errors", errs.length === 0, errs.join(" ;; "));

  console.log(fail === 0 ? "\nPASS: two-way JSON <-> group field sync works" : "\nFAIL: " + fail);
  win.close();
  app.exit(fail === 0 ? 0 : 1);
});
setTimeout(() => { console.error("timeout"); app.exit(2); }, 25000);
