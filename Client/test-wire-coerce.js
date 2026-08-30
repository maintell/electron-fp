// Verify kind:"str" keys still work when the caller supplies a JSON number.
//
// The kernel's FpConfigString() looks for the opening quote and returns "" if
// the next char is not one. So {net_downlink_mbps: 77} silently disables the
// key - no error, no log - while {net_downlink_mbps: "77"} works. Measured:
// the number form was ignored entirely (downlink stayed at the host's ~0.4).
//
// fpCoerce() in fp-schema.js fixes this at the single funnel every config
// passes through (fpNormalizeConfig). These checks guard it.
const { app, BrowserWindow, BrowserView } = require("electron");
const schema = require("./fp-schema.js");

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log("PASS  " + n + (d ? ": " + d : "")); pass++; }
  else { console.log("FAIL  " + n + (d ? ": " + d : "")); fail++; }
};

const PROBE = [
  "(function(){",
  "  var g={};",
  "  g.platform = navigator.platform;",
  "  g.doNotTrack = navigator.doNotTrack;",
  "  var c=document.createElement('canvas');",
  "  var gl=c.getContext('webgl');",
  "  if(gl){ var dbg=gl.getExtension('WEBGL_debug_renderer_info');",
  "    if(dbg){ g.glVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);",
  "             g.glRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL); } }",
  "  if(navigator.connection){ g.dl = navigator.connection.downlink; }",
  "  return g;",
  "})()"
].join("\n");

(async () => {
  try {
    await app.whenReady();
    const win = new BrowserWindow({ show: false, width: 300, height: 200 });

    // Go through fpNormalizeConfig: that is the real client path (main.js), so
    // bypassing it would test code the product never runs.
    async function run(rawFp) {
      const { config } = schema.fpNormalizeConfig(rawFp);
      const part = "wc-" + Math.random().toString(36).slice(2);
      const v = new BrowserView({
        webPreferences: { partition: part, sandbox: false, fingerprint: config }
      });
      win.addBrowserView(v);
      await v.webContents.loadURL("data:text/html,<b>x</b>");
      return v.webContents.executeJavaScript(PROBE);
    }

    // --- unit level: the coercion itself ---
    check("fpCoerce: str<-number", schema.fpCoerce("net_downlink_mbps", 77) === "77",
      JSON.stringify(schema.fpCoerce("net_downlink_mbps", 77)));
    check("fpCoerce: str<-string unchanged",
      schema.fpCoerce("tz_id", "Asia/Tokyo") === "Asia/Tokyo");
    check("fpCoerce: bool<-true", schema.fpCoerce("battery_charging", true) === "true");
    check("fpCoerce: bool<-false", schema.fpCoerce("battery_charging", false) === "false");
    check("fpCoerce: int stays a number", schema.fpCoerce("screen_width", 1440) === 1440,
      typeof schema.fpCoerce("screen_width", 1440));
    check("fpNormalizeConfig coerces str keys",
      schema.fpNormalizeConfig({ net_downlink_mbps: 77 }).config.net_downlink_mbps === "77",
      JSON.stringify(schema.fpNormalizeConfig({ net_downlink_mbps: 77 }).config.net_downlink_mbps));

    // --- live level: previously-dead keys now take effect ---
    // 77 is deliberately far from the host's real ~0.4 Mbps.
    const r1 = await run({ net_downlink_mbps: 77 });
    check("net_downlink_mbps as NUMBER", r1.dl === 77, String(r1.dl));

    const r1b = await run({ net_downlink_mbps: "42" });
    check("net_downlink_mbps as STRING (no regression)", r1b.dl === 42, String(r1b.dl));

    const r2 = await run({ navigator_platform: 12345 });
    check("navigator_platform as NUMBER", r2.platform === "12345", String(r2.platform));

    const r3 = await run({ webgl_vendor: 777, webgl_renderer: 888 });
    check("webgl_vendor as NUMBER", r3.glVendor === "777", String(r3.glVendor));
    check("webgl_renderer as NUMBER", r3.glRenderer === "888", String(r3.glRenderer));

    const r4 = await run({ do_not_track: 1 });
    check("do_not_track as NUMBER", r4.doNotTrack === "1", String(r4.doNotTrack));

    // --- geo_* are numeric by nature and therefore the highest-risk str keys ---
    const g = schema.fpNormalizeConfig({
      geo_latitude: 35.6, geo_longitude: 139.7, geo_accuracy: 10
    }).config;
    check("geo_* coerced to strings",
      g.geo_latitude === "35.6" && g.geo_longitude === "139.7" && g.geo_accuracy === "10",
      JSON.stringify([g.geo_latitude, g.geo_longitude, g.geo_accuracy]));

    console.log("");
    console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " checks");
    if (fail === 0) app.exit(0); else app.exit(1);
  } catch (e) {
    console.log("FAIL  threw: " + e.message);
    app.exit(1);
  }
})();
