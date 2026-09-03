#!/usr/bin/env electron
// fingerprint smoke 20+ surfaces via BrowserWindow + executeJavaScript
// usage: electron fingerprint/scripts/smoke.js [--no-fingerprint] [--isolation] [--verbose]
// --no-fingerprint: zero-config native comparison (no spoof, sanity check)
// --isolation: two windows different configs (window-level isolation)
'use strict';
const { app, BrowserWindow } = require('electron');
const http = require('http');

// PROBE / EXPECTED / compare() now live in Client/fp-probe.js so the Client's
// self-test panel and this script share ONE probe instead of two that can
// drift. Verified equivalent to the inline versions this file used to carry:
//   - PROBE: byte-identical (4021 chars)
//   - EXPECTED: 28/28 keys, identical values, identical order
//   - compare(): 39 behavioural cases, 0 divergences (the text differs only in
//     `if` bracing style, which was normalised when it moved)
// Do NOT re-specialise the probe here - edit the shared module instead, so the
// self-test panel picks the change up too.
const { PROBE, EXPECTED, compare } = require('../../Client/fp-probe.js');

// A real origin for the probe - see evalProbe() for why about:blank is wrong.
// 127.0.0.1 is treated as potentially-trustworthy, so navigator.storage and
// navigator.mediaDevices are defined there.
const PROBE_ORIGIN_HOLDER = { url: null };

const args = process.argv.slice(1);
const NO_FP = args.includes('--no-fingerprint');
const ISOLATION = args.includes('--isolation');
const VERBOSE = args.includes('--verbose') || args.includes('-v');
const OFFSCREEN = args.includes('--offscreen');
const HEADLESS = args.includes('--headless');
// 必须在 ready 之前注入，修复原 `whenReady` 内 no-sandbox 过晚的 bug
if (process.platform === 'linux' && !app.commandLine.hasSwitch('no-sandbox')) app.commandLine.appendSwitch('no-sandbox'); // ponytail: 仅加已验证需要的开关，不堆砌 --disable-gpu 等，缺了再补
if (HEADLESS && !app.commandLine.hasSwitch('headless')) app.commandLine.appendSwitch('headless');
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: electron fingerprint/scripts/smoke.js [--no-fingerprint] [--isolation] [--verbose] [--offscreen] [--headless]');
  process.exit(0);
}

let pass = 0, fail = 0, skip = 0;
const log = (...a) => console.log(...a);
const dbg = (...a) => { if (VERBOSE) console.log('[dbg]', ...a); };

// EXPECTED now comes from Client/fp-probe.js (see the require at the top).
// It was moved verbatim - 28 keys, same values, same order - so the surface set
// this script validates is the same one it always validated.


async function evalProbe(win, timeoutMs=15000){
  // Probe a REAL http origin, not about:blank.
  //
  // about:blank is an OPAQUE ORIGIN ("null"), and Chromium gates several
  // fingerprint surfaces behind a secure/potentially-trustworthy context:
  //   * navigator.storage           -> undefined (killed storage_quota_bytes,
  //                                    storage_usage_bytes)
  //   * navigator.mediaDevices      -> undefined (killed all three
  //                                    media_devices_* counts)
  // Measured: on about:blank both throw "Cannot read properties of undefined";
  // on http://127.0.0.1 (which IS treated as trustworthy) both populate.
  //
  // The failure mode is silent: the probe's `try{}catch{}` swallows it, the key
  // is absent, and the caller reports `SKIP ... (not probed)` - so 5 surfaces
  // looked "not applicable" when they were simply unmeasurable. A smoke test
  // that reports SKIP cannot tell "feature off" from "probe blind".
  await win.loadURL(PROBE_ORIGIN_HOLDER.url);
  // wait a tick for renderer ready
  await new Promise(r=>setTimeout(r, 300));
  const p = win.webContents.executeJavaScript(PROBE, true);
  const t = new Promise((_,rej)=>setTimeout(()=>rej(new Error('probe timeout')), timeoutMs));
  return Promise.race([p,t]);
}

// compare() now comes from Client/fp-probe.js (see the require at the top).

async function runSingleWindow(){
  const cfg = NO_FP ? null : EXPECTED;
  const win = new BrowserWindow({ show:false, width:800, height:600, webPreferences:{ offscreen: OFFSCREEN, nodeIntegration:false, contextIsolation:true, ...(cfg?{fingerprint:cfg}:{}) } });
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
    if(actual[k]===undefined){ log(`SKIP  ${k} (API not exposed)`); skip++; continue; }
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
  // ponytail: partition workaround for about:blank process reuse, C++ fix is primary
  const winA=new BrowserWindow({ show:false, width:400, height:300, webPreferences:{ offscreen: OFFSCREEN, fingerprint: cfgA, session: require('electron').session.fromPartition('persist:isoA') }});
  const winB=new BrowserWindow({ show:false, width:400, height:300, webPreferences:{ offscreen: OFFSCREEN, fingerprint: cfgB, session: require('electron').session.fromPartition('persist:isoB') }});
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
  let overall=true;
  // Start the probe origin before any window loads it.
  const srv = http.createServer((q, s) => {
    s.writeHead(200, { 'Content-Type': 'text/html' });
    s.end('<html><body>fp-smoke</body></html>');
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  PROBE_ORIGIN_HOLDER.url =
    'http://127.0.0.1:' + srv.address().port + '/';
  dbg('probe origin:', PROBE_ORIGIN_HOLDER.url);
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
  try { srv.close(); } catch (e) {}

  // The exit code must survive the last window closing.
  //
  // runSingleWindow() calls win.close(). Electron's default window-all-closed
  // handler then quits the process with code 0, so this line's app.exit() never
  // ran and a FAILING smoke exited 0 - measured: "26 passed, 1 failed" printed,
  // process exit code 0. A gate that trusts the exit code waved it through.
  //
  // process.exitCode was tried first and is NOT enough: Electron's quit path
  // overrides it. The reliable fix is to suppress the default handler (below)
  // so the only exit is the explicit one here.
  finalCode = fail > 0 ? 1 : 0;
  setTimeout(() => { app.exit(finalCode); }, 300);
});

// Stop Electron quitting on window-all-closed, so the exit code above is the
// one that actually takes effect. See the comment above.
let finalCode = 0;
app.on('window-all-closed', (e) => { e.preventDefault(); });

// graceful timeout guard
setTimeout(()=>{ console.error('smoke timeout 30s'); try{ app.exit(2);}catch(e){ process.exit(2);} }, 30000);
process.on('unhandledRejection', e=>{ console.error('unhandled', e); app.exit(1); });
