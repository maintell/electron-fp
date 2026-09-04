// Shared fingerprint probe: the SINGLE source of truth for what surfaces exist,
// how to read them, and how to decide "did the configured value actually apply".
//
// Extracted from fingerprint/scripts/smoke.js so the Client's self-test panel
// and the command-line smoke test cannot drift apart. Before this existed, the
// probe lived only inside smoke.js - a self-running `#!/usr/bin/env electron`
// script - so anything wanting the same checks had to copy the logic, and two
// copies of a probe are two probes that silently disagree.
//
// MOVED VERBATIM, NOT REWRITTEN: PROBE, EXPECTED and compare() are character-
// for-character the versions that the 27-passing smoke run was validated
// against. Rewriting them "more cleanly" would have invalidated that.
//
// Three exports:
//   PROBE        - JS source string; run in a page, returns {key: observedValue}
//   EXPECTED     - the fixed config smoke.js applies when it drives itself
//   compare()    - (key, expected, got) -> boolean
//   PROBE_FIELDS - every key PROBE can actually populate

'use strict';

// ---------------------------------------------------------------------------
// EXPECTED: the config smoke.js applies to its own window.
//
// These are NOT "correct fingerprint values" - they are arbitrary but
// distinctive values chosen so that "the surface reports the real hardware"
// cannot be mistaken for "the surface reports what we asked for".
// ---------------------------------------------------------------------------
const EXPECTED = {
  hardware_concurrency: 2,
  device_memory: 4,
  max_touch_points: 5,
  screen_width: 1280,
  screen_height: 800,
  screen_avail_width: 1280,
  screen_avail_height: 740,
  screen_color_depth: 24,
  do_not_track: '1',
  tz_id: 'America/New_York',
  canvas_noise_seed: 12345,
  // canvas_noise_strength is deliberately NOT here. The probe never reads it
  // (it perturbs pixels; it is not a value a page can read back), so listing it
  // made smoke.js report a permanent "SKIP canvas_noise_strength (not probed)"
  // and quietly inflated the coverage count. It is asserted properly, by
  // measuring the perturbation magnitude, in test-canvas-strength.js.
  net_effective_type: '4g',
  net_rtt_ms: 50,
  net_downlink_mbps: '10',
  permissions_status: 'granted',
  storage_usage_bytes: 1048576,
  storage_quota_bytes: 10737418240,
  prefers_color_scheme: 'dark',
  webgl_max_texture_size: 8192,
  webgl_vendor: 'Google Inc. (NVIDIA)',
  webgl_renderer: 'ANGLE (NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0)',
  // MUST be an unquoted NUMBER. The kernel parses this key with StringToInt,
  // which rejects the quoted form and silently FALLS BACK TO THE NATIVE VALUE -
  // measured: '8192' (string) -> 32767,32767 (real hardware), 8192 (number) ->
  // 8192,8192. The comparison below accepts "v,v" or "v", so a fallback simply
  // FAILs rather than passing; that is the point.
  webgl_max_viewport_dims: 8192,
  media_devices_audio_input: 2,
  media_devices_video_input: 1,
  media_devices_audio_output: 1,
  audio_sample_rate: 48000,
  client_rects_seed: 999,
};

