// Gate the shared window layout geometry.
//
// Client/layout.js exists because main.js and Client/test-panel.js each had
// their own copy of the BrowserView geometry, and the copies had drifted: the
// test's version renamed TOP_HEIGHT to CHROME_HEIGHT and dropped the
// STATUS_HEIGHT subtraction entirely. The test asserted horizontal coverage
// only, so the drift was invisible - it measured the right thing for the wrong
// reason and would have stayed silent if the status bar changed height.
//
// This test covers what the old one could not: the VERTICAL geometry, which is
// where the drift actually lived. Plain Node, no Electron - layout.js is pure.

'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..', 'Client');
const L = require('../Client/layout.js');
const { TOP_HEIGHT, STATUS_HEIGHT, PANEL_WIDTH, MIN_VIEW_WIDTH, viewBounds } = L;

let pass = 0, fail = 0;
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

// --- 1. the geometry itself ------------------------------------------------
const W = 1200, H = 800;

const closed = viewBounds(W, H, false);
ck('panel closed: view spans the full content width', closed.width === W,
  closed.width + ' vs ' + W);
ck('panel closed: view starts at x=0', closed.x === 0);
ck('panel closed: view starts below the chrome', closed.y === TOP_HEIGHT,
  closed.y + ' vs TOP_HEIGHT=' + TOP_HEIGHT);
// The assertion the old duplicate could not make: it forgot STATUS_HEIGHT.
ck('panel closed: view height excludes BOTH chrome and status bar',
  closed.height === H - TOP_HEIGHT - STATUS_HEIGHT,
  closed.height + ' vs expected ' + (H - TOP_HEIGHT - STATUS_HEIGHT));
ck('panel closed: view bottom stops above the status bar',
  closed.y + closed.height === H - STATUS_HEIGHT,
  'bottom=' + (closed.y + closed.height) + ' vs ' + (H - STATUS_HEIGHT));

const open = viewBounds(W, H, true);
ck('panel open: view width shrinks by exactly the panel width',
  open.width === W - PANEL_WIDTH, open.width + ' vs ' + (W - PANEL_WIDTH));
ck('panel open: view right edge lands exactly where the panel starts',
  open.x + open.width === W - PANEL_WIDTH,
  'rightEdge=' + (open.x + open.width) + ' panelStartX=' + (W - PANEL_WIDTH));
ck('panel open: height is unchanged by the panel (panel is full-height)',
  open.height === closed.height, open.height + ' vs ' + closed.height);

// The MIN_VIEW_WIDTH clamp is easy to lose in a re-implementation.
const tiny = viewBounds(PANEL_WIDTH - 50, H, true);
ck('panel open on a narrow window: width is clamped, never negative',
  tiny.width === MIN_VIEW_WIDTH,
  'width=' + tiny.width + ' (content width ' + (PANEL_WIDTH - 50) +
  ' is less than the panel)');
const exact = viewBounds(PANEL_WIDTH + MIN_VIEW_WIDTH, H, true);
ck('clamp boundary: exactly MIN_VIEW_WIDTH is preserved',
  exact.width === MIN_VIEW_WIDTH, 'width=' + exact.width);

// Monotonic: widening the window never narrows the view.
let mono = true;
for (let w = PANEL_WIDTH; w < PANEL_WIDTH + 600; w += 7) {
  const a = viewBounds(w, H, true);
  const b = viewBounds(w + 7, H, true);
  if (b.width < a.width) { mono = false; break; }
}
ck('wider window never yields a narrower view', mono);

// --- 2. both callers actually use the shared module ------------------------
const main = fs.readFileSync(path.join(CLIENT, 'main.js'), 'utf8');
const panel = fs.readFileSync(path.join(CLIENT, 'test-panel.js'), 'utf8');

ck('main.js imports viewBounds from layout.js',
  /require\('\.\/layout'\)/.test(main) && /viewBounds/.test(main));
ck('test-panel.js imports viewBounds from layout.js',
  /require\('\.\/layout'\)/.test(panel) && /viewBounds/.test(panel));

// No caller may keep a private copy of the formula.
ck('main.js has no inline setBounds geometry',
  !/setBounds\(\{\s*x:\s*0,\s*y:\s*TOP_HEIGHT/.test(main),
  /setBounds\(\{\s*x:\s*0,\s*y:\s*TOP_HEIGHT/.test(main)
    ? 'found an inline bounds object' : 'delegates to layout.js');
ck('test-panel.js has no inline setBounds geometry',
  !/setBounds\(\{\s*x:\s*0,\s*y:\s*CHROME_HEIGHT/.test(panel),
  /setBounds\(\{\s*x:\s*0,\s*y:\s*CHROME_HEIGHT/.test(panel)
    ? 'found an inline bounds object' : 'delegates to layout.js');
ck('test-panel.js no longer defines CHROME_HEIGHT (the drifted rename)',
  !/CHROME_HEIGHT/.test(panel),
  /CHROME_HEIGHT/.test(panel) ? 'CHROME_HEIGHT still present' : 'gone');
ck('main.js defines no local PANEL_WIDTH/TOP_HEIGHT/STATUS_HEIGHT',
  !/const\s+PANEL_WIDTH\s*=/.test(main) && !/const\s+TOP_HEIGHT\s*=/.test(main) &&
  !/const\s+STATUS_HEIGHT\s*=/.test(main),
  'constants come from layout.js');

// --- 3. layout.js is packaged ---------------------------------------------
const sync = fs.readFileSync(path.join(CLIENT, 'test-app-copy-sync.js'), 'utf8');
ck('layout.js is in the packaged-copy sync list', /layout\.js/.test(sync),
  /layout\.js/.test(sync) ? 'listed' : 'MISSING - would crash on require');

console.log('');
console.log(fail === 0
  ? 'PASS: ' + pass + ' checks'
  : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
process.exit(fail === 0 ? 0 : 1);
