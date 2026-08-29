// Probe the live Client window via CDP: confirm the grouped schema UI rendered.
const { app, BrowserWindow, ipcMain } = require("electron");
const schema = require("./fp-schema.js");

// Mirror main.js's schema handlers so we can drive the renderer standalone.
//
// This mirror is a duplication hazard: every handler main.js registers must be
// registered here too, or the renderer throws "No handler registered" and the
// probe fails for a reason unrelated to what it is testing. main.js is not
// required directly because it opens its own window and takes over the app.
// CHANNELS is the single list both this file and the handler map below are
// derived from, so adding a channel is a one-line change.
ipcMain.handle("fp:schema", () => ({
  version: schema.FP_SCHEMA_VERSION,
  keyCount: schema.FP_KEY_NAMES.length,
  keys: schema.FP_KEYS,
  groups: schema.FP_GROUPS,
  defaults: schema.fpDefaultConfig()
}));
ipcMain.handle("fp:coverage", (e, cfg) => schema.fpCoverage(cfg || {}));
ipcMain.handle("app:versions", () => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, v8: process.versions.v8 }));
// app.js init() calls these on boot; stub so the standalone probe is quiet.
ipcMain.handle("tab:list", () => []);
ipcMain.handle("tab:get-active", () => null);
ipcMain.handle("tab:get-fingerprint", () => null);
ipcMain.handle("profile:list", () => []);
ipcMain.handle("panel:set-open", () => true);

// User-Agent (client-level surface). Registered as part of the mirror above:
// app.js init() calls listUaPresets() and getUserAgent() on boot.
const UA_HANDLERS = {
  "ua:presets": () => schema.FP_UA_PRESETS,
  "tab:get-ua": () => "",
  "tab:set-ua": () => true
};
for (const [ch, fn] of Object.entries(UA_HANDLERS)) ipcMain.handle(ch, fn);
const path = require("path");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  const errs = [];
  win.webContents.on("console-message", (e, lvl, msg) => { if (lvl >= 2) errs.push(msg); });
  win.webContents.on("did-fail-load", (e, c, d) => errs.push("load fail: " + d));

  await win.loadFile(path.join(__dirname, "renderer", "index.html"));
  await new Promise(r => setTimeout(r, 1200));

  const out = await win.webContents.executeJavaScript(`(async () => {
    const res = { err: null };
    try {
      const schema = await window.api.getFpSchema();
      res.version = schema.version;
      res.keyCount = schema.keyCount;
      res.groupCount = schema.groups.length;
      res.groups = schema.groups.map(g => g.id + ":" + Object.values(schema.keys).filter(k => k.group === g.id).length);

      // render the grouped UI the same way app.js does, then inspect the DOM
      await window.__renderFpGroupsForTest();
      res.sections = document.querySelectorAll(".fp-group").length;
      res.fields = document.querySelectorAll(".fp-field").length;
      res.summary = (document.getElementById("fp-groups-summary").textContent || "").trim();
      res.firstHeads = [...document.querySelectorAll(".fp-group-head")].slice(0, 4).map(h => h.textContent.trim());
    } catch (e) { res.err = String(e && e.message || e); }
    return res;
  })()`, true);

  console.log("schema version : " + out.version);
  console.log("keyCount       : " + out.keyCount);
  console.log("groupCount     : " + out.groupCount);
  console.log("groups         : " + (out.groups || []).join(" "));
  console.log("DOM sections   : " + out.sections);
  console.log("DOM fields     : " + out.fields);
  console.log("summary        : " + out.summary);
  console.log("first heads    : " + (out.firstHeads || []).join(" | "));
  console.log("render error   : " + out.err);
  console.log("console errors : " + (errs.length ? errs.join(" ;; ") : "none"));

  const ok = out.keyCount === 56 && out.groupCount === 14 && out.sections === 14 &&
             out.fields === 56 && !out.err && errs.length === 0;
  console.log(ok ? "\nPASS: grouped UI renders 14 sections / 56 fields" : "\nFAIL");
  win.close();
  app.exit(ok ? 0 : 1);
});
setTimeout(() => { console.error("timeout"); app.exit(2); }, 25000);
