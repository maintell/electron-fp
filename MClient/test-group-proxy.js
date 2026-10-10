#!/usr/bin/env node
// Verify single-profile (per-group) proxy: the fourth plane beside Blink/TLS/H2.
//
// What is verified here, and why each needs the live Electron session API:
//   1. fixed_servers with proxyRules reaches the resolver: resolveProxy() on
//      the group's partition reports the configured proxy (no network needed,
//      resolution is local evaluation, so 127.0.0.1:9 never gets dialed).
//   2. Empty proxyRules is REFUSED by validation ({ok:false}), never handed to
//      setProxy: an empty rule would silently mean "direct" while the profile
//      claims a proxy — the same "claims a fingerprint it does not produce"
//      failure class as the TLS plane.
//   3. direct mode resolves without the proxy (set-then-cleared on one
//      partition, so the check is not vacuous).
//   4. The password never enters group.proxy: normalizeGroupProxy() strips it
//      to a side channel (memory-only group.proxyPassword in main.js).
//
// Runs through the REAL main.js helpers (MCLIENT_LIB_MODE=1 require keeps the
// full client from booting), not a copy of the logic.
"use strict";

process.env.MCLIENT_LIB_MODE = "1";
// Isolate password persistence from the real appData (fake creds anyway).
process.env.MCLIENT_PROXY_DIR = require("os").tmpdir() + "/mclient-proxy-test-" + process.pid;
const http = require("http");
const fs = require("fs");
const path = require("path");
const { app, session, safeStorage } = require("electron");
const main = require("./main");
const { normalizeGroupProxy, applyGroupProxy } = main;

let pass = 0, fail = 0, skipped = 0;
function check(name, ok, detail) {
  if (ok) { console.log("PASS  " + name + (detail ? ": " + detail : "")); pass++; }
  else { console.log("FAIL  " + name + (detail ? ": " + detail : "")); fail++; }
}
function skip(name, why) {
  console.log("SKIP  " + name + (why ? ": " + why : "")); skipped++;
}

// Local AUTHENTICATING forward proxy (~40 lines). Chromium sends absolute-form
// GETs; without Proxy-Authorization we 407 with a Basic challenge, with the
// right creds we answer 200 directly (no upstream dialing — fully offline).
// Fake credentials only: testuser:testpass.
function startAuthProxy(user, pass, marker) {
  return new Promise((resolve) => {
    const expected = "Basic " + Buffer.from(user + ":" + pass).toString("base64");
    const seen = { challenges: 0, authed: 0 };
    const srv = http.createServer((req, res) => {
      if (req.headers["proxy-authorization"] !== expected) {
        seen.challenges++;
        res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="mclient-test"' });
        res.end();
        return;
      }
      seen.authed++;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(marker);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, port: srv.address().port }));
  });
}

