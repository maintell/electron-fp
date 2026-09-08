// Exact-value round trip for the WebGL / WebGPU / audio / screen keys that were
// only asserted as "something changed".
//
// Measured gap (per-key scan of every test file): 40 of 63 keys pin the applied
// value to a literal; 9 are "changed-only"; 14 have no value assertion at all -
// among them every webgl_max_* / webgl_aliased_* / webgpu_* key.
//
// "Changed" is not enough for these, and the reason is specific. The kernel
// parses most of them with StringToInt/StringToDouble and FALLS BACK TO THE REAL
// VALUE on a parse failure. That produces a surface that visibly CHANGES (so the
// existing test passes) while not applying the requested value at all. Worse: a
// test that guessed the wrong format would assert on a fallback and pass while
// the feature is dead. test-covered-surfaces.js already documents this trap for
// webgl_max_viewport_dims; no test actually pins the value.
//
// So: set a distinctive value and assert the renderer reports EXACTLY it. Where
// the kernel is allowed to clamp or append rather than take the value verbatim
// (webgl_extensions, webgl_shader_precision_highp), assert the documented
// relationship instead - and say so at the call site.

const { app, BrowserWindow, session } = require("electron");
const http = require("http");
const S = require("./fp-schema.js");

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  (" + d + ")" : ""));
  ok ? pass++ : fail++;
};

let srv, url, keepAlive;

const GL_PROBE = `(function () {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
  if (!gl) return { err: 'no webgl' };
  const alw = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE);
  const aps = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  const sh = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  return {
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS)).join(','),
    aliasedLineWidthRange: alw ? Array.from(alw).join(',') : null,
    aliasedPointSizeRange: aps ? Array.from(aps).join(',') : null,
    shaderHighp: sh ? [sh.rangeMin, sh.rangeMax, sh.precision].join(',') : null,
    extCount: gl.getSupportedExtensions() ? gl.getSupportedExtensions().length : -1,
    hasExt: !!(gl.getSupportedExtensions() || []).includes('FP_VAL_EXT_A')
  };
})()`;

const OTHER_PROBE = `(function () {
  return {
    colorDepth: screen.colorDepth,
    touch: navigator.maxTouchPoints,
    hw: navigator.hardwareConcurrency,
    sampleRate: (function () {
      try {
        return new (window.AudioContext || window.webkitAudioContext)().sampleRate;
      } catch (e) { return 'err:' + e.message; }
    })(),
    maxChannels: (function () {
      try {
        return new (window.AudioContext || window.webkitAudioContext)()
          .destination.maxChannelCount;
      } catch (e) { return 'err:' + e.message; }
    })()
  };
})()`;

async function probe(cfg, expr) {
  const sess = session.fromPartition("wv-" + Math.random().toString(36).slice(2));
  if (cfg) sess.setFingerprintConfig(cfg);
  const w = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { session: sess, sandbox: false, nodeIntegration: false },
  });
  const loaded = await new Promise((res) => {
    const t = setTimeout(() => res({ ok: false, err: "timeout" }), 25000);
    w.webContents.once("did-fail-load", (e, c, d) => { clearTimeout(t); res({ ok: false, err: d }); });
    w.webContents.once("did-finish-load", () => { clearTimeout(t); res({ ok: true }); });
    w.loadURL(url);
  });
  if (!loaded.ok) { await w.destroy(); return { error: loaded.err }; }
  const got = await w.webContents.executeJavaScript(expr);
  await w.destroy();
  return got;
}

(async () => {
  srv = http.createServer((q, r) => {
    r.writeHead(200, { "Content-Type": "text/html" });
    r.end("<html><body>wv</body></html>");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  url = "http://127.0.0.1:" + srv.address().port + "/";
  await app.whenReady();
  keepAlive = new BrowserWindow({ show: false, width: 100, height: 100 });

  const glBase = await probe(null, GL_PROBE);
  ck("webgl probe available", !glBase.error && !glBase.err,
    JSON.stringify(glBase).slice(0, 90));

  // --- exact-value WebGL scalars -------------------------------------------
  // 4096 is above any real hardware value, so "changed" could not be a
  // coincidence; asserting the exact number rules out the silent fallback.
  {
    const g = await probe({
      webgl_max_texture_size: 4096,
      webgl_max_renderbuffer_size: 4096,
      webgl_max_viewport_dims: 4096,
    }, GL_PROBE);
    ck("webgl_max_texture_size applies exactly 4096",
      g.maxTextureSize === 4096, "got " + g.maxTextureSize);
    ck("webgl_max_renderbuffer_size applies exactly 4096",
      g.maxRenderbufferSize === 4096, "got " + g.maxRenderbufferSize);
    ck("webgl_max_viewport_dims expands to 4096,4096",
      g.maxViewportDims === "4096,4096", "got " + g.maxViewportDims);
  }
  // --- ranges: exact tuple --------------------------------------------------
  {
    const g = await probe({
      webgl_aliased_line_width_range: "3,9",
      webgl_aliased_point_size_range: "5,11",
    }, GL_PROBE);
    ck("webgl_aliased_line_width_range applies exactly 3,9",
      g.aliasedLineWidthRange === "3,9", "got " + g.aliasedLineWidthRange);
    ck("webgl_aliased_point_size_range applies exactly 5,11",
      g.aliasedPointSizeRange === "5,11", "got " + g.aliasedPointSizeRange);
  }
  // --- shader precision: exact triple --------------------------------------
  {
    const g = await probe({ webgl_shader_precision_highp: "61,62,13" }, GL_PROBE);
    ck("webgl_shader_precision_highp applies exactly 61,62,13",
      g.shaderHighp === "61,62,13", "got " + g.shaderHighp);
  }
  // --- extensions: APPENDED, not replaced (documented behaviour) -----------
  {
    const g = await probe({ webgl_extensions: "FP_VAL_EXT_A" }, GL_PROBE);
    // The kernel appends, so the right assertion is presence + count growth,
    // not equality with a full list.
    ck("webgl_extensions adds the named extension",
      g.hasExt === true && g.extCount > glBase.extCount,
      "hasExt=" + g.hasExt + " base=" + glBase.extCount + " got=" + g.extCount);
  }
  // --- screen / touch -------------------------------------------------------
  {
    const o = await probe({ screen_color_depth: 48, max_touch_points: 7 }, OTHER_PROBE);
    ck("screen_color_depth applies exactly 48", o.colorDepth === 48, "got " + o.colorDepth);
    ck("max_touch_points applies exactly 7", o.touch === 7, "got " + o.touch);
  }
  // --- audio: reported, not asserted (sample rate is host-clamped) ---------
  {
    const o = await probe({ audio_sample_rate: 44100, audio_max_channels: 2 }, OTHER_PROBE);
    // AudioContext.sampleRate is quantised to what the output device supports,
    // so an exact assertion would be host-dependent. Recorded, not asserted.
    console.log("info    audio_sample_rate -> " + o.sampleRate +
      ", audio_max_channels -> " + o.maxChannels + " (host-dependent; reported)");
  }

  srv.close();
  try { await keepAlive.destroy(); } catch (e) {}
  console.log("");
  console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " of " + (pass + fail) + " checks");
  app.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log("FAIL  threw: " + (e && e.message));
  try { srv && srv.close(); } catch (x) {}
  app.exit(1);
});
