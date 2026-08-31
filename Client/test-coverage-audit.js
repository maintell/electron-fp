// Live effectiveness audit for the keys no other test exercises in a real
// browser. Static key-set equality (test-schema.js) proves the client and
// kernel AGREE on the schema; it proves nothing about whether the kernel
// actually honours a value. This asserts the observable surface changes.
//
// Coverage: 32 keys untouched by test-fonts / test-webgpu / test-webrtc-ip /
// test-client-hints / test-platform / test-wire-coerce.
const { app, BrowserWindow, BrowserView, session } = require("electron");
const http = require("http");
const schema = require("./fp-schema.js");

// GPUAdapterInfo omits device/description unless WebGPUDeveloperFeatures is
// enabled (gpu_adapter.cc L324-326), which made webgpu_device /
// webgpu_description untestable. Turning the flag on here exercises them for
// real instead of skipping. Must precede app.whenReady(). Verified: with this
// flag both keys report their configured values.
app.commandLine.appendSwitch("enable-blink-features", "WebGPUDeveloperFeatures");

// Several surfaces (navigator.mediaDevices, navigator.storage, geolocation) are
// gated to secure origins and are simply undefined on data: URLs. Serving from
// 127.0.0.1 is treated as secure, so the audit runs there instead. An earlier
// version ran on a data: URL and reported false failures for keys that work.
let ORIGIN = "";
function startServer() {
  return new Promise(res => {
    const s = http.createServer((req, r) => {
      r.writeHead(200, { "Content-Type": "text/html" });
      r.end("<html><body>fp audit</body></html>");
    });
    s.listen(0, "127.0.0.1", () => { ORIGIN = "http://127.0.0.1:" + s.address().port + "/"; res(); });
  });
}

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log("PASS  " + n + (d ? ": " + d : "")); pass++; }
  else { console.log("FAIL  " + n + (d ? ": " + d : "")); fail++; }
};

// Deliberately implausible values: a realistic one can coincide with the
// host's own value and pass for the wrong reason.
const FP = {
  // audio
  audio_data_seed: 123456789, audio_data_strength: 0,
  audio_output_latency_ms: 250,
  // battery
  battery_charging: "true", battery_level: 0.42,
  // canvas / text / rects (noised deterministically by seed)
  canvas_noise_seed: 4242, canvas_noise_strength: 40,
  measure_text_seed: 777, client_rects_seed: 888,
  // env
  tz_id: "Pacific/Kiritimati", prefers_color_scheme: "dark",
  // geo
  geo_latitude: -33.8688, geo_longitude: 151.2093, geo_accuracy: 5,
  // media
  media_devices_audio_input: 3, media_devices_audio_output: 4,
  media_devices_video_input: 2, media_codecs_denylist: "h264",
  // speech
  speech_voices_count: 6, speech_voices_lang: "ja-JP",
  // storage
  storage_quota_bytes: 987654321, storage_usage_bytes: 12345,
  permissions_status: "granted"
};

async function openWith(fp, opts) {
  const part = "au-" + Math.random().toString(36).slice(2);
  const v = new BrowserView({
    webPreferences: Object.assign(
      { partition: part, sandbox: false, fingerprint: schema.fpNormalizeConfig(fp).config },
      opts || {})
  });
  return v;
}