(async () => {
  try {
    await app.whenReady();

    // --- 1. fixed proxy reaches the resolver on the group's partition ---
    // NOTE: Chromium proxy rules are scheme-scoped with NO fallback: a rule
    // written as `http=host` never covers https:// URLs (measured below), so
    // the resolving rule names both schemes. The 127.0.0.1:9 marker itself is
    // never dialed — resolveProxy() is local evaluation.
    {
      const group = { id: "px-fixed", proxy: { mode: "fixed", proxyRules: "http=127.0.0.1:9;https=127.0.0.1:9" } };
      const res = await applyGroupProxy(group);
      check("fixed proxy applies ok", res && res.ok === true, JSON.stringify(res));
      const resolved = await session.fromPartition("fp-group-px-fixed").resolveProxy("https://example.com/");
      check("resolveProxy reports 127.0.0.1:9", typeof resolved === "string" && resolved.includes("127.0.0.1:9"), resolved);
    }

    // --- 1b. scheme scoping is Chromium behavior, not our bug ---
    {
      const group = { id: "px-scheme", proxy: { mode: "fixed", proxyRules: "http=127.0.0.1:9" } };
      await applyGroupProxy(group);
      const sess = session.fromPartition("fp-group-px-scheme");
      const httpsOut = await sess.resolveProxy("https://example.com/");
      const httpOut = await sess.resolveProxy("http://example.com/");
      check("http-only rule does not cover https (Chromium scoping)", httpsOut === "DIRECT", httpsOut);
      check("http-only rule covers http", httpOut.includes("127.0.0.1:9"), httpOut);
    }

    // --- 2. empty proxyRules is refused, never applied ---
    {
      const norm = normalizeGroupProxy({ mode: "fixed", proxyRules: "" });
      check("empty proxyRules rejected by validation", !!(norm && norm.error && norm.error.includes("proxyRules")), norm && (norm.error || "no-error"));
      const res = await applyGroupProxy({ id: "px-empty", proxy: { mode: "fixed", proxyRules: "   " } });
      check("empty proxyRules not applied", !!(res && res.ok === false && /proxyRules/.test(res.error || "")), JSON.stringify(res));
    }

    // --- 3. direct clears a previously set proxy on the same partition ---
    {
      const group = { id: "px-direct", proxy: { mode: "fixed", proxyRules: "http=127.0.0.1:9;https=127.0.0.1:9" } };
      await applyGroupProxy(group);
      const before = await session.fromPartition("fp-group-px-direct").resolveProxy("https://example.com/");
      group.proxy = { mode: "direct" };
      const res = await applyGroupProxy(group);
      const after = await session.fromPartition("fp-group-px-direct").resolveProxy("https://example.com/");
      check("direct applies ok", res && res.ok === true, JSON.stringify(res));
      check("direct resolveProxy drops the proxy",
        before.includes("127.0.0.1:9") && !after.includes("127.0.0.1:9"), "before=" + before + " after=" + after);
    }

    // --- 4. password is memory-only: stripped out of group.proxy ---
    {
      const norm = normalizeGroupProxy({ mode: "fixed", proxyRules: "http=127.0.0.1:9", username: "u", password: "s3cr3t" });
      check("password travels beside proxy, not inside",
        !!(norm && norm.proxy && !("password" in norm.proxy) && norm.password === "s3cr3t"),
        norm && JSON.stringify({ keys: norm.proxy && Object.keys(norm.proxy), hasSidePassword: norm.password === "s3cr3t" }));
    }

    // --- 5. other modes validate the same way ---
    {
      const pacEmpty = normalizeGroupProxy({ mode: "pac", pacScript: "" });
      check("empty pacScript refused", !!(pacEmpty && pacEmpty.error && pacEmpty.error.includes("pacScript")), pacEmpty && (pacEmpty.error || "no-error"));
      const badMode = normalizeGroupProxy({ mode: "socks" });
      check("unknown mode refused", !!(badMode && badMode.error && badMode.error.includes("mode")), badMode && (badMode.error || "no-error"));
      const cleared = normalizeGroupProxy(null);
      check("null clears proxy", !!(cleared && cleared.proxy === null && cleared.password === null));
    }

    // --- 6. pasted full URLs split into rules + memory-only creds ---
    // Fake credentials on loopback only (resolveProxy never dials).
    {
      const full = normalizeGroupProxy({ mode: "fixed", proxyRules: "http://user123:pass456@localhost:9999/" });
      check("full URL splits to scheme rule",
        !!(full && full.proxy && full.proxy.proxyRules === "http=localhost:9999"), full && JSON.stringify(full.proxy));
      check("full URL creds travel beside proxy",
        !!(full && full.proxy && !("password" in full.proxy) && full.proxy.username === "user123" && full.password === "pass456"),
        full && ("user=" + full.proxy.username + " pass-set=" + (full.password === "pass456")));
      const upper = normalizeGroupProxy({ mode: "fixed", proxyRules: "HTTP://user123:pass456@localhost:9999/" });
      check("uppercase scheme normalized", !!(upper && upper.proxy && upper.proxy.proxyRules === "http=localhost:9999"), upper && upper.proxy.proxyRules);
      const noCreds = normalizeGroupProxy({ mode: "fixed", proxyRules: "http://localhost:9999/" });
      check("credless URL still splits to a working rule",
        !!(noCreds && noCreds.proxy && noCreds.proxy.proxyRules === "http=localhost:9999" && noCreds.password === null));
      const explicit = normalizeGroupProxy({ mode: "fixed", proxyRules: "http://user123:pass456@localhost:9999/", username: "explicit", password: "explicit-pw" });
      check("explicit fields win over URL-embedded",
        !!(explicit && explicit.proxy.username === "explicit" && explicit.password === "explicit-pw"), explicit && explicit.proxy.username);
      const encoded = normalizeGroupProxy({ mode: "fixed", proxyRules: "http://user123:p%40ss@localhost:9999/" });
      check("percent-encoded password decodes", !!(encoded && encoded.password === "p@ss"), encoded && encoded.password);
      const legacy1 = normalizeGroupProxy({ mode: "fixed", proxyRules: "http=127.0.0.1:9" });
      const legacy2 = normalizeGroupProxy({ mode: "fixed", proxyRules: "127.0.0.1:9" });
      check("legacy rules pass through byte-identical",
        !!(legacy1.proxy.proxyRules === "http=127.0.0.1:9" && legacy2.proxy.proxyRules === "127.0.0.1:9"));
      // End to end: the split product actually routes on a live session.
      const group = { id: "px-split", proxy: full.proxy };
      const res = await applyGroupProxy(group);
      const resolved = await session.fromPartition("fp-group-px-split").resolveProxy("http://example.com/");
      check("split rules resolve on session", !!(res && res.ok && resolved.includes("localhost:9999")), resolved);
    }

    // --- 7. mode auto-upgrade (paste-and-go) ---
    {
      const up = normalizeGroupProxy({ mode: "direct", proxyRules: "http=127.0.0.1:9" });
      check("direct+rules upgrades to fixed",
        !!(up && up.proxy && up.proxy.mode === "fixed" && up.note && up.note.includes("fixed")), up && (up.proxy.mode + " / " + up.note));
      const upUrl = normalizeGroupProxy({ mode: "system", proxyRules: "http://user123:pass456@localhost:9999/" });
      check("system+URL upgrades with split creds",
        !!(upUrl && upUrl.proxy && upUrl.proxy.mode === "fixed" && upUrl.proxy.proxyRules === "http=localhost:9999" && upUrl.password === "pass456"), upUrl && upUrl.proxy.mode);
      const upPac = normalizeGroupProxy({ mode: "direct", pacScript: 'function FindProxyForURL(){return "DIRECT";}' });
      check("direct+pacScript upgrades to pac",
        !!(upPac && upPac.proxy && upPac.proxy.mode === "pac" && upPac.note && upPac.note.includes("pac")), upPac && upPac.proxy.mode);
      const bare = normalizeGroupProxy({ mode: "direct" });
      check("bare direct truly clears", !!(bare && bare.proxy === null), JSON.stringify(bare));
    }

    // --- 8. end to end through a real 407 (production login handler) ---
    // Full user path: normalize -> setGroupProxy -> navigate tab -> proxy 407s
    // -> app.on('login') answers from group memory -> page loads.
    const proxies = [];
    {
      const { srv, seen, port } = await startAuthProxy("testuser", "testpass", "PROXY-E2E-OK");
      proxies.push(srv);
      const rules = `http=127.0.0.1:${port};https=127.0.0.1:${port}`;
      const gid = await main.addGroup("default");
      const set = await main.setGroupProxy(gid, { mode: "fixed", proxyRules: rules, username: "testuser", password: "testpass" });
      check("e2e proxy set ok", set && set.ok === true, JSON.stringify(set));
      const tab = main.tabs.get(main.groups.get(gid).tabIds[0]);
      await tab.view.webContents.loadURL("http://example.com/");
      const body = await tab.view.webContents.executeJavaScript("document.body.innerText");
      check("e2e correct creds load through proxy",
        seen.challenges > 0 && String(body).includes("PROXY-E2E-OK"),
        "challenges=" + seen.challenges + " body=" + String(body).slice(0, 40));
      try { tab.view.webContents.destroy(); } catch (_) {}
    }

    // --- 9. wrong password fails the load (no silent direct fallback) ---
    {
      const { srv, port } = await startAuthProxy("testuser", "testpass", "PROXY-E2E-OK");
      proxies.push(srv);
      const rules = `http=127.0.0.1:${port};https=127.0.0.1:${port}`;
      const gid = await main.addGroup("default");
      await main.setGroupProxy(gid, { mode: "fixed", proxyRules: rules, username: "testuser", password: "wrongpass" });
      const tab = main.tabs.get(main.groups.get(gid).tabIds[0]);
      const failed = await new Promise((resolve) => {
        tab.view.webContents.once("did-fail-load", () => resolve(true));
        setTimeout(() => resolve(false), 10000);
        tab.view.webContents.loadURL("http://example.com/").catch(() => {});
      });
      let body = "";
      try { body = await tab.view.webContents.executeJavaScript("document.body.innerText"); } catch (_) {}
      check("e2e wrong password fails load", failed === true && !String(body).includes("PROXY-E2E-OK"), "failed=" + failed);
      try { tab.view.webContents.destroy(); } catch (_) {}
    }

    // --- 10. password persistence roundtrip (safeStorage) ---
    if (!safeStorage.isEncryptionAvailable()) {
      skip("proxy password persistence", "safeStorage unavailable here");
      skip("clear deletes saved password", "safeStorage unavailable here");
      skip("empty password retains stored", "safeStorage unavailable here");
    } else {
      check("password file lands per origin profile",
        main.saveGroupPassword("test-prof-x", "pw-x").ok === true &&
        fs.existsSync(path.join(process.env.MCLIENT_PROXY_DIR, "proxy-test-prof-x.bin")));
      check("password roundtrips", main.loadGroupPassword("test-prof-x") === "pw-x");
      main.deleteGroupPassword("test-prof-x");
      check("deleted password reads null",
        main.loadGroupPassword("test-prof-x") === null &&
        !fs.existsSync(path.join(process.env.MCLIENT_PROXY_DIR, "proxy-test-prof-x.bin")));

      // Clear via bare direct deletes the saved password too.
      const gid = await main.addGroup("default");
      const g = main.groups.get(gid);
      await main.setGroupProxy(gid, { mode: "fixed", proxyRules: "http=127.0.0.1:9", username: "u", password: "pw-c" });
      const savedBefore = fs.existsSync(path.join(process.env.MCLIENT_PROXY_DIR, "proxy-" + g.originProfileId + ".bin"));
      const clr = await main.setGroupProxy(gid, { mode: "direct" });
      const sessAfter = await session.fromPartition("fp-group-" + gid).resolveProxy("http://example.com/");
      check("clear deletes saved password",
        !!(clr && clr.ok === true && main.getGroupProxy(gid) === null && savedBefore &&
          !fs.existsSync(path.join(process.env.MCLIENT_PROXY_DIR, "proxy-" + g.originProfileId + ".bin"))),
        JSON.stringify(clr));
      check("cleared session resolves direct", sessAfter === "DIRECT", sessAfter);

      // Empty password keeps the stored one (memory + disk untouched).
      const gid2 = await main.addGroup("default");
      await main.setGroupProxy(gid2, { mode: "fixed", proxyRules: "http=127.0.0.1:9", username: "u", password: "keepme" });
      await main.setGroupProxy(gid2, { mode: "fixed", proxyRules: "http=127.0.0.1:9", username: "u" });
      const g2 = main.groups.get(gid2);
      check("empty password retains stored",
        !!(g2.proxyPassword === "keepme" && main.loadGroupPassword(g2.originProfileId) === "keepme"));
      main.deleteGroupPassword(g2.originProfileId);
    }

    for (const s of proxies) { try { s.close(); } catch (_) {} }
    try { fs.rmSync(process.env.MCLIENT_PROXY_DIR, { recursive: true, force: true }); } catch (_) {}

    console.log("");
    console.log(fail === 0 ? `PASS: ${pass} checks${skipped ? ` (${skipped} skipped)` : ""}` : `FAIL: ${fail} of ${pass + fail} checks`);
    app.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.log("FAIL  threw: " + e.message);
    console.log(e.stack);
    app.exit(1);
  }
})();