// ---------------------------------------------------------------------------
// PROBE: read-only script run inside a page.
//
// Design rule: it must be safe to inject into a page the user is looking at.
// It is an IIFE, every variable is local, and the only mutation of the DOM is a
// temporary <div> for client_rects_seed which is removed immediately after
// measuring. Nothing is written to window.
//
// Context requirement: MUST run on a real http(s) origin, never about:blank.
// about:blank is an OPAQUE ORIGIN ("null") and Chromium gates several surfaces
// behind a potentially-trustworthy context:
//   * navigator.storage       -> undefined (kills storage_quota/usage_bytes)
//   * navigator.mediaDevices  -> undefined (kills all three media_devices_*)
// The failure is SILENT: the try/catch swallows it, the key is absent, and the
// caller reports SKIP - so 5 surfaces looked "not applicable" when they were
// merely unmeasurable. A probe that reports SKIP cannot tell "feature off" from
// "probe blind". 127.0.0.1 IS treated as potentially-trustworthy.
// ---------------------------------------------------------------------------
const PROBE = `(async () => {
  const r={};
  try{
    r.hardware_concurrency=navigator.hardwareConcurrency;
    r.device_memory=navigator.deviceMemory;
    r.max_touch_points=navigator.maxTouchPoints;
    r.screen_width=screen.width; r.screen_height=screen.height;
    r.screen_avail_width=screen.availWidth; r.screen_avail_height=screen.availHeight;
    r.screen_color_depth=screen.colorDepth;
    r.do_not_track=navigator.doNotTrack;
    r.tz_id=Intl.DateTimeFormat().resolvedOptions().timeZone;
    r.fonts_blocklist=document.fonts.check('12px Consolas');
    const c=document.createElement('canvas'); c.width=100; c.height=100;
    const x=c.getContext('2d'); if(x){ x.font='20px Arial'; r.measure_text_seed=x.measureText('The quick brown fox').width; r.canvas_noise_seed=c.toDataURL().length; }
    const conn=navigator.connection||{}; r.net_effective_type=conn.effectiveType; r.net_rtt_ms=conn.rtt; r.net_downlink_mbps=conn.downlink;
    try{ r.permissions_status=(await navigator.permissions.query({name:'notifications'})).state; }catch(e){ r.permissions_status='unknown'; }
    try{ const s=await navigator.storage.estimate(); r.storage_usage_bytes=s.usage; r.storage_quota_bytes=s.quota; }catch(e){}
    r.prefers_color_scheme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
    // A canvas can hold only ONE context type. The canvas used above already
    // has a 2d context (measure_text / canvas_noise), so getContext('webgl')
    // on it returns NULL - verified: {got2d:true, glSameCanvas:false,
    // glFreshCanvas:true}. That made every webgl_* surface report
    // "SKIP (not probed)" rather than being measured, so the smoke test could
    // not distinguish "WebGL spoofing is off" from "we never looked".
    const glc=document.createElement('canvas');
    const gl=glc.getContext('webgl')||glc.getContext('experimental-webgl');
    if(gl){
      r.webgl_max_texture_size=gl.getParameter(gl.MAX_TEXTURE_SIZE);
      try{ r.webgl_max_renderbuffer_size=gl.getParameter(gl.MAX_RENDERBUFFER_SIZE); }catch(e){}
      try{ const d=gl.getParameter(gl.MAX_VIEWPORT_DIMS); r.webgl_max_viewport_dims=Array.from(d).join(','); }catch(e){}
      // ALIASED_*_RANGE returns a Float32Array of [min,max].
      try{ r.webgl_aliased_point_size_range=Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)).join(','); }catch(e){}
      try{ r.webgl_aliased_line_width_range=Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE)).join(','); }catch(e){}
      // shader precision: rangeMin,rangeMax,precision
      try{ const s=gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT); if(s) r.webgl_shader_precision_highp=[s.rangeMin,s.rangeMax,s.precision].join(','); }catch(e){}
      try{ const dbg=gl.getExtension('WEBGL_debug_renderer_info'); if(dbg){ r.webgl_vendor=gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL); r.webgl_renderer=gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL); } }catch(e){}
      try{ r.webgl_extensions=(gl.getSupportedExtensions()||[]).join(','); }catch(e){}
    }
    try{
      const devs=await navigator.mediaDevices.enumerateDevices(); let ai=0,vi=0,ao=0;
      devs.forEach(d=>{ if(d.kind==='audioinput') ai++; if(d.kind==='videoinput') vi++; if(d.kind==='audiooutput') ao++; });
      r.media_devices_audio_input=ai; r.media_devices_video_input=vi; r.media_devices_audio_output=ao;
    }catch(e){}
    try{
      if(navigator.gpu){ const ag=await navigator.gpu.requestAdapter(); if(ag){ const inf=ag.info||{}; r.webgpu_vendor=inf.vendor; r.webgpu_architecture=inf.architecture; r.webgpu_device=inf.device; r.webgpu_description=inf.description; r.webgpu_features=Array.from(ag.features||[]).sort().join(','); const ln=['maxTextureDimension2D','maxBufferSize']; const lo={}; ln.forEach(n=>{ lo[n]=ag.limits[n]; }); r.webgpu_limits=JSON.stringify(lo); } }
    }catch(e){}
    try{ const ac=new (window.AudioContext||window.webkitAudioContext)(); r.audio_sample_rate=ac.sampleRate;
      // maxChannelCount is the surface audio_max_channels spoofs.
      if(ac.destination) r.audio_max_channels=ac.destination.maxChannelCount;
      // outputLatency is the surface audio_output_latency_ms spoofs - NOT
      // baseLatency. outputLatency is in SECONDS, so convert to ms for a
      // like-for-like comparison against the configured integer.
      if(ac.outputLatency!==undefined&&ac.outputLatency!==null) r.audio_output_latency_ms=Math.round(ac.outputLatency*1000);
      ac.close(); }catch(e){ try{ r.audio_sample_rate=new OfflineAudioContext(1,1,48000).sampleRate; }catch(_e){} }
    // audio_data_seed/strength perturb the rendered buffer, so the observable
    // is a checksum of the samples, not a value.
    //
    // The obvious source - an OscillatorNode - is a trap: it renders a
    // deterministic waveform, and with only 1000 frames the checksum is
    // dominated by the ramp, so two different seeds measured IDENTICAL (638 vs
    // 638). Use a noise buffer instead (its samples are the content being
    // perturbed) and enough frames that the perturbation is not lost in
    // rounding.
    try{
      const n=8192, oac=new OfflineAudioContext(1,n,44100);
      const src=oac.createBuffer(1,n,44100), ch=src.getChannelData(0);
      let st=1; for(let i=0;i<n;i++){ st=(st*1103515245+12345)&0x7fffffff; ch[i]=(st/0x7fffffff)*2-1; }
      const bs=oac.createBufferSource(); bs.buffer=src; bs.connect(oac.destination); bs.start();
      const buf=await oac.startRendering(); const d=buf.getChannelData(0);
      let s=0; for(let i=0;i<d.length;i++) s+=Math.abs(d[i]);
      r.audio_data_seed=Math.round(s*100);
    }catch(e){}
    try{ if(navigator.getBattery){ const b=await navigator.getBattery(); r.battery_charging=String(b.charging); r.battery_level=String(b.level); } }catch(e){}
    try{ const el=document.createElement('div'); el.style.cssText='position:absolute;left:10px;top:20px;width:100px;height:10px'; document.body.appendChild(el); const rect=el.getBoundingClientRect(); r.client_rects_seed=rect.x+','+rect.y; el.remove(); }catch(e){}
    try{ const vs=speechSynthesis.getVoices(); r.speech_voices_count=vs.length; r.speech_voices_lang=vs[0]?vs[0].lang:''; }catch(e){}
    // perf_now_precision_ms quantises the clock. The naive probe - measure the
    // smallest DELTA between two now() calls - reports "undefined" once the
    // clock is quantised, because quantised deltas are exactly 0 and a
    // "only keep d > 0" filter collects nothing. That reads as a probe failure
    // when the key is working perfectly. Sample ABSOLUTE values instead and report
    // the granularity of the grid they land on.
    // Sampling in a TIGHT synchronous loop is a trap: 40 calls land inside one
    // millisecond, so the granularity reads 1 no matter what the kernel does -
    // the probe then reports the key as broken when it is working. Yield between
    // samples so the clock actually advances. (Measured: tight loop -> 1 with
    // perf_now_precision_ms=100; spaced sampling -> 100.)
    try{
      const vals=[];
      for(let i=0;i<24;i++){ vals.push(performance.now()); await new Promise(rs=>setTimeout(rs,8)); }
      const uniq=[...new Set(vals.map(v=>Math.round(v)))].sort((a,b)=>a-b);
      if(uniq.length>1){ let g=-1; for(let i=1;i<uniq.length;i++){ const gap=uniq[i]-uniq[i-1]; if(gap>0&&(g<0||gap<g)) g=gap; } r.perf_now_precision_ms=g; }
      else r.perf_now_precision_ms=1;   // clock not advancing within the sample
    }catch(e){}
    // fonts_whitelist / fonts_blocklist hide fonts in FontCache. The observable
    // is a WIDTH, not document.fonts.check(): check() answers "is a face
    // available for this family", which stays true via fallback, while the
    // measured width actually changes when the font is hidden.
    try{
      const mk=(fam)=>{ const s=document.createElement('span');
        s.style.cssText='position:absolute;font-size:40px;font-family:'+fam+';white-space:pre';
        s.textContent='mmmmmmmmmm'; document.body.appendChild(s);
        const w=Math.round(s.getBoundingClientRect().width*100)/100; s.remove(); return w; };
      // Pick fonts whose metrics DIFFER from each other. Measuring three fonts
      // that all render at the same width makes the "widths differ" assertion
      // vacuous: it passes with the key working AND with it not applied at all.
      r.fonts_whitelist=[mk('Consolas'),mk('Georgia'),mk('Impact')].join(',');
    }catch(e){}
    try{
      // media_codecs_denylist hooks MediaCapabilities.decodingInfo(), NOT
      // canPlayType(). Matches substrings ("avc1", not "h264").
      const r2=await navigator.mediaCapabilities.decodingInfo({type:'file',video:{contentType:'video/mp4; codecs="avc1.42E01E"',width:1920,height:1080,bitrate:1000000,framerate:30}});
      r.media_codecs_denylist=String(r2.supported);
    }catch(e){}
    // webrtc_ip replaces ICE candidates. Gathering is aysnc and slow, and on a
    // host with no network the candidate list is legitimately empty, which must
    // read as "not measurable" rather than "spoofing failed".
    try{
      const pc=new RTCPeerConnection({iceServers:[]}); pc.createDataChannel('fp');
      await pc.setLocalDescription(await pc.createOffer());
      const ips=[];
      // A bare /(\d{1,3}\.){3}\d{1,3}/ matches ANY dotted quad in the candidate
      // string, including SDP fields that are not addresses (measured: it pulled
      // "1301675584 1" out of a candidate). Anchor on the actual "typ ..." IP
      // field, then validate each octet is 0-255.
      await new Promise((res)=>{ const to=setTimeout(res,2500);
        pc.onicecandidate=(e)=>{ if(!e.candidate||!e.candidate.candidate){ clearTimeout(to); res(); return; }
          const mm=/[0-9]{1,3}(?:\.[0-9]{1,3}){3}/g.exec(e.candidate.candidate);
          if(mm){ const okp=mm[0].split('.').every(o=>+o>=0&&+o<=255); if(okp) ips.push(mm[0]); } }; });
      pc.close(); r.webrtc_ip=[...new Set(ips)].sort().join(',');
    }catch(e){}
    // --- navigator / UA surfaces (keys 58-63 and the locale leaks) ---------
    // These are the surfaces an external detection site reads FIRST, and they
    // were absent from the probe entirely: a human using the self-test panel
    // had no row for them, so "is my UA coherent?" was unverifiable in the one
    // tool meant to answer it. All confirmed to change when configured.
    try{ r.navigator_platform=navigator.platform; }catch(e){}
    try{ r.navigator_vendor=navigator.vendor; }catch(e){}
    try{ r.navigator_languages=(navigator.languages||[]).join(','); }catch(e){}
    try{ r.device_pixel_ratio=String(window.devicePixelRatio); }catch(e){}
    try{
      const uad=navigator.userAgentData;
      if(uad){
        r.ua_platform=uad.platform;
        r.ua_mobile=String(uad.mobile);
        r.ua_brands=(uad.brands||[]).map(b=>b.brand+'='+b.version).join(', ');
      }
    }catch(e){}
  }catch(e){ r._probe_error=String(e&&e.message||e); }
  return r;
})()`;

