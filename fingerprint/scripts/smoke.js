#!/usr/bin/env electron
// fingerprint smoke 20+ surfaces via BrowserWindow + executeJavaScript
// usage: electron fingerprint/scripts/smoke.js [--no-fingerprint] [--isolation] [--verbose]
// --no-fingerprint: zero-config native comparison (no spoof, sanity check)
// --isolation: two windows different configs (window-level isolation)
'use strict';
const { app, BrowserWindow } = require('electron');

const args = process.argv.slice(1);
const NO_FP = args.includes('--no-fingerprint');
const ISOLATION = args.includes('--isolation');
const VERBOSE = args.includes('--verbose') || args.includes('-v');
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: electron fingerprint/scripts/smoke.js [--no-fingerprint] [--isolation] [--verbose]');
  process.exit(0);
}

let pass = 0, fail = 0, skip = 0;
const log = (...a) => console.log(...a);
const dbg = (...a) => { if (VERBOSE) console.log('[dbg]', ...a); };

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
  canvas_noise_strength: 2,
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
  webgl_max_viewport_dims: '8192',
  media_devices_audio_input: 2,
  media_devices_video_input: 1,
  media_devices_audio_output: 1,
  audio_sample_rate: 48000,
  client_rects_seed: 999,
};

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
    const gl=c.getContext('webgl')||c.getContext('experimental-webgl');
    if(gl){
      r.webgl_max_texture_size=gl.getParameter(gl.MAX_TEXTURE_SIZE);
      try{ const d=gl.getParameter(gl.MAX_VIEWPORT_DIMS); r.webgl_max_viewport_dims=Array.from(d).join(','); }catch(e){}
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
    try{ const ac=new (window.AudioContext||window.webkitAudioContext)(); r.audio_sample_rate=ac.sampleRate; ac.close(); }catch(e){ try{ r.audio_sample_rate=new OfflineAudioContext(1,1,48000).sampleRate; }catch(_e){} }
    try{ if(navigator.getBattery){ const b=await navigator.getBattery(); r.battery_charging=String(b.charging); r.battery_level=String(b.level); } }catch(e){}
    try{ const el=document.createElement('div'); el.style.cssText='position:absolute;left:10px;top:20px;width:100px;height:10px'; document.body.appendChild(el); const rect=el.getBoundingClientRect(); r.client_rects_seed=rect.x+','+rect.y; el.remove(); }catch(e){}
    try{ const vs=speechSynthesis.getVoices(); r.speech_voices_count=vs.length; r.speech_voices_lang=vs[0]?vs[0].lang:''; }catch(e){}
  }catch(e){ r._probe_error=String(e&&e.message||e); }
  return r;
})()`;

async function evalProbe(win, timeoutMs=15000){
  await win.loadURL('about:blank');
  // wait a tick for renderer ready
  await new Promise(r=>setTimeout(r, 300));
  const p = win.webContents.executeJavaScript(PROBE, true);
  const t = new Promise((_,rej)=>setTimeout(()=>rej(new Error('probe timeout')), timeoutMs));
  return Promise.race([p,t]);
}

function compare(key, expected, got){
  // special semantics mirroring smoke_fp.ps1
  if(key==='canvas_noise_seed') return Number(got)>0;
  if(key==='measure_text_seed') return Number(got)!==0;
  if(key==='fonts_blocklist') return got===false; // blocked
  if(key==='webgl_max_viewport_dims') return String(got)===`${expected},${expected}` || String(got)===String(expected);
  if(key==='perf_now_precision_ms') return Number(got)%Number(expected)===0;
  if(key==='webgpu_features'){ const g=(String(got).split(',').sort().join(',')); const e=(String(expected).split(',').sort().join(',')); return g===e; }
  if(key==='webgpu_limits'){ try{ const o=JSON.parse(got); for(const kv of String(expected).split(',')){ const [k,v]=kv.split('='); if(String(o[k])!==String(v)) return false; } return true; }catch(e){ return false; } }
  // default: string equality with numeric coercion tolerance
  if(typeof expected==='number') return Number(got)===Number(expected);
  return String(got)===String(expected);
}

async function runSingleWindow(){
  const cfg = NO_FP ? null : EXPECTED;
  const win = new BrowserWindow({ show:false, width:800, height:600, webPreferences:{ offscreen:false, nodeIntegration:false, contextIsolation:true, ...(cfg?{fingerprint:cfg}:{}) } });
  let actual;
  try{ actual=await evalProbe(win); }catch(e){ log('FAIL probe error:', e.message); win.close(); return false; }
  dbg('actual:', JSON.stringify(actual));
  if(actual._probe_error) log('probe error:', actual._probe_error);
  if(NO_FP){
    // zero-config: ensure no fingerprint injected and probe returns sane native values
    let fp=null; try{ fp=win.webContents.getFingerprintConfig?win.webContents.getFingerprintConfig():null; }catch(e){}
    // also check session
    if(fp && Object.keys(fp).length) { log(`FAIL --no-fingerprint: expected null/empty fingerprint but got ${JSON.stringify(fp)}`); fail++; }
    else { log(`PASS --no-fingerprint: fingerprint empty (native)`); pass++; }
    const checks=[['hardware_concurrency', actual.hardware_concurrency], ['screen_width', actual.screen_width], ['tz_id', actual.tz_id]];
    for(const [k,v] of checks){ if(v!=null && String(v).length){ log(`PASS  ${k} = ${v} (native)`); pass++; } else { log(`FAIL  ${k} native missing got=${v}`); fail++; } }
    log(`native probe: screen ${actual.screen_width}x${actual.screen_height} hw=${actual.hardware_concurrency} tz=${actual.tz_id}`);
    win.close();
    return fail===0;
  }
  // fingerprinted: compare 20+ keys
  let checked=0;
  for(const k of Object.keys(EXPECTED)){
    if(!(k in actual)){ log(`SKIP  ${k} (not probed)`); skip++; continue; }
    checked++;
    const ok=compare(k, EXPECTED[k], actual[k]);
    if(ok){ log(`PASS  ${k} = ${actual[k]}`); pass++; }
    else { log(`FAIL  ${k} expected=${EXPECTED[k]} got=${actual[k]}`); fail++; }
  }
  if(checked<20) log(`WARN only ${checked} keys probed (<20)`);
  // extra surfaces not in EXPECTED but probed for visibility
  if(VERBOSE){
    const extra=['webgl_vendor','webgl_renderer','webgl_extensions','canvas_noise_seed','measure_text_seed','audio_sample_rate','battery_level'];
    for(const k of extra) if(k in actual) log(`INFO  ${k} = ${actual[k]}`);
  }
  win.close();
  return fail===0;
}

async function runIsolation(){
  const cfgA={hardware_concurrency:2, screen_width:1280, screen_height:800, device_memory:4, tz_id:'America/New_York'};
  const cfgB={hardware_concurrency:8, screen_width:1920, screen_height:1080, device_memory:8, tz_id:'Europe/London'};
  const winA=new BrowserWindow({ show:false, width:400, height:300, webPreferences:{ fingerprint: cfgA }});
  const winB=new BrowserWindow({ show:false, width:400, height:300, webPreferences:{ fingerprint: cfgB }});
  const [a,b]=await Promise.all([evalProbe(winA), evalProbe(winB)]);
  dbg('isolation A:', JSON.stringify(a));
  dbg('isolation B:', JSON.stringify(b));
  let ok=true;
  const checks=[ ['hardware_concurrency', cfgA.hardware_concurrency, a.hardware_concurrency, cfgB.hardware_concurrency, b.hardware_concurrency], ['screen_width', cfgA.screen_width, a.screen_width, cfgB.screen_width, b.screen_width], ['tz_id', cfgA.tz_id, a.tz_id, cfgB.tz_id, b.tz_id] ];
  for(const [k, expA, gotA, expB, gotB] of checks){
    const oA=String(gotA)===String(expA), oB=String(gotB)===String(expB), diff=String(gotA)!==String(gotB);
    if(oA && oB && diff){ log(`PASS  isolation ${k}: A=${gotA} B=${gotB} (different)`); pass++; }
    else { log(`FAIL  isolation ${k}: expected A=${expA} got ${gotA}, B=${expB} got ${gotB}`); fail++; ok=false; }
  }
  // also ensure fingerprintConfig API reflects per-window
  try{
    const fpA=winA.webContents.getFingerprintConfig?winA.webContents.getFingerprintConfig():null;
    const fpB=winB.webContents.getFingerprintConfig?winB.webContents.getFingerprintConfig():null;
    if(fpA && fpB && JSON.stringify(fpA)!==JSON.stringify(fpB)){ log(`PASS  isolation fingerprintConfig distinct`); pass++; }
    else { log(`INFO  isolation fingerprintConfig A=${JSON.stringify(fpA)} B=${JSON.stringify(fpB)}`); }
  }catch(e){}
  winA.close(); winB.close();
  return ok;
}

app.whenReady().then(async ()=>{
  // headless-friendly: disable gpu sandbox issues
  if(process.platform==='linux') app.commandLine.appendSwitch('no-sandbox');
  let overall=true;
  try{
    if(ISOLATION){
      overall=await runIsolation() && overall;
      // also run single-window smoke after isolation if not --no-fingerprint
      if(!NO_FP) overall=await runSingleWindow() && overall;
    } else {
      overall=await runSingleWindow();
      // if user asked isolation explicitly, already done; else skip
    }
  }catch(e){
    log('ERROR', e && e.stack||e);
    fail++;
    overall=false;
  }
  log('');
  log(`smoke result: ${pass} passed, ${fail} failed, ${skip} skipped`);
  // ensure windows closed before exit
  setTimeout(()=>{ app.exit(fail>0?1:0); }, 300);
});

// graceful timeout guard
setTimeout(()=>{ console.error('smoke timeout 30s'); try{ app.exit(2);}catch(e){ process.exit(2);} }, 30000);
process.on('unhandledRejection', e=>{ console.error('unhandled', e); app.exit(1); });
