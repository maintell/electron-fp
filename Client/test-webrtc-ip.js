// Regression test: webrtc_ip must reach the kernel through Electron's
// per-renderer --fingerprint-config switch (not just FP_* env vars).
//
// Bug: GetCustomWebRtcIp() read only FP_CONFIG_DATA / FP_CONFIG / FP_WEBRTC_IP,
// so webrtc_ip was silently ignored when set via the fingerprint webPreference.
// Fix: Blink pushes the switch-resolved value in via SetCustomWebRtcIpOverride().
//
// This test fails if that override path regresses.

const { app, BrowserWindow, BrowserView } = require("electron");

const CUSTOM_IP = "203.0.113.77";
let failures = 0;

function check(name, ok, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  (" + detail + ")" : ""));
  if (!ok) failures++;
}

// ICE gathering has no fixed completion time. A single 3s deadline silently
// returns [] when the machine is loaded - and the full suite runs 16 Electron
// processes, so this is not hypothetical: it produced a real flake where
// "baseline exposes real host IPs" failed because zero candidates arrived in
// time. Retry with a longer deadline, and accept the run as soon as candidates
// exist, so a slow-but-successful gather passes instead of being reported as
// "the kernel dropped webrtc_ip".
const PROBE = `(async () => {
  const out = { hw: navigator.hardwareConcurrency, ips: [], attempts: 0 };
  for (let attempt = 0; attempt < 3 && out.ips.length === 0; attempt++) {
    out.attempts++;
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel("x");
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise(r => {
        const t = setTimeout(r, 8000);
        pc.onicecandidate = e => {
          if (e.candidate && e.candidate.candidate) {
            const m = /typ (host|srflx)/.exec(e.candidate.candidate);
            const ip = /([0-9]{1,3}\\.){3}[0-9]{1,3}/.exec(e.candidate.candidate);
            if (m && ip) out.ips.push(m[1] + ":" + ip[0]);
          } else { clearTimeout(t); r(); }
        };
      });
      pc.close();
    } catch (e) { out.err = String(e.message); }
  }
  return out;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 600 });

  const run = async (fp, tag) => {
    const v = new BrowserView({
      webPreferences: { partition: "webrtc-" + tag + "-" + Math.random(), sandbox: false, ...(fp ? { fingerprint: fp } : {}) },
    });
    win.addBrowserView(v);
    v.setBounds({ x: 0, y: 0, width: 800, height: 500 });
    await v.webContents.loadURL("about:blank");
    await new Promise(r => setTimeout(r, 400));
    const res = await v.webContents.executeJavaScript(PROBE, true);
    return res;
  };

  const baseline = await run(null, "base");
  const withFp = await run({ hardware_concurrency: 7, webrtc_ip: CUSTOM_IP }, "fp");

  console.log("configured webrtc_ip = " + CUSTOM_IP + "\n");

  // 1. Control: the switch-based mechanism works at all.
  check("control key applied via switch", withFp.hw === 7, "hardware_concurrency=" + withFp.hw);

  // 2. Baseline must expose real IPs, proving the probe is meaningful.
  check("baseline exposes real host IPs", baseline.ips.length > 0 && !baseline.ips.some(s => s.includes(CUSTOM_IP)),
        baseline.ips.length + " candidates");

  // 3. The regression itself: webrtc_ip must be honoured via the switch.
  check("webrtc_ip applied via --fingerprint-config",
        withFp.ips.length > 0 && withFp.ips.some(s => s.includes(CUSTOM_IP)),
        withFp.ips.length ? withFp.ips[0] : "no candidates");

  // 4. No real IP must survive in the candidate list.
  check("no real host IP leaks when spoofing",
        withFp.ips.length > 0 && withFp.ips.every(s => s.includes(CUSTOM_IP)),
        [...new Set(withFp.ips)].join(", "));

  console.log("");
  console.log(failures === 0
    ? "PASS: webrtc_ip reaches the kernel via --fingerprint-config"
    : "FAIL: " + failures + " check(s) failed");

  win.close();
  app.exit(failures === 0 ? 0 : 1);
});

setTimeout(() => { console.error("TIMEOUT"); app.exit(2); }, 40000);
