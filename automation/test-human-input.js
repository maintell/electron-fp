'use strict';
// test-human-input.js: P1 human-input trajectory plans (pure, seeded). PASS/FAIL lines, exit 0 iff 0 FAIL.
const fs = require('fs');
const path = require('path');
const { createRng } = require('./runtime/seeded-rng.js');
const hi = require('./runtime/human-input.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + extra : '')); }
}
const J = (v) => JSON.stringify(v);

// --- fittsTime ---
(function () {
  const f1 = hi.fittsTime({ distPx: 10 });
  const f2 = hi.fittsTime({ distPx: 200 });
  const f3 = hi.fittsTime({ distPx: 800 });
  check('fitts increases with distance', f1 < f2 && f2 < f3, J([f1, f2, f3]));
  check('fitts cap respected', hi.fittsTime({ distPx: 1e12 }) === 1500);
  let threw = false;
  try { hi.fittsTime({ distPx: -1 }); } catch (e) { threw = true; }
  check('fitts negative throws', threw);
})();

// --- planMouseMove ---
(function () {
  const from = { x: 10, y: 20 }, to = { x: 210, y: 120 };
  const r = hi.planMouseMove({ from, to, rng: createRng('move-seed') });
  const pts = r.points;
  check('move starts exact from', pts[0].x === from.x && pts[0].y === from.y);
  const last = pts[pts.length - 1];
  check('move ends exact to', last.x === to.x && last.y === to.y);
  const sum = pts.reduce((a, p) => a + p.dtMs, 0);
  check('move dtMs sum == durationMs', sum === r.durationMs, J({ sum, d: r.durationMs }));
  check('move N within [2,200]', pts.length >= 2 && pts.length <= 200, 'len=' + pts.length);
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const nx = (to.x - from.x) / len, ny = (to.y - from.y) / len;
  const beyond = pts.some((p) => (p.x - to.x) * nx + (p.y - to.y) * ny > 0.5);
  check('move overshoot present when dist>8', beyond);
  const a1 = hi.planMouseMove({ from, to, rng: createRng('p') });
  const a2 = hi.planMouseMove({ from, to, rng: createRng('p') });
  check('move determinism same seed', J(a1) === J(a2));
  const b1 = hi.planMouseMove({ from, to, rng: createRng('diverge-a') });
  const b2 = hi.planMouseMove({ from, to, rng: createRng('diverge-b') });
  check('move different seeds diverge', J(b1) !== J(b2));
})();

// --- planClick ---
(function () {
  const at = { x: 300, y: 400 };
  const hs = ['ck1', 'ck2', 'ck3'].map((s) => hi.planClick({ at, rng: createRng(s) }).holdMs);
  check('click holdMs in [30,120]', hs.every((h) => h >= 30 && h <= 120), J(hs));
  const c = hi.planClick({ at, from: { x: 0, y: 0 }, rng: createRng('ck1') });
  const lp = c.moves.points[c.moves.points.length - 1];
  check('click moves end at target', lp.x === at.x && lp.y === at.y);
})();

// --- planTyping ---
(function () {
  const ops = hi.planTyping({ text: 'hello', rng: createRng('t0'), mistakeProb: 0 });
  check('typing no-mistake length', ops.length === 5, 'len=' + ops.length);
  check('typing no-mistake order', ops.every((o) => o.op === 'char') && ops.map((o) => o.ch).join('') === 'hello');
  const m = hi.planTyping({ text: 'ab', rng: createRng('t1'), mistakeProb: 1 });
  check('typing forced mistake triple', m.length === 4 && m[0].ch === 'a' && m[1].ch !== 'b' && m[2].op === 'backspace' && m[3].ch === 'b', J(m));
  check('typing wrong neighbor adjacent', hi.QWERTY_ADJ['b'].includes(m[1].ch), 'wrong=' + m[1].ch);
  const all = ops.concat(m);
  check('typing delays in bounds', all.every((o) => Number.isInteger(o.delayMs) && o.delayMs >= Math.round(90 * 0.6)), J(all.map((o) => o.delayMs)));
  check('typing empty -> []', hi.planTyping({ text: '', rng: createRng('t2') }).length === 0);
})();

// --- planScroll ---
(function () {
  const s = hi.planScroll({ dy: 500, dx: 30, rng: createRng('s0') });
  const sy = s.ticks.reduce((a, t) => a + t.dy, 0), sx = s.ticks.reduce((a, t) => a + t.dx, 0);
  check('scroll sum dy exact', sy === 500, 'sum=' + sy);
  check('scroll sum dx exact', sx === 30, 'sum=' + sx);
  check('scroll n in [3,24]', s.ticks.length >= 3 && s.ticks.length <= 24, 'len=' + s.ticks.length);
  const tail = s.ticks.slice(-2);
  check('scroll inertia tail', tail[0].dy === 2 && tail[1].dy === 1 && tail[0].dtMs === 50 && tail[1].dtMs === 70, J(tail));
  const big = hi.planScroll({ dy: 50000, rng: createRng('s1') });
  check('scroll cap total<=24', big.ticks.length <= 24, 'len=' + big.ticks.length);
  const z = hi.planScroll({ dy: 0, rng: createRng('s2') });
  check('scroll dy=0 single tick no tail', z.ticks.length === 1 && z.ticks[0].dy === 0);
})();

// --- static: no Math.random in timing path ---
(function () {
  const src = fs.readFileSync(path.join(__dirname, 'runtime', 'human-input.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\S\n])\/\/.*$/gm, '$1');
  check('no Math.random in human-input.js', !/Math\.random/.test(stripped));
})();

console.log('SKIP seed-not-persisted (covered by seeded-rng suite)');
console.log('TOTAL pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
