// Regression test: webgpu_features (REPLACE) and webgpu_limits (MERGE).
//
// Bug: both keys were declared in the schema, documented in the patch and
// checked by check.py, but had ZERO kernel implementation. adapter.features
// stayed at the real 18 entries and adapter.limits stayed at their real
// values no matter what the config said - the keys were silently inert.
//
// Semantics implemented in gpu_adapter.cc:
//   webgpu_features = REPLACE: the configured list becomes the whole set.
//                     Names outside the GPUFeatureName enum are dropped
//                     rather than exposed (a fake name is itself a signal).
//   webgpu_limits   = MERGE: only configured keys override; everything else
//                     keeps the adapter's real value (over-reporting would
//                     make Dawn reject device creation and break WebGPU).
//
// This test fails if either path regresses.

const { app, BrowserWindow } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  (" + detail + ")" : ""));
  if (!ok) failures++;
}

const PROBE = `<!doctype html><html><body><script>
(async () => {
  try {
    if (!navigator.gpu) { document.title = 'R' + JSON.stringify({error:'no navigator.gpu'}); return; }
    const a = await navigator.gpu.requestAdapter();
    if (!a) { document.title = 'R' + JSON.stringify({error:'no adapter'}); return; }
    const f = [...a.features].sort();
    document.title = 'R' + JSON.stringify({
      features: f, featureCount: f.length,
      maxTextureDimension2D: a.limits.maxTextureDimension2D,
      maxBindGroups: a.limits.maxBindGroups,
      maxBufferSize: a.limits.maxBufferSize,
    });
  } catch (e) { document.title = 'R' + JSON.stringify({error:String(e)}); }
})();
</script></body></html>`;

function probeWith(fingerprint) {
  return new Promise(resolve => {
    const f = path.join(os.tmpdir(), "test-webgpu-probe.html");
    fs.writeFileSync(f, PROBE, "utf8");
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false, fingerprint } });
    const t = setTimeout(() => { try { win.close(); } catch (e) {} resolve({ error: "timeout" }); }, 60000);
    win.webContents.on("page-title-updated", (e, title) => {
      if (!title.startsWith("R")) return;
      clearTimeout(t);
      let res;
      try { res = JSON.parse(title.slice(1)); } catch (e) { res = { error: "bad title" }; }
      try { win.close(); } catch (e) {}
      resolve(res);
    });
    win.loadFile(f);
  });
}

async function main() {
  // 1. baseline: no fingerprint config -> stock adapter values
  const base = await probeWith({});
  if (base.error) {
    console.log("SKIP: WebGPU unavailable in this environment (" + base.error + ")");
    app.exit(0);
    return;
  }
  check("baseline adapter reachable", base.featureCount > 0, "features=" + base.featureCount);

  // 2. webgpu_features REPLACE: configured list becomes the entire set
  const want = ["shader-f16", "timestamp-query", "depth-clip-control"];
  const r1 = await probeWith({ webgpu_features: want.join(",") });
  check("webgpu_features REPLACE",
    JSON.stringify(r1.features) === JSON.stringify([...want].sort()),
    "got " + JSON.stringify(r1.features));
  check("REPLACE shrinks the real set",
    r1.featureCount === 3 && base.featureCount !== 3,
    "base=" + base.featureCount + " -> " + r1.featureCount);

  // 3. unknown feature names are dropped, not exposed
  const r2 = await probeWith({ webgpu_features: "shader-f16,totally-fake-feature" });
  check("unknown feature name dropped",
    JSON.stringify(r2.features) === JSON.stringify(["shader-f16"]),
    "got " + JSON.stringify(r2.features));

  // 4. webgpu_limits MERGE: configured keys override
  const r3 = await probeWith({ webgpu_limits: "{maxTextureDimension2D:4096,maxBindGroups:2}" });
  check("webgpu_limits MERGE overrides maxTextureDimension2D",
    String(r3.maxTextureDimension2D) === "4096", "got " + r3.maxTextureDimension2D);
  check("webgpu_limits MERGE overrides maxBindGroups",
    String(r3.maxBindGroups) === "2", "got " + r3.maxBindGroups);

  // 5. MERGE leaves unconfigured limits at their real values
  const r4 = await probeWith({ webgpu_limits: "{maxTextureDimension2D:4096}" });
  check("MERGE preserves unconfigured maxBindGroups",
    String(r4.maxBindGroups) === String(base.maxBindGroups),
    "base=" + base.maxBindGroups + " got=" + r4.maxBindGroups);
  check("MERGE preserves unconfigured maxBufferSize",
    String(r4.maxBufferSize) === String(base.maxBufferSize),
    "base=" + base.maxBufferSize + " got=" + r4.maxBufferSize);

  // 6. oversized values clamp to uint32 instead of overflowing
  const r5 = await probeWith({ webgpu_limits: "{maxBindGroups:99999999999}" });
  check("oversized limit clamps to uint32",
    String(r5.maxBindGroups) === "4294967295", "got " + r5.maxBindGroups);

  // 7. empty config = no intervention
  const r6 = await probeWith({ webgpu_features: "", webgpu_limits: "" });
  check("empty config leaves features stock",
    r6.featureCount === base.featureCount,
    "base=" + base.featureCount + " got=" + r6.featureCount);

  console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURE(S)");
  app.exit(failures === 0 ? 0 : 1);
}

app.whenReady().then(main);
