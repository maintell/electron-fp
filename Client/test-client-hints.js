// Client hints (Sec-CH-UA) must agree with the UA.
//
// navigator.userAgentData and the Sec-CH-UA* request headers are a SECOND
// identity surface, and Chromium does NOT derive them from navigator.userAgent:
// it keeps its own brand list. Before this was fixed, a Mac UA override left
// both announcing real Chromium on real Windows - a trivially detectable
// contradiction that makes UA spoofing worse than useless.
//
// The two surfaces are produced by DIFFERENT code paths, so both are tested
// separately: NavigatorBase::GetUserAgentMetadata() feeds navigator.userAgentData,
// and LocalFrameClientImpl::UserAgentMetadata() feeds the request headers.
// Fixing only one silently leaves the other leaking.
const { app, BrowserWindow, BrowserView, session } = require("electron");
const http = require("http");

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log("PASS  " + n + (d ? ": " + d : "")); pass++; }
  else { console.log("FAIL  " + n + (d ? ": " + d : "")); fail++; }
};

let url = "";
const seen = [];

function startServer() {
  return new Promise(res => {
    const s = http.createServer((req, res) => {
      const h = {};
      for (const k of Object.keys(req.headers)) {
        if (/^sec-ch-ua/i.test(k)) h[k] = req.headers[k];
      }
      seen.push({ ua: req.headers["user-agent"] || "", hints: h });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hints: h, ua: req.headers["user-agent"] || "" }));
    });
    s.listen(0, "127.0.0.1", () => {
      url = "http://127.0.0.1:" + s.address().port + "/hints";
      res(url);
    });
  });
}

function openView(partition, fp) {
  return new BrowserView({
    webPreferences: { partition, sandbox: false, ...(fp ? { fingerprint: fp } : {}) }
  });
}

async function probe(view, u) {
  await view.webContents.loadURL(u);
  const r = await view.webContents.executeJavaScript(
    `fetch(${JSON.stringify(u)},{cache:"no-store"}).then(r=>r.json())`);
  const uad = await view.webContents.executeJavaScript(`(function(){
    var d = navigator.userAgentData;
    if (!d) return null;
    return { platform: d.platform, mobile: d.mobile,
             brands: (d.brands||[]).map(function(b){return b.brand+";v="+b.version;}) };
  })()`);
  return { hints: r.hints, ua: r.ua, uad };
}

