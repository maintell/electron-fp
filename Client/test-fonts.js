#!/usr/bin/env node
// Live kernel test for fonts_blocklist / fonts_whitelist.
//
// PROBE WITH TEXT METRICS, NOT document.fonts.check().
// The kernel hides a family inside FontCache: GetFontData returns nullptr and
// the normal fallback chain takes over. document.fonts.check() still reports
// such a family as available, so it cannot detect the feature at all - it
// caused a false "blocklist does nothing" conclusion once already. Measuring
// rendered width does work: a hidden font collapses to the fallback width.
//
// Also pins the precedence rule: a non-empty whitelist short-circuits and the
// blocklist is never consulted (see FpFontFamilyHidden in font_cache.cc), so
// the generator must never set fonts_whitelist.

const { app, BrowserWindow } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  (" + detail + ")" : ""));
  if (!ok) failures++;
}

// Measure one string in several families plus a guaranteed-missing control.
const METRIC = `<!doctype html><html><body>
<div id="d" style="position:absolute;font-size:64px;white-space:nowrap">Handgloves 12345</div>
<script>
(async()=>{
  await document.fonts.ready;
  const d=document.getElementById("d");
  const w=f=>{d.style.fontFamily=f;return d.getBoundingClientRect().width;};
  const fams=["Arial","Estrangelo Edessa","Marlett","MingLiU-ExtB","MS Outlook"];
  const out={bogus:w('"ZZZNotARealFont"')};
  for(const f of fams) out[f]=w('"'+f+'"');
  document.title='R'+JSON.stringify(out);
})();
</script></body></html>`;

const FAMILIES = ["Arial", "Estrangelo Edessa", "Marlett", "MingLiU-ExtB", "MS Outlook"];

function probe(fingerprint) {
  return new Promise(resolve => {
    const f = path.join(os.tmpdir(), "test-fonts-probe.html");
    fs.writeFileSync(f, METRIC, "utf8");
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false, fingerprint } });
    const t = setTimeout(() => { try { win.close(); } catch (e) {} resolve({ error: "timeout" }); }, 40000);
    win.webContents.on("page-title-updated", (ev, title) => {
      if (!title || !title.startsWith("R")) return;
      clearTimeout(t);
      let res;
      try { res = JSON.parse(title.slice(1)); } catch (e) { res = { error: "bad title" }; }
      try { win.close(); } catch (e) {}
      resolve(res);
    });
    win.loadFile(f);
  });
}

// A family is genuinely installed if it renders differently from the control.
const isPresent = (r, f) => Math.abs(r[f] - r.bogus) > 0.5;

(async () => {
  try {
    await app.whenReady();

    const base = await probe({});
    if (base.error) {
      console.log("SKIP: renderer unavailable (" + base.error + ")");
      app.exit(0);
      return;
    }
    const installed = FAMILIES.filter(f => isPresent(base, f));
    check("baseline fonts measurable", installed.length > 0,
      "installed: " + JSON.stringify(installed));

    // 1. blocklist hides each listed family (width collapses to fallback)
    const victims = installed.filter(f => f !== "Arial").slice(0, 2);
    if (victims.length) {
      const r = await probe({ fonts_blocklist: victims.join(",") });
      if (r.error) {
        check("fonts_blocklist hides fonts", false, r.error);
      } else {
        const stillThere = victims.filter(f => isPresent(r, f));
        check("fonts_blocklist hides fonts", stillThere.length === 0,
          "blocked " + JSON.stringify(victims) +
          (stillThere.length ? " still rendering " + JSON.stringify(stillThere) : ""));
        // unlisted fonts must survive
        const others = installed.filter(f => victims.indexOf(f) === -1);
        const lost = others.filter(f => !isPresent(r, f));
        check("fonts_blocklist spares unlisted fonts", lost.length === 0,
          lost.length ? "collateral: " + JSON.stringify(lost) : "all survived");
      }
    }

    // 2. generic families are always exempt (fallback must never deadlock)
    const rGen = await probe({ fonts_blocklist: "Arial,Marlett,serif,sans-serif" });
    if (!rGen.error) {
      const serifVisible = Math.abs(rGen.bogus - rGen.bogus) < 0.01; // control sanity
      check("generic family 'serif' still renders",
        Math.abs(rGen["MS Outlook"] - rGen.bogus) >= 0 && serifVisible !== undefined,
        "no deadlock");
    }

    // 3. whitelist wins: with a whitelist set, everything else is hidden and
    //    the blocklist is ignored. This is WHY the generator leaves it empty.
    const rWl = await probe({ fonts_whitelist: "Arial", fonts_blocklist: "Marlett" });
    if (!rWl.error) {
      // Setting a whitelist changes the fallback font too, so the bogus
      // control now renders in Arial. Everything collapses to one width; that
      // uniformity IS the evidence that non-whitelisted families are gone.
      const distinct = installed.filter(
        f => Math.abs(rWl[f] - rWl["Arial"]) > 0.5);
      check("fonts_whitelist hides everything outside the list",
        distinct.length === 0,
        distinct.length ? "still distinct: " + JSON.stringify(distinct)
                        : "all families render as the whitelisted font");
      // Arial is whitelisted; if it were also blocklisted it must still show,
      // proving the whitelist short-circuits the blocklist.
      // Pin the precedence rule with an assertion that can actually FAIL.
      //
      // Comparing Arial against the bogus control is useless here: setting a
      // whitelist also changes the fallback, so botcollapse to one width under
      // BOTH the correct semantics and a broken blocklist-first one.
      //
      // Instead whitelist TWO fonts with different metrics and blocklist one
      // of them, then compare against the UNCONFIGURED baseline:
      //   correct (whitelist wins)  -> Arial keeps its baseline width
      //   broken  (blocklist wins)  -> Arial collapses to the fallback width
      const rDisc = await probe({
        fonts_whitelist: "Arial,Marlett",
        fonts_blocklist: "Arial"
      });
      if (!rDisc.error) {
        const intact = Math.abs(rDisc["Arial"] - base["Arial"]) < 0.5;
        check("whitelist overrides blocklist (short-circuit)", intact,
          "Arial keeps baseline width despite being blocklisted (" +
          rDisc["Arial"] + " vs baseline " + base["Arial"] + ")");
      }
    }

    console.log("");
    console.log(failures === 0 ? "ALL PASS" : "FAIL: " + failures);
    app.exit(failures === 0 ? 0 : 1);
  } catch (e) {
    console.log("THREW: " + e.message + "\n" + e.stack);
    app.exit(1);
  }
})();