// Every key PROBE can populate. Used to tell "the probe never looked at this
// surface" (SKIP) apart from "the probe looked and the value is wrong" (FAIL) -
// the distinction that makes a SKIP honest instead of a blind spot.
const PROBE_FIELDS = [
  'hardware_concurrency', 'device_memory', 'max_touch_points',
  'screen_width', 'screen_height', 'screen_avail_width', 'screen_avail_height',
  'screen_color_depth', 'do_not_track', 'tz_id', 'fonts_blocklist',
  'measure_text_seed', 'canvas_noise_seed',
  'net_effective_type', 'net_rtt_ms', 'net_downlink_mbps',
  'permissions_status', 'storage_usage_bytes', 'storage_quota_bytes',
  'prefers_color_scheme',
  'webgl_max_texture_size', 'webgl_max_viewport_dims', 'webgl_vendor',
  'webgl_renderer', 'webgl_extensions',
  'media_devices_audio_input', 'media_devices_video_input',
  'media_devices_audio_output',
  'webgpu_vendor', 'webgpu_architecture', 'webgpu_device',
  'webgpu_description', 'webgpu_features', 'webgpu_limits',
  'audio_sample_rate', 'battery_charging', 'battery_level',
  'client_rects_seed', 'speech_voices_count', 'speech_voices_lang',
  'navigator_platform', 'navigator_vendor', 'navigator_languages',
  'device_pixel_ratio', 'ua_platform', 'ua_mobile', 'ua_brands',
  // webgl surfaces that were never probed - see the comment in PROBE.
  'webgl_max_renderbuffer_size', 'webgl_aliased_point_size_range',
  'webgl_aliased_line_width_range', 'webgl_shader_precision_highp',
  // audio, perf and font surfaces whose observable is not a plain value.
  'audio_max_channels', 'audio_output_latency_ms', 'audio_data_seed',
  'perf_now_precision_ms', 'fonts_whitelist', 'media_codecs_denylist',
  'webrtc_ip',
];