(async () => {
  try {
    await startServer();
    await app.whenReady();
    const win = new BrowserWindow({ show: false, width: 300, height: 200 });

    // 1) Baseline: no config at all must stay stock (zero-intervention rule).
    const v0 = openView("ch-t0", null);
    win.addBrowserView(v0);
    const r0 = await probe(v0, url);
    check("baseline UA is the native one", r0.ua.includes("Windows"), String(r0.ua).slice(0, 40));
    check("baseline hints report the real platform", r0.hints["sec-ch-ua-platform"] === '"Windows"',
      String(r0.hints["sec-ch-ua-platform"]));

    // 2) A Mac UA must carry Mac hints on BOTH surfaces. This is the whole point
    // of the feature: the two must not disagree.
    const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
    const p2 = "ch-t2";
    session.fromPartition(p2).setUserAgent(MAC_UA);
    const v2 = openView(p2, { navigator_platform: "MacIntel" });
    win.addBrowserView(v2);
    const r2 = await probe(v2, url);
    check("header: Sec-CH-UA-Platform follows the Mac UA",
      r2.hints["sec-ch-ua-platform"] === '"macOS"',
      String(r2.hints["sec-ch-ua-platform"]));
    check("header: Sec-CH-UA no longer claims Chromium",
      !/Chromium/.test(String(r2.hints["sec-ch-ua"])), String(r2.hints["sec-ch-ua"]));
    check("JS: userAgentData.platform follows the Mac UA",
      r2.uad && r2.uad.platform === "macOS", r2.uad ? r2.uad.platform : "null");
    check("JS: userAgentData brands are Safari, not Chromium",
      r2.uad && r2.uad.brands.join(" ").indexOf("Chromium") === -1,
      r2.uad ? r2.uad.brands.join(" ") : "null");
    // The vocabulary differs: navigator.platform says "MacIntel", Sec-CH-UA
    // says "macOS". Both must be right - they are different surfaces.
    check("JS and header agree with each other",
      r2.uad && r2.uad.platform === "macOS" &&
      r2.hints["sec-ch-ua-platform"] === '"macOS"');

    // 3) An Android UA must report mobile=true on both surfaces.
    const AND_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
    const p3 = "ch-t3";
    session.fromPartition(p3).setUserAgent(AND_UA);
    const v3 = openView(p3, { navigator_platform: "Linux armv8l" });
    win.addBrowserView(v3);
    const r3 = await probe(v3, url);
    check("header: Sec-CH-UA-Mobile is ?1 for Android",
      r3.hints["sec-ch-ua-mobile"] === "?1", String(r3.hints["sec-ch-ua-mobile"]));
    check("header: Sec-CH-UA-Platform is Android",
      r3.hints["sec-ch-ua-platform"] === '"Android"', String(r3.hints["sec-ch-ua-platform"]));
    check("JS: userAgentData.mobile is true for Android",
      r3.uad && r3.uad.mobile === true, r3.uad ? String(r3.uad.mobile) : "null");

    // 4) Explicit ua_* keys must win over the derivation.
    const p4 = "ch-t4";
    session.fromPartition(p4).setUserAgent(MAC_UA);
    const v4 = openView(p4, {
      navigator_platform: "MacIntel",
      ua_platform: "PlayStation",
      ua_mobile: "true",
      // Quote-free on purpose: FpConfigString() truncates at the first closing
      // quote (the same trap that forces webgpu_limits to use unquoted keys),
      // so a brand list full of quotes would arrive empty.
      ua_brands: "Not A(Brand)=99, Chromium=131"
    });
    win.addBrowserView(v4);
    const r4 = await probe(v4, url);
    check("explicit ua_platform overrides the derived value",
      r4.hints["sec-ch-ua-platform"] === '"PlayStation"',
      String(r4.hints["sec-ch-ua-platform"]));
    check("explicit ua_mobile overrides the derived value",
      r4.hints["sec-ch-ua-mobile"] === "?1", String(r4.hints["sec-ch-ua-mobile"]));
    check("explicit ua_brands is parsed (quotes stripped)",
      r4.uad && r4.uad.brands.some(b => b.indexOf("Chromium") === 0 && b === "Chromium;v=131"),
      r4.uad ? r4.uad.brands.join(" | ") : "null");

    // 5) Isolation: a second partition with no UA must stay stock, proving the
    // override did not leak into the process-wide metadata.
    const v5 = openView("ch-t5", null);
    win.addBrowserView(v5);
    const r5 = await probe(v5, url);
    check("a separate partition is unaffected",
      r5.hints["sec-ch-ua-platform"] === '"Windows"',
      String(r5.hints["sec-ch-ua-platform"]));

    // 6) The kernel is a pure function of the config: explicit ua_* must work
    // with NO userAgent set at all. Consistency between the UA and the hints is
    // the APPLICATION layer's concern (main.js derives navigator_platform from
    // the UA); the kernel must not require a UA to honour an explicit override.
    const v6 = openView("ch-t6", {
      ua_platform: "Plan9", ua_mobile: "true", ua_brands: "AcmeBrowser=42"
    });
    win.addBrowserView(v6);
    const r6 = await probe(v6, url);
    check("explicit ua_platform with NO userAgent set",
      r6.hints["sec-ch-ua-platform"] === '"Plan9"',
      String(r6.hints["sec-ch-ua-platform"]));
    check("explicit ua_mobile with NO userAgent set",
      r6.hints["sec-ch-ua-mobile"] === "?1", String(r6.hints["sec-ch-ua-mobile"]));
    check("explicit ua_brands with NO userAgent set",
      r6.uad && r6.uad.brands.some(b => b === "AcmeBrowser;v=42"),
      r6.uad ? r6.uad.brands.join(" | ") : "null");

    console.log("");
    console.log(fail === 0 ? "PASS: " + pass + " checks" : "FAIL: " + fail + " of " + (pass + fail));
    app.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.log("THREW " + e.message + "\n" + e.stack);
    app.exit(1);
  }
})();
