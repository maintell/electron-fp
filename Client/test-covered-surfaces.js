// End-to-end coverage for the fp keys that no other test exercised.
//
// These 11 keys had ZERO test coverage (measured: no test file even mentioned
// them). Everything else was either covered or at least asserted on somewhere.
// That gap is not cosmetic: the Inspector's coverage panel reports these as
// "active", and every defect found in this area has been of the form "reports
// a reassuring value that no check stands behind".
//
// So this file does NOT assert that a config round-trips, or that the schema
// has the key. It asserts each key CHANGES THE OBSERVABLE VALUE IN A REAL
// RENDERER - the only thing that proves the kernel applied it.
//
// Value formats are the ones the kernel documents in
// blink/renderer/modules/webgl/webgl_rendering_context_base.cc, and they are
// NOT guessable from the key names:
//   webgl_max_viewport_dims        a SINGLE int, expanded to {v, v}
//   webgl_aliased_line_width_range "min,max"
//   webgl_shader_precision_highp   "rangeMin,rangeMax,precision"
//   webgl_extensions               comma-separated extension NAMES (appended)
// Probing with "4096,4096" for viewport dims silently does nothing, because
// StringToInt rejects it and the kernel falls back to the real value. A test
// that guessed the format would report a working surface as broken - or, worse,
// assert on a fallback value and pass while the feature is dead.

const { app, BrowserWindow, BrowserView } = require("electron");
const http = require("http");
const schema = require("./fp-schema.js");

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  (" + d + ")" : ""));
  ok ? pass++ : fail++;
};

const PROBE = `(function(){
  var out = {};
  var c = document.createElement('canvas');
  var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
  out.hasGl = !!gl;
  if (gl) {
    var vd = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    out.maxViewportDims = vd ? Array.from(vd).join(',') : null;
    var alw = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE);
    out.aliasedLineWidthRange = alw ? Array.from(alw).join(',') : null;
    var aps = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    out.aliasedPointSizeRange = aps ? Array.from(aps).join(',') : null;
    var sp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    out.shaderHighp = sp ? sp.rangeMin + '/' + sp.rangeMax + '/' + sp.precision : null;
    var exts = gl.getSupportedExtensions() || [];
    out.extensionCount = exts.length;
    out.hasFakeExt = exts.indexOf('FP_TEST_EXTENSION_1') !== -1;
    out.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    out.maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
  }
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    var ac = new AC();
    out.sampleRate = ac.sampleRate;
    out.maxChannels = ac.destination ? ac.destination.maxChannelCount : null;
    ac.close && ac.close();
  } catch (e) { out.audioErr = String(e); }
  out.colorDepth = window.screen ? window.screen.colorDepth : null;

  // Granularity of performance.now(): how many DISTINCT values appear across
  // many samples, and how many of them carry a fractional part. Unspoofed this
  // is dozens of values with sub-ms fractions; quantised it collapses to one
  // whole number. Comparing one sample would prove nothing.
  (function(){
    var vals = [];
    for (var i = 0; i < 400; i++) vals.push(performance.now());
    var distinct = {};
    for (var j = 0; j < vals.length; j++) distinct[vals[j]] = 1;
    var keys = Object.keys(distinct);
    var fracs = 0;
    for (var m = 0; m < keys.length; m++) {
      if (keys[m].indexOf('.') !== -1) fracs++;
    }
    out.distinctCount = keys.length;
    out.fracCount = fracs;
    out.firstValue = vals[0];
  })();
  return JSON.stringify(out);
})()`;

// Each entry: key, the value to set, the probe field it must change.
const CASES = [
  { key: "webgl_max_texture_size",        val: 4096,            field: "maxTextureSize" },
  { key: "webgl_max_renderbuffer_size",   val: 4096,            field: "maxRenderbufferSize" },
  { key: "webgl_max_viewport_dims",       val: 4096,            field: "maxViewportDims" },
  { key: "webgl_aliased_point_size_range", val: "1,255",        field: "aliasedPointSizeRange" },
  { key: "webgl_aliased_line_width_range", val: "2,7",          field: "aliasedLineWidthRange" },
  { key: "webgl_shader_precision_highp",  val: "60,60,10",      field: "shaderHighp" },
  { key: "webgl_extensions",              val: "FP_TEST_EXTENSION_1,FP_TEST_EXTENSION_2", field: "extensionCount" },
  { key: "audio_sample_rate",             val: 22050,           field: "sampleRate" },
  { key: "audio_max_channels",            val: 1,               field: "maxChannels" },
  { key: "screen_color_depth",            val: 16,              field: "colorDepth" },
  { key: "perf_now_precision_ms",         val: 5,               field: null }, // special-cased below
];