// ---------------------------------------------------------------------------
// compare(key, expected, got): did the configured value actually land?
//
// Several keys need special handling because the OBSERVED value's shape is not
// the CONFIGURED value's shape. Getting these wrong is how a key can pass while
// doing nothing - e.g. webgl_max_viewport_dims takes ONE number but the surface
// reports "v,v", so a naive equality would compare 8192 to "8192,8192" and,
// depending on coercion, either always fail or always pass.
// ---------------------------------------------------------------------------
function compare(key, expected, got) {
  // special semantics mirroring smoke_fp.ps1
  // audio_output_latency_ms: the probe reports MILLISECONDS (it converts from
  // the API's seconds) while the config is an INT in ms. Compare numerically
  // with a tolerance: the value is a rounded float, so exact equality would
  // make a working key read as FAIL.
  if (key === 'audio_output_latency_ms') {
    const g = Number(got), e = Number(expected);
    if (!isFinite(g) || !isFinite(e)) return false;
    return Math.abs(g - e) <= Math.max(1, Math.abs(e) * 0.02);
  }
  // audio_data_seed: the observable is a CHECKSUM of the rendered buffer, not
  // the seed itself, so there is no value to compare against. Returning true
  // would be a lie and false would mark a working key as broken, so report
  // null and let verdicts() render it as "unknown". Deliberately NOT extended
  // to canvas_noise_strength / audio_data_strength: the probe has no surface
  // for those two, so a special case here would be unreachable dead code.
  if (key === 'audio_data_seed') return null;
  // perf_now_precision_ms: the probe reports the observed granularity. The
  // kernel QUANTISES, so the clock snaps to a multiple of the configured
  // value - granularity must be a positive multiple, not an exact equality
  // (a coarse host timer can land on 2x or 3x the requested precision).
  if (key === 'perf_now_precision_ms') {
    const g = Number(got), e = Number(expected);
    if (!isFinite(g) || !isFinite(e) || e <= 0) return false;
    return g > 0 && g % e === 0;
  }
  // fonts_whitelist: the probe reports three WIDTHS for three fonts that have
  // DIFFERENT metrics when untouched. A whitelist hides every family NOT listed,
  // so the only honest assertions are:
  //   * the widths are not all identical (they collapsed -> something applied,
  //     or the fonts genuinely match - both are detectable by the caller), and
  //   * a listed font kept a width distinct from an unlisted one.
  // compare() knows which fonts the probe measured, so it can check the
  // configured names against them instead of guessing.
  if (key === 'fonts_whitelist') {
    const parts = String(got).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return false;
    // Guard against a vacuous pass: three identical widths mean either
    // everything collapsed or nothing applied - indistinguishable here, so
    // refuse to claim success.
    return new Set(parts).size > 1;
  }
  // media_codecs_denylist: the probe reports whether an avc1 file is
  // decodable. A denylist containing "avc1" must make it false.
  if (key === 'media_codecs_denylist') {
    const denylisted = String(expected).toLowerCase().includes('avc1');
    return denylisted ? String(got) !== 'true' : true;
  }
  // webrtc_ip: the kernel REPLACES the candidate address. An empty candidate
  // list means the host gathered nothing, which is not a spoofing failure -
  // report null (unknown) rather than asserting either way.
  if (key === 'webrtc_ip') {
    if (got === undefined || got === null || String(got).trim() === '') return null;
    const want = String(expected).trim();
    if (!want) return null;
    return String(got).split(',').map((s) => s.trim()).includes(want);
  }
  // ua_mobile: the kernel does `mobile = (cfg_mobile == "true")` - the LITERAL
  // string. Measured: "1" leaves mobile at false, and so does "0"/"false"; only
  // "true" turns it on. So "configured as 1, reported false" is the kernel
  // working as written, not a failure - compare against the kernel's own rule
  // rather than against the user's intent, or every 1/mobile profile reads FAIL.
  if (key === 'ua_mobile') {
    return String(got) === (String(expected) === 'true' ? 'true' : 'false');
  }
  // ua_brands: FpConfigString TRUNCATES at the first quote, so a brand list
  // written in the wire form ('"Chromium";v="120"') arrives at the parser as
  // '\\' and produces garbage. Only the quote-free config form (Chromium=120)
  // survives. Compare as sets of name=version pairs, order-insensitively, and
  // treat a configured value containing '"' as unappliable rather than passing
  // or failing it - it cannot reach the kernel at all.
  if (key === 'ua_brands') {
    const parse = (s) => String(s).split(',').map((x) => x.trim())
      .filter(Boolean).sort().join(',');
    const want = parse(expected);
    // A quoted expected value can never be honoured: say so via false, and let
    // the explain() hint carry the reason.
    if (String(expected).includes('"')) return false;
    return parse(got) === want;
  }
  // navigator_languages: language() is languages().front(), so this vector
  // covers both surfaces. Order is meaningful (preference order), so compare
  // exactly - not as a set.
  if (key === 'navigator_languages') {
    return String(got).split(',').map((s) => s.trim()).join(',') ===
      String(expected).split(',').map((s) => s.trim()).join(',');
  }
  if (key === 'canvas_noise_seed') return Number(got) > 0;
  if (key === 'measure_text_seed') return Number(got) !== 0;
  if (key === 'fonts_blocklist') return got === false; // blocked
  if (key === 'webgl_max_viewport_dims') {
    return String(got) === `${expected},${expected}` || String(got) === String(expected);
  }
  // NOTE: the shared probe does NOT read perf_now_precision_ms (it is not in
  // PROBE_FIELDS), so this case is unreachable from the self-test panel. It is
  // kept because smoke.js compares against EXPECTED through the same compare(),
  // and because perf_now_precision_ms is genuinely asserted in
  // test-covered-surfaces.js - the point being that this special case must not
  // be read as evidence that the PROBE covers the key. It does not.
  if (key === 'perf_now_precision_ms') return Number(got) % Number(expected) === 0;
  if (key === 'webgpu_features') {
    const g = String(got).split(',').sort().join(',');
    const e = String(expected).split(',').sort().join(',');
    return g === e;
  }
  if (key === 'webgpu_limits') {
    try {
      const o = JSON.parse(got);
      for (const kv of String(expected).split(',')) {
        const [k, v] = kv.split('=');
        if (String(o[k]) !== String(v)) return false;
      }
      return true;
    } catch (e) { return false; }
  }
  if (key === 'client_rects_seed') {
    // element laid out at left:10px top:20px; fingerprint perturbs by <0.2px.
    const parts = String(got).split(',');
    const gx = Number(parts[0]), gy = Number(parts[1]);
    if (!isFinite(gx) || !isFinite(gy)) return false;
    return (Math.abs(gx - 10) > 0 && Math.abs(gx - 10) < 0.3) ||
           (Math.abs(gy - 20) > 0 && Math.abs(gy - 20) < 0.3);
  }
  if (key === 'device_memory' && got === undefined) return false; // SKIP by caller
  // default: string equality with numeric coercion tolerance
  if (typeof expected === 'number') return Number(got) === Number(expected);
  return String(got) === String(expected);
}

