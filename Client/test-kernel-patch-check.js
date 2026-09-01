// Run the kernel's own patch gate: fingerprint/scripts/check.py.
//
// This file exists because check.py was FAILING while the whole client suite
// was green. It is a Python script living outside Client/, so run-tests.js's
// "spawn electron on every test-*.js" loop never touched it. The three keys
// added for the browserleaks/creepjs leak fix went into the monolith patch,
// which check.py deliberately ignores whenever the split set exists - so the
// kernel gate had been reporting "missing config keys" across two commits
// without anything noticing.
//
// check.py verifies things no JS test can:
//   * every EXPECTED_KEY appears in the ACTUAL DELIVERY artifact (the split
//     patches that apply.py uses, not the monolith)
//   * each key is read by an added code line (declared but unimplemented)
//   * no debug residue
//   * INTEGRATION.md stays in sync with the key set
//
// Runs under plain node (no electron needed) so it can also be invoked
// directly: node Client/test-kernel-patch-check.js
"use strict";

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const REPO = path.resolve(__dirname, "..");
const CHECK = path.join(REPO, "fingerprint", "scripts", "check.py");

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  (" + d + ")" : ""));
  ok ? pass++ : fail++;
};

if (!fs.existsSync(CHECK)) {
  console.log("SKIP  check.py not found at " + CHECK);
  console.log("PASS: 0 checks");
  process.exit(0);
}

let out = "", code = 1;
// Try python, then python3 - the interpreter name is not stable across setups.
for (const py of ["python", "python3"]) {
  const r = spawnSync(py, [CHECK], { encoding: "utf8", cwd: REPO });
  // A missing interpreter yields ENOENT, not a non-zero exit code.
  if (r.error && r.error.code === "ENOENT") continue;
  out = (r.stdout || "") + (r.stderr || "");
  code = r.status === null ? 1 : r.status;
  break;
}

ck("check.py runs", out.trim().length > 0, out.split("\n")[0] || "no output");
ck("check.py exits 0", code === 0, "exit=" + code);
ck("check.py reports all 63 keys", /63 keys/.test(out),
  (out.match(/\d+ keys/) || ["?"])[0]);

if (code !== 0) {
  console.log("");
  console.log("--- check.py output ---");
  console.log(out.trim());
  console.log("-----------------------");
}

console.log("");
console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " of " + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