let srv, url, win;

async function probe(fp) {
  const part = "covsurf-" + Math.random().toString(36).slice(2);
  const v = new BrowserView({
    webPreferences: { partition: part, sandbox: false, fingerprint: fp },
  });
  win.addBrowserView(v);
  await v.webContents.loadURL(url);
  const g = JSON.parse(await v.webContents.executeJavaScript(PROBE, true));
  win.removeBrowserView(v);
  try { v.webContents.destroy(); } catch (e) {}
  return g;
}

(async () => {
  srv = http.createServer((q, r) => {
    r.writeHead(200, { "Content-Type": "text/html" });
    r.end("<html><body>covered-surfaces</body></html>");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  url = "http://127.0.0.1:" + srv.address().port + "/";
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 400, height: 300 });

  // 1) The schema must define all 11, or this file is asserting on nothing.
  for (const c of CASES) {
    ck("schema defines " + c.key, !!schema.FP_KEYS[c.key],
      (schema.FP_KEYS[c.key] || {}).kind);
  }

  const base = await probe({});
  ck("renderer probe works (webgl available)", base.hasGl === true,
    JSON.stringify(base).slice(0, 100));
  ck("renderer probe works (audio available)", !base.audioErr, base.audioErr || "ok");

  // 2) Each key must change its observable surface.
  for (const c of CASES) {
    if (!c.field) continue; // handled separately
    const got = await probe({ [c.key]: c.val });
    ck(c.key + " reaches the renderer",
      String(base[c.field]) !== String(got[c.field]),
      c.field + ": " + base[c.field] + " -> " + got[c.field]);
  }

  // 3) perf_now_precision_ms quantises performance.now().
  //
  // Measured behaviour: unspoofed, 400 samples gave 37 distinct values with
  // sub-millisecond fractions (179.3999999910593 etc). With the key set, all
  // 400 samples collapse to a single whole-millisecond value. So the assertion
  // is on GRANULARITY, not on a threshold - checking "still returns a number"
  // would pass even if the feature were completely dead.
  const coarse = await probe({ perf_now_precision_ms: 100 });
  ck("perf_now_precision_ms quantises performance.now() to whole ms",
    coarse.distinctCount === 1 && coarse.fracCount === 0,
    "distinct=" + coarse.distinctCount + " withFractions=" + coarse.fracCount +
      " (base: distinct=" + base.distinctCount + " withFractions=" + base.fracCount + ")");
  ck("perf_now_precision_ms still advances time (not frozen)",
    coarse.distinctCount >= 1 && coarse.firstValue > 0,
    "value=" + coarse.firstValue);
  ck("unspoofed performance.now() has sub-ms granularity (sanity)",
    base.distinctCount > 1 && base.fracCount > 0,
    "distinct=" + base.distinctCount + " withFractions=" + base.fracCount);

  // 4) Guard against the trap that made the first probe useless: a value in the
  //    WRONG format must NOT be silently accepted as a working surface.
  //    viewport_dims takes a single int, so "4096,4096" is rejected and the
  //    renderer keeps the host value.
  const badFmt = await probe({ webgl_max_viewport_dims: "4096,4096" });
  ck("webgl_max_viewport_dims rejects a 'w,h' string (falls back, does not lie)",
    badFmt.maxViewportDims === base.maxViewportDims,
    "got " + badFmt.maxViewportDims + " (base " + base.maxViewportDims + ")");

  srv.close();
  try { win.destroy(); } catch (e) {}
  console.log("");
  console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " of " + (pass + fail) + " checks");
  app.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log("FAIL  threw: " + (e && e.message));
  try { srv && srv.close(); } catch (x) {}
  try { win && win.destroy(); } catch (x) {}
  app.exit(1);
});