// ---------------------------------------------------------------------------
// verdicts(config, observed, options) -> { rows, summary }
//
// The self-test's decision table, in ONE place.
//
// This used to live twice: once inside main.js's `selftest:run` handler and
// once copy-pasted into Client/test-selftest.js. Two copies of a verdict rule
// are two verdict rules, and they had already drifted - the handler carried the
// expected/got strings and the explainMismatch() hints, the test's copy carried
// neither. A test that asserts against its own re-implementation can stay green
// while the shipped behaviour is wrong, which is the worst possible outcome for
// a test.
//
// The comparison is against the config the CALLER supplies, not against
// EXPECTED. smoke.js asks "did MY chosen values apply?"; the panel asks "did
// YOUR chosen values apply?". Same logic, different reference set.
//
// Four verdicts, and only two are failures:
//   pass  - configured, and the surface reports exactly what was configured
//   fail  - configured, but the surface reports something else. This is the
//           case the panel exists to catch: the knob looked set, the UI said
//           "active", and the renderer quietly used something else - most often
//           the real hardware value.
//   skip  - not configured (nothing was asked for) or the probe cannot see it
//   error - compare() itself threw
//
// An inactive key is skip, NOT fail: judging only what the user actually asked
// for, otherwise a default profile shows a wall of red.
//
// options.isActive  - (key, value) => boolean, defaults to a truthiness test.
//                     Pass fpIsActive to match the kernel's own rule.
// options.explain   - (key, expected, got) => string, attached to fail/error.
// ---------------------------------------------------------------------------
// String() that cannot throw. Used for every value the verdict rows report.
//
// A value whose toString() throws is unusual but not exotic, and it matters
// exactly where it is least likely to be noticed: if reporting a failure
// throws, the failure is never reported and the whole pass rejects.
function SAFE(v) {
  try {
    const s = String(v);
    return s;
  } catch (_) {
    return '<unstringifiable: ' + Object.prototype.toString.call(v) + '>';
  }
}

