// Copyright (c) 2026 Microsoft, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE.

// The fingerprint Inspector page, as string constants.
//
// Kept in C++ rather than as standalone .html/.js files loaded at runtime:
// the page is served by FingerprintDataSource straight from these constants,
// so there is no packaging step and no way for the page to be missing or
// out of sync with the build that serves it. A diagnostic page that silently
// fails to load is indistinguishable from one that reports "all clean".
//
// NOTE: `);` appearing at the start of a line inside a raw string literal ends
// the literal. None of the embedded JS may contain that sequence.

#ifndef ELECTRON_SHELL_BROWSER_UI_WEBUI_FINGERPRINT_UI_PAGE_H_
#define ELECTRON_SHELL_BROWSER_UI_WEBUI_FINGERPRINT_UI_PAGE_H_

#include <string_view>

namespace electron {

inline constexpr std::string_view kFingerprintUiHtml = R"FPHTML(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fingerprint Inspector</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 13px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif;
    margin: 0; padding: 24px; max-width: 1100px;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 24px 0 8px; text-transform: uppercase;
       letter-spacing: .04em; opacity: .6; }
  .sub { opacity: .65; margin: 0 0 20px; }
  .url { font-family: ui-monospace, monospace; opacity: .8; }
  .card { border: 1px solid rgba(127,127,127,.35); border-radius: 8px;
          padding: 14px 16px; margin-bottom: 12px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: 4px 10px 4px 0; vertical-align: top; }
  th { opacity: .6; font-weight: 600; }
  .bar { background: rgba(127,127,127,.25); border-radius: 3px;
         height: 8px; width: 120px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: #3b82f6; }
  .ok { color: #15803d; } .warn { color: #b45309; } .err { color: #b91c1c; }
  .muted { opacity: .55; }
  code { font-family: ui-monospace, monospace; font-size: 12px; }
  .finding { padding: 6px 0; border-top: 1px solid rgba(127,127,127,.2); }
  .finding:first-child { border-top: 0; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 10px;
          font-size: 11px; font-weight: 600; }
  .pill.error { background: #fee2e2; color: #b91c1c; }
  .pill.warn  { background: #fef3c7; color: #b45309; }
  .pill.skip  { background: rgba(127,127,127,.18); opacity: .7; }
  #status { padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; }
  ul { margin: 6px 0 0; padding-left: 20px; }
</style>
</head>
<body>
  <h1>Fingerprint Inspector</h1>
  <p class="sub">
    Per-group coverage and cross-layer consistency for the active profile.
    Served from <span class="url">electron://fingerprint</span>.
  </p>

  <div id="status">Loading&hellip;</div>

  <h2>Summary</h2>
  <div class="card"><table id="summary"></table></div>

  <h2>Coverage by group</h2>
  <div class="card"><table id="coverage"></table></div>

  <h2>Cross-layer consistency</h2>
  <div class="card">
    <div id="consistency"></div>
  </div>

  <h2>Notes</h2>
  <div class="card">
    <ul class="muted">
      <li><code>skipped</code> rules could not evaluate (their inputs are not
          set). They are reported, not hidden &mdash; a rule that quietly passes
          on missing input proves nothing.</li>
      <li>An <span class="err">error</span> means the profile contradicts
          itself, which is more detectable than not spoofing at all.</li>
      <li>The UA anchors these checks: every other surface is compared against
          what the UA implies.</li>
    </ul>
  </div>

  <script>__FP_DATA__</script>
</body>
</html>
)FPHTML";

// Marker inside kFingerprintUiHtml that gets replaced with the inlined script.
// See FingerprintDataSource::StartDataRequest for why the page is self-contained.
inline constexpr std::string_view kFingerprintUiDataMarker = "__FP_DATA__";

inline constexpr std::string_view kFingerprintUiAppJs = R"FPJS(
'use strict';

// The page renders whatever the browser process hands it. It deliberately does
// NO fingerprinting of its own: reading navigator/screen here would measure the
// privileged WebUI renderer rather than the profile under inspection, and
// reporting that as "the fingerprint" would be actively misleading.

const el = (id) => document.getElementById(id);

function setStatus(text, cls) {
  const s = el('status');
  s.textContent = text;
  s.className = cls || '';
  s.style.background = cls === 'err' ? '#fee2e2'
    : cls === 'warn' ? '#fef3c7'
    : cls === 'ok' ? '#dcfce7'
    : 'rgba(127,127,127,.15)';
  s.style.color = cls ? '' : 'inherit';
}

function renderSummary(sum) {
  const rows = [
    ['Active keys', sum.active + ' / ' + sum.total],
    ['Groups', String(sum.groups)],
    ['Empty groups', sum.emptyGroups.length ? sum.emptyGroups.join(', ') : 'none'],
  ];
  el('summary').innerHTML = rows
    .map(([k, v]) => '<tr><th>' + k + '</th><td>' + v + '</td></tr>')
    .join('');
}

function renderCoverage(cov) {
  el('coverage').innerHTML =
    '<tr><th>Group</th><th>Active / total</th><th></th></tr>' +
    cov.map((g) => {
      const pct = g.total ? Math.round((g.active / g.total) * 100) : 0;
      return '<tr><td>' + g.label + '</td>' +
        '<td class="muted">' + g.active + ' / ' + g.total + '</td>' +
        '<td><div class="bar"><i style="width:' + pct + '%"></i></div></td></tr>';
    }).join('');
}

function renderConsistency(c) {
  const parts = [];
  parts.push('<p><strong>' +
    (c.errorCount ? c.errorCount + ' error(s), ' : '') +
    c.warnCount + ' warning(s), ' + c.skipCount + ' skipped</strong></p>');

  if (!c.findings.length) {
    parts.push('<p class="ok">No contradictions detected.</p>');
  } else {
    parts.push(c.findings.map((f) =>
      '<div class="finding"><span class="pill ' + f.severity + '">' +
      f.severity.toUpperCase() + '</span> <code>' + f.id + '</code><br>' +
      f.message + '<br><span class="muted">' + f.describe + '</span></div>'
    ).join(''));
  }

  if (c.skipped.length) {
    parts.push('<p class="muted" style="margin-top:10px">Skipped (inputs not set): ' +
      c.skipped.map((s) => '<code>' + s.id + '</code>').join(', ') + '</p>');
  }
  el('consistency').innerHTML = parts.join('');
}

function apply(data) {
  if (data.error) {
    setStatus('Error: ' + data.error, 'err');
    return;
  }

  renderSummary(data.summary);
  renderCoverage(data.coverage);
  renderConsistency(data.consistency);

  if (data.consistency.errorCount) {
    setStatus('Profile has ' + data.consistency.errorCount +
      ' cross-layer error(s) - inconsistent surfaces are a detection signal.',
      'err');
  } else if (data.consistency.warnCount) {
    setStatus('Profile is consistent, with ' + data.consistency.warnCount +
      ' warning(s).', 'warn');
  } else {
    setStatus('Profile is consistent.', 'ok');
  }
}

// The data is INLINED into the page by the data source (window.__fp).
//
// Not fetch(), and not WebUI IPC. In this build:
//   - WebUI subresource fetches fail, including for chrome:// (fetching
//     chrome://resources/js/cr.js from chrome://accessibility gives a bare
//     "Failed to fetch"). So <script src> and fetch() of a sibling URL are out,
//     which is also why the WebUI's own JS module (cr) is missing.
//   - addWebUiListener is undefined on chrome://accessibility too, so the
//     chrome.send/fireWebUIListener round trip cannot deliver a reply either.
// The one path that does work is the main document load, so the page is served
// fully self-contained: markup, script and data all in the initial response.
function load() {
  try {
    if (typeof window.__fp !== 'object' || window.__fp === null) {
      setStatus('No data: the page was served without an inline payload.', 'err');
      return;
    }
    window.__fpApply = apply;   // exposed for tests
    apply(window.__fp);
  } catch (e) {
    setStatus('Failed to render inspector data: ' + e.message, 'err');
  }
}

load();
)FPJS";

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_UI_WEBUI_FINGERPRINT_UI_PAGE_H_