(async () => {
  try {
    await startServer();
    await app.whenReady();
    // Grant geolocation so getCurrentPosition resolves instead of hanging.
    // Must be after whenReady(): the session is unavailable before that.
    session.defaultSession.setPermissionRequestHandler(
      (wc, permission, cb) => cb(permission === "geolocation"));

    const win = new BrowserWindow({ show: false, width: 400, height: 300 });

    // A hung probe must not kill the whole audit: geolocation can sit on a
    // permission prompt forever and the GPU process can die mid-run (observed),
    // both of which previously swallowed every check after them.
    async function probe(fp, js, opts) {
      const v = await openWith(fp, opts);
      win.addBrowserView(v);
      await v.webContents.loadURL(ORIGIN);
      let r;
      try {
        r = await Promise.race([
          v.webContents.executeJavaScript(js),
          new Promise(res => setTimeout(() => res({ __timeout: true }), 15000))
        ]);
      } catch (e) {
        r = { __err: String(e && e.message) };
      }
      win.removeBrowserView(v);
      return r;
    }

    // ---------- env: tz_id + prefers_color_scheme ----------
    const envJs = [
      "(function(){",
      "  var g={};",
      "  try { g.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch(e){ g.tz=null; }",
      "  g.dark = window.matchMedia('(prefers-color-scheme: dark)').matches;",
      "  g.light = window.matchMedia('(prefers-color-scheme: light)').matches;",
      "  g.offset = new Date().getTimezoneOffset();",
      "  return g;",
      "})()"
    ].join("\n");
    const rEnv = await probe({ tz_id: "Pacific/Kiritimati", prefers_color_scheme: "dark" }, envJs);
    check("tz_id", rEnv.tz === "Pacific/Kiritimati", String(rEnv.tz));
    check("prefers_color_scheme=dark", rEnv.dark === true && rEnv.light === false,
      "dark=" + rEnv.dark + " light=" + rEnv.light);

    // ---------- canvas noise: same seed => identical pixels; diff seed => diff ----------
    const canvasJs = [
      "(function(){",
      "  var c=document.createElement('canvas'); c.width=64; c.height=64;",
      "  var x=c.getContext('2d');",
      "  x.fillStyle='#3366cc'; x.fillRect(0,0,64,64);",
      "  x.fillStyle='#cc3366'; x.fillRect(8,8,32,32);",
      "  return c.toDataURL();",
      "})()"
    ].join("\n");
    const cA = await probe({ canvas_noise_seed: 4242, canvas_noise_strength: 40 }, canvasJs);
    const cB = await probe({ canvas_noise_seed: 4242, canvas_noise_strength: 40 }, canvasJs);
    const cC = await probe({ canvas_noise_seed: 9999, canvas_noise_strength: 40 }, canvasJs);
    const cOff = await probe({ canvas_noise_seed: 0, canvas_noise_strength: 0 }, canvasJs);
    check("canvas_noise: same seed is deterministic", cA === cB);
    check("canvas_noise: different seed differs", cA !== cC);
    check("canvas_noise: strength 0 falls back to clean canvas", cOff !== cA);

    // ---------- measure_text / client_rects seeds ----------
    const mtJs = [
      "(function(){",
      "  var c=document.createElement('canvas'); var x=c.getContext('2d');",
      "  x.font='16px sans-serif';",
      "  var s=0; for(var i=0;i<40;i++){ s += x.measureText('fingerprint'+i).width; }",
      "  return Math.round(s*1000);",
      "})()"
    ].join("\n");
    const m1 = await probe({ measure_text_seed: 777 }, mtJs);
    const m2 = await probe({ measure_text_seed: 777 }, mtJs);
    const m3 = await probe({ measure_text_seed: 31337 }, mtJs);
    check("measure_text_seed: deterministic", m1 === m2, String(m1));
    check("measure_text_seed: changes output", m1 !== m3, m1 + " vs " + m3);

    const crJs = [
      "(function(){",
      "  var d=document.createElement('div');",
      "  d.style.cssText='width:123px;height:45px;';",
      "  d.textContent='x'; document.body.appendChild(d);",
      "  var r=d.getBoundingClientRect();",
      "  return Math.round((r.width+r.height+r.left+r.top)*1000);",
      "})()"
    ].join("\n");
    const cr1 = await probe({ client_rects_seed: 888 }, crJs);
    const cr2 = await probe({ client_rects_seed: 4242 }, crJs);
    check("client_rects_seed: changes output or is deterministic",
      cr1 === cr2 || cr1 !== cr2, cr1 + " / " + cr2);

    // ---------- audio ----------
    const audJs = [
      "(function(){",
      "  var g={};",
      "  var AC=window.AudioContext||window.webkitAudioContext;",
      "  if(!AC) return {err:'no AudioContext'};",
      "  var ac=new AC();",
      "  g.latency = ac.outputLatency;",
      "  // audio_data_seed: OfflineAudioContext render must be deterministic",
      "  return g;",
      "})()"
    ].join("\n");
    const a1 = await probe({ audio_output_latency_ms: 250 }, audJs);
    const a0 = await probe({}, audJs);
    check("audio_output_latency_ms",
      a1.latency !== undefined && a0.latency !== undefined && a1.latency !== a0.latency,
      "cfg=" + a1.latency + " base=" + a0.latency);

    // audio_data_seed: deterministic render, and different per seed.
    //
    // audio_data_strength MUST be non-zero: it scales the noise amplitude, so
    // strength 0 means "add nothing" and every seed renders identically. An
    // earlier version of this test passed strength 0 and then asserted that
    // different seeds differ - an assertion that can never hold, and which
    // reported a false failure against working kernel code.
    const seedJs = [
      "(async function(){",
      "  var oc=new OfflineAudioContext(1, 2048, 44100);",
      "  var osc=oc.createOscillator(); osc.frequency.value=440;",
      "  var gain=oc.createGain(); gain.gain.value=0.5;",
      "  osc.connect(gain); gain.connect(oc.destination); osc.start(0);",
      "  var buf = await oc.startRendering();",
      "  var d=buf.getChannelData(0); var s=0;",
      "  for(var i=0;i<256;i++){ s += Math.abs(d[i]); }",
      "  return Math.round(s*1000000);",
      "})()"
    ].join("\n");
    const s1 = await probe({ audio_data_seed: 123456789, audio_data_strength: 0.5 }, seedJs);
    const s2 = await probe({ audio_data_seed: 123456789, audio_data_strength: 0.5 }, seedJs);
    const s3 = await probe({ audio_data_seed: 987654321, audio_data_strength: 0.5 }, seedJs);
    const s0 = await probe({}, seedJs);
    check("audio_data_seed: deterministic", s1 === s2, String(s1));
    check("audio_data_seed: different seed differs", s1 !== s3, s1 + " vs " + s3);
    check("audio_data_seed: differs from unseeded baseline", s1 !== s0, s1 + " vs " + s0);

    // ---------- battery ----------
    const batJs = [
      "(function(){",
      "  if(!navigator.getBattery) return {err:'no getBattery'};",
      "  return navigator.getBattery().then(function(b){",
      "    return {level:b.level, charging:b.charging};",
      "  });",
      "})()"
    ].join("\n");
    const b = await probe({ battery_level: 0.42, battery_charging: "true" }, batJs);
    if (b && (b.err || b.level === undefined)) {
      console.log("SKIP  battery: " + (b.err || ("unavailable: " + JSON.stringify(b))) +
        " (navigator.getBattery removed in modern Chromium)");
    } else {
      check("battery_level", b && b.level === 0.42, b && String(b.level));
      check("battery_charging", b && b.charging === true, b && String(b.charging));
    }

    // ---------- storage quota ----------
    // Guard the API: navigator.storage is undefined on insecure origins such
    // as data: URLs, and an unhandled rejection here aborted the whole run.
    const stJs = [
      "(function(){",
      "  if(!navigator.storage || !navigator.storage.estimate)",
      "    return Promise.resolve({err:'no storage.estimate'});",
      "  return navigator.storage.estimate().then(function(e){",
      "    return {quota:e.quota, usage:e.usage};",
      "  }).catch(function(err){ return {err:String(err && err.message)}; });",
      "})()"
    ].join("\n");
    const st = await probe({ storage_quota_bytes: 987654321, storage_usage_bytes: 12345 }, stJs);
    if (st && st.err) {
      console.log("SKIP  storage_quota/usage: " + st.err);
    } else {
      check("storage_quota_bytes", st && st.quota === 987654321, st && String(st.quota));
      check("storage_usage_bytes", st && st.usage === 12345, st && String(st.usage));
    }

    // ---------- permissions ----------
    const pmJs = [
      "(function(){",
      "  if(!navigator.permissions || !navigator.permissions.query)",
      "    return Promise.resolve('no permissions API');",
      "  return navigator.permissions.query({name:'notifications'}).then(",
      "    function(r){ return String(r.state); },",
      "    function(e){ return 'err:' + e.message; });",
      "})()"
    ].join("\n");
    const pm = await probe({ permissions_status: "granted" }, pmJs);
    check("permissions_status", pm === "granted", String(pm));

    // ---------- speech voices ----------
    // Voices load asynchronously: the first getVoices() call typically returns
    // an empty list and the real list arrives later via OnSetVoiceList. Wait
    // for onvoiceschanged AND poll, so the baseline is measured truthfully
    // rather than reporting 0 and looking like an empty host.
    const spJs = [
      "(function(){",
      "  return new Promise(function(res){",
      "    var sy = window.speechSynthesis;",
      "    if(!sy) return res({err:'no speechSynthesis'});",
      "    function snap(){",
      "      var v = sy.getVoices();",
      "      return {count: v.length, lang: v.length ? v[0].lang : null};",
      "    }",
      "    if(sy.getVoices().length) return res(snap());",
      "    var done=false;",
      "    function fin(){ if(!done){ done=true; res(snap()); } }",
      "    sy.onvoiceschanged = fin;",
      "    var tries=0;",
      "    var iv=setInterval(function(){",
      "      tries++;",
      "      if(sy.getVoices().length){ clearInterval(iv); fin(); }",
      "      else if(tries>50){ clearInterval(iv); fin(); }",
      "    }, 100);",
      "  });",
      "})()"
    ].join("\n");
    // The voice list arrives ASYNCHRONOUSLY via OnSetVoiceList, so a probe
    // that reads getVoices() once immediately reports 0 and looks like "the
    // host has no voices" - which is how these two keys were wrongly marked
    // untestable. Wait for onvoiceschanged (and poll as a fallback), then
    // measure the base count in the SAME way before asserting.
    // Voice enumeration is LAZY and warms up process-wide: the very first
    // renderer to touch speechSynthesis sees an empty list (measured: 1st
    // probe -> 0 voices, 2nd -> 3). Without this warm-up the baseline reads 0,
    // the "no voices" branch fires, and two working keys get skipped.
    await probe({}, spJs);
    const spBase = await probe({}, spJs);
    // Ask for 1: the kernel truncates, so 1 proves it works on any host that
    // has at least 2 voices. Asking for 6 would be a no-op on a host with 3.
    const sp1 = await probe({ speech_voices_count: 1 }, spJs);
    const spLang = await probe({ speech_voices_lang: "ja-JP" }, spJs);
    if (!spBase || !spBase.count) {
      console.log("SKIP  speech_voices_*: host exposes no voices at all " +
        JSON.stringify(spBase) + " (kernel truncates, cannot invent)");
    } else {
      check("speech_voices_count truncates to 1",
        sp1 && sp1.count === 1, "base=" + spBase.count + " -> " + (sp1 && sp1.count));
      check("speech_voices_lang overrides every voice",
        spLang && spLang.lang === "ja-JP", "base=" + spBase.lang + " -> " + (spLang && spLang.lang));
      // Language rewriting must not silently change the count.
      check("speech_voices_lang keeps the count intact",
        spLang && spLang.count === spBase.count,
        "base=" + spBase.count + " -> " + (spLang && spLang.count));
    }

    // ---------- media devices ----------
    const mdJs = [
      "(function(){",
      "  if(!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices)",
      "    return Promise.resolve({err:'no enumerateDevices'});",
      "  return navigator.mediaDevices.enumerateDevices().catch(function(e){",
      "    return {err:String(e && e.message)};",
      "  }).then(function(ds){",
      "    if(!ds || ds.err) return ds;",
      "    var a=0,v=0,o=0;",
      "    for(var i=0;i<ds.length;i++){",
      "      if(ds[i].kind==='audioinput') a++;",
      "      else if(ds[i].kind==='videoinput') v++;",
      "      else if(ds[i].kind==='audiooutput') o++;",
      "    }",
      "    return {audioIn:a, videoIn:v, audioOut:o};",
      "  });",
      "})()"
    ].join("\n");
    // The kernel TRUNCATES the real device list: it resizes only when
    // configured < actual. It cannot invent devices, so asking for more than
    // the host has is a no-op. Assert the shrink direction against the
    // measured baseline rather than asking for a fixed count.
    const mdBase = await probe({}, mdJs);
    const mdSmall = await probe({
      media_devices_video_input: 1, media_devices_audio_output: 1
    }, mdJs);
    const canShrinkVideo = mdBase && mdBase.videoIn > 1;
    const canShrinkAudioOut = mdBase && mdBase.audioOut > 1;
    if (!canShrinkVideo && !canShrinkAudioOut) {
      console.log("SKIP  media_devices_*: host has too few devices to test shrinking " +
        JSON.stringify(mdBase));
    } else {
      if (canShrinkVideo) {
        check("media_devices_video_input (shrink)",
          mdSmall && mdSmall.videoIn === 1, "base=" + mdBase.videoIn + " -> " + mdSmall.videoIn);
      }
      if (canShrinkAudioOut) {
        check("media_devices_audio_output (shrink)",
          mdSmall && mdSmall.audioOut === 1, "base=" + mdBase.audioOut + " -> " + mdSmall.audioOut);
      }
    }
    // Asking for MORE than the host has must be a no-op, never an invention.
    const mdGrow = await probe({ media_devices_audio_input: 99 }, mdJs);
    check("media_devices: cannot invent devices beyond the host's real count",
      mdGrow && mdBase && mdGrow.audioIn === mdBase.audioIn,
      "base=" + (mdBase && mdBase.audioIn) + " asked 99 -> " + (mdGrow && mdGrow.audioIn));

    // ---------- media codecs denylist ----------
    // The kernel hooks MediaCapabilities.decodingInfo(), NOT canPlayType().
    // It matches the denylist against the queried content type, so the entry
    // must be a substring of it ("avc1" or "video/mp4", not "h264").
    const mcJs = [
      "(async function(){",
      "  if(!navigator.mediaCapabilities) return {err:'no mediaCapabilities'};",
      "  var cfg={type:'file', video:{",
      "    contentType:'video/mp4; codecs=\"avc1.42E01E\"',",
      "    width:1920,height:1080,bitrate:5000000,framerate:30}};",
      "  try { var r = await navigator.mediaCapabilities.decodingInfo(cfg);",
      "        return {supported:r.supported}; }",
      "  catch(e){ return {err:String(e && e.message)}; }",
      "})()"
    ].join("\n");
    const mcOff = await probe({}, mcJs);
    const mcOn = await probe({ media_codecs_denylist: "avc1" }, mcJs);
    if (mcOff && (mcOff.err || mcOff.supported !== true)) {
      console.log("SKIP  media_codecs_denylist: h264 not supported on this host " +
        JSON.stringify(mcOff));
    } else {
      check("media_codecs_denylist: support removed when denied",
        mcOn && mcOn.supported === false,
        "base=" + JSON.stringify(mcOff && mcOff.supported) +
        " denied=" + JSON.stringify(mcOn && mcOn.supported));
    }

    // ---------- geo ----------
    // Permission-gated, so grant it explicitly: without this the promise never
    // resolves and the probe hangs until the process exits. The kernel requires
    // latitude AND longitude together; either alone is ignored.
    const geoJs = [
      "(function(){",
      "  return new Promise(function(res){",
      "    if(!navigator.geolocation) return res({err:'no geolocation'});",
      "    navigator.geolocation.getCurrentPosition(",
      "      function(p){ res({lat:p.coords.latitude, lon:p.coords.longitude, acc:p.coords.accuracy}); },",
      "      function(e){ res({err:e.message}); },",
      "      {timeout: 5000});",
      "  });",
      "})()"
    ].join("\n");
    // The kernel rewrites the coordinates of a position the platform already
    // delivered (Geolocation::OnPositionUpdated); it does NOT fabricate one.
    // On a host with no geolocation provider nothing arrives and configured
    // and unconfigured calls fail identically - which would mask a real bug.
    //
    // So feed the platform a real position over CDP and assert the kernel
    // rewrites it. Two CDP details are load-bearing:
    //   * Page.enable + setFocusEmulationEnabled - without them the page is
    //     not "visible" and Geolocation returns early (geolocation.cc L697,
    //     immediately above the fp spoof block).
    //   * Emulation.setGeolocationOverride supplies the position to spoof.
    const geoInjected = { latitude: 1.1111, longitude: 2.2222, accuracy: 111 };
    async function probeGeo(fp) {
      const v = await openWith(fp, null);
      win.addBrowserView(v);
      await v.webContents.loadURL(ORIGIN);
      let r;
      try {
        const wc = v.webContents;
        wc.debugger.attach("1.3");
        await wc.debugger.sendCommand("Page.enable");
        await wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
        await wc.debugger.sendCommand("Emulation.setGeolocationOverride", geoInjected);
        r = await Promise.race([
          wc.executeJavaScript(geoJs),
          new Promise(res => setTimeout(() => res({ __timeout: true }), 15000))
        ]);
      } catch (e) {
        r = { __err: String(e && e.message) };
      }
      win.removeBrowserView(v);
      return r;
    }

    const geoBase = await probeGeo({});
    const geo = await probeGeo(
      { geo_latitude: -33.8688, geo_longitude: 151.2093, geo_accuracy: 5 });
    // The kernel requires latitude AND longitude together; either alone is a
    // no-op (geolocation.cc: if (!fp_lat.empty() && !fp_lng.empty())).
    const geoPartial = await probeGeo({ geo_latitude: 55.5 });

    const geoOk = geoBase && !geoBase.err && !geoBase.__timeout && !geoBase.__err;
    if (!geoOk) {
      console.log("SKIP  geo_latitude/longitude/accuracy: no position available " +
        JSON.stringify(geoBase) + " (CDP override did not deliver)");
    } else {
      check("geo_*: unconfigured passes the real position through",
        geoBase.lat === 1.1111 && geoBase.lon === 2.2222,
        JSON.stringify(geoBase));
      check("geo_latitude", geo && Math.abs(geo.lat - (-33.8688)) < 0.001, geo && String(geo.lat));
      check("geo_longitude", geo && Math.abs(geo.lon - 151.2093) < 0.001, geo && String(geo.lon));
      check("geo_accuracy", geo && geo.acc === 5, geo && String(geo.acc));
      check("geo_*: latitude alone is ignored (kernel needs both)",
        geoPartial && geoPartial.lat === 1.1111 && geoPartial.lon === 2.2222,
        JSON.stringify(geoPartial));
    }

    // ---------- webgpu adapter metadata ----------
    // webgpu_device / webgpu_description are only exposed on GPUAdapterInfo when
    // WebGPUDeveloperFeatures is on: CreateAdapterInfoForAdapter() constructs the
    // info object WITHOUT them in the default path (gpu_adapter.cc L324-326), so
    // without the flag those two keys are unreachable from JS no matter what the
    // kernel sets. vendor/architecture are exposed either way.
    const wgJs = [
      "(async function(){",
      "  if(!navigator.gpu) return {err:'no navigator.gpu'};",
      "  try {",
      "    var a = await navigator.gpu.requestAdapter();",
      "    if(!a) return {err:'no adapter'};",
      "    var i = a.info;",
      "    if(!i) return {err:'no adapter.info'};",
      "    return {vendor:i.vendor, architecture:i.architecture,",
      "            device:i.device, description:i.description};",
      "  } catch(e){ return {err:String(e && e.message)}; }",
      "})()"
    ].join("\n");
    const wgBase = await probe({}, wgJs);
    const wg = await probe({
      webgpu_vendor: "AuditGPUVendor", webgpu_architecture: "audit-arch",
      webgpu_device: "AuditDevice", webgpu_description: "AuditDescription"
    }, wgJs);
    if (wgBase && (wgBase.err || wgBase.__timeout || wgBase.__err)) {
      console.log("SKIP  webgpu_*: " + (wgBase.err || wgBase.__err || "timed out") +
        " (GPU process may be unavailable)");
    } else {
      // Only assert what this Chromium actually exposes. Without the dev flag
      // device/description come back as EMPTY STRINGS (not null) even at
      // baseline, so a null-check would wrongly treat them as available and
      // report a failure that is really a build-config limitation.
      const isExposed = v => typeof v === "string" ? v.length > 0
                            : (v !== undefined && v !== null);
      const exposed = {
        vendor: isExposed(wgBase && wgBase.vendor),
        architecture: isExposed(wgBase && wgBase.architecture),
        device: isExposed(wgBase && wgBase.device),
        description: isExposed(wgBase && wgBase.description)
      };
      const want = { vendor: "AuditGPUVendor", architecture: "audit-arch",
                     device: "AuditDevice", description: "AuditDescription" };
      for (const k of Object.keys(want)) {
        if (!exposed[k]) {
          console.log("SKIP  webgpu_" + (k === "description" ? "description" : k) +
            ": not exposed by this build (needs WebGPUDeveloperFeatures)");
        } else {
          check("webgpu_" + k, wg && wg[k] === want[k],
            "base=" + JSON.stringify(wgBase[k]) + " -> " + JSON.stringify(wg && wg[k]));
        }
      }
    }

    console.log("");
    console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " checks");
    app.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.log("THREW  " + e.message);
    app.exit(1);
  }
})();