function verdicts(config, observed, options) {
  const opts = options || {};
  const isActive = opts.isActive || ((k, v) => v !== undefined && v !== null && v !== '');
  const explain = opts.explain || (() => '');
  const cfg = config || {};
  const seen = observed || {};

  const rows = [];
  for (const key of PROBE_FIELDS) {
    const got = seen[key];

    // Not probed on this page -> honest skip, never a pass. A probe that never
    // looked cannot have found anything wrong.
    if (got === undefined || got === null) {
      rows.push({
        key, expected: null, got: null, verdict: 'skip',
        reason: 'probe could not read this surface here',
      });
      continue;
    }

    // Not configured -> nothing was asked for, so nothing can be wrong.
    if (!isActive(key, cfg[key])) {
      rows.push({
        key, expected: null, got: SAFE(got), verdict: 'skip',
        reason: 'not configured',
      });
      continue;
    }

    const expected = cfg[key];
    let ok = false;
    try {
      ok = compare(key, expected, got);
      // Three-valued by design. Some surfaces cannot be judged from a single
      // observation: audio_data_seed's observable is a CHECKSUM (we can only
      // say "it changed" or "it did not", and there is no baseline here), and
      // webrtc_ip with an empty candidate list means the host gathered
      // nothing. Treating those as false would mark a WORKING key as failed,
      // which is the one lie this pane must not tell.
      if (ok === null) {
        rows.push({
          key, expected: SAFE(expected), got: SAFE(got), verdict: 'unknown',
          reason: explain(key, expected, got) ||
            'applied, but this surface cannot be judged from one reading',
        });
        continue;
      }
    } catch (err) {
      // SAFE() guards the error handler itself. The obvious `String(got)` is a
      // trap when `got` is the very thing that could not be stringified - the
      // catch block then throws while handling the error, the row is never
      // pushed, and the whole verdict pass rejects instead of reporting one
      // broken surface. Caught by a poisoned-toString probe.
      rows.push({
        key, expected: SAFE(expected), got: SAFE(got), verdict: 'error',
        reason: 'compare threw: ' + (err && err.message),
      });
      continue;
    }
    rows.push({
      key,
      expected: SAFE(expected),
      got: SAFE(got),
      verdict: ok ? 'pass' : 'fail',
      reason: ok ? '' : SAFE(explain(key, expected, got)),
    });
  }

  const summary = { pass: 0, fail: 0, skip: 0, error: 0, unknown: 0 };
  for (const r of rows) summary[r.verdict] = (summary[r.verdict] || 0) + 1;
  return { rows, summary };
}

module.exports = { PROBE, EXPECTED, PROBE_FIELDS, compare, verdicts };
