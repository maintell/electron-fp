// ponytail: trajectory PLANS only (data out, no events sent); execution lives in input-adapter.js. All randomness from injected rng (seeded-rng.js shape {next,int,pick,jitter}) — never Math.random.
'use strict';

// Common digraphs typed faster (lowercase compare on prev+curr).
const FAST_PAIRS = new Set(['th', 'he', 'in', 'er', 'an', 're', 'on', 'at', 'en', 'nd', 'ti', 'es', 'ou', 'ha']);

// QWERTY adjacency for typo neighbor injection (lowercase a-z).
const QWERTY_ADJ = {
  q: ['w', 'a', 's'], w: ['q', 'e', 'a', 's', 'd'], e: ['w', 'r', 's', 'd', 'f'],
  r: ['e', 't', 'd', 'f', 'g'], t: ['r', 'y', 'f', 'g', 'h'], y: ['t', 'u', 'g', 'h', 'j'],
  u: ['y', 'i', 'h', 'j', 'k'], i: ['u', 'o', 'j', 'k', 'l'], o: ['i', 'p', 'k', 'l'],
  p: ['o', 'l'], a: ['q', 'w', 's', 'z', 'x'], s: ['w', 'e', 'a', 'd', 'z', 'x', 'c'],
  d: ['e', 'r', 's', 'f', 'x', 'c', 'v'], f: ['r', 't', 'd', 'g', 'c', 'v', 'b'],
  g: ['t', 'y', 'f', 'h', 'v', 'b', 'n'], h: ['y', 'u', 'g', 'j', 'b', 'n', 'm'],
  j: ['u', 'i', 'h', 'k', 'n', 'm'], k: ['i', 'o', 'j', 'l', 'm'], l: ['o', 'p', 'k'],
  z: ['a', 's', 'x'], x: ['z', 's', 'd', 'c'], c: ['x', 'd', 'f', 'v'],
  v: ['c', 'f', 'g', 'b'], b: ['v', 'g', 'h', 'n'], n: ['b', 'h', 'j', 'm'],
  m: ['n', 'j', 'k']
};

function fittsTime({ distPx, targetW = 20, a = 50, b = 120, capMs = 1500 } = {}) {
  if (!(distPx >= 0)) throw new Error('distPx must be >= 0, got ' + distPx);
  const v = a + b * Math.log2(distPx / targetW + 1);
  return Math.min(Math.max(50, v), capMs);
}

function planMouseMove({ from, to, rng, rateHz = 90, overshootPx = 3 } = {}) {
  if (!from || !to || !rng) throw new Error('from, to, rng required');
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const durationMs = Math.round(fittsTime({ distPx: dist }));
  const n = Math.min(Math.max(Math.round(durationMs / (1000 / rateHz)), 2), 200);
  // Cubic Bezier: C1/C2 = lerp 1/3|2/3 + shared perpendicular offset (dist*0.15, rng sign).
  const sign = rng.next() < 0.5 ? -1 : 1;
  const nx = dist > 0 ? -dy / dist : 0;
  const ny = dist > 0 ? dx / dist : 0;
  const off = sign * dist * 0.15;
  const c1x = from.x + dx / 3 + nx * off, c1y = from.y + dy / 3 + ny * off;
  const c2x = from.x + 2 * dx / 3 + nx * off, c2y = from.y + 2 * dy / 3 + ny * off;
  // ponytail: cap bezier count so bezier+3 overshoot points never exceed 200 total.
  const bezierN = dist > 8 ? Math.max(2, Math.min(n, 197)) : n;
  const pts = [];
  for (let i = 0; i < bezierN; i++) {
    const t = bezierN === 1 ? 1 : i / (bezierN - 1);
    const u = 1 - t;
    pts.push({
      x: u * u * u * from.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * to.x,
      y: u * u * u * from.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * to.y
    });
  }
  pts[0].x = from.x; pts[0].y = from.y;
  pts[pts.length - 1].x = to.x; pts[pts.length - 1].y = to.y;
  if (dist > 8) {
    const ux = dx / dist, uy = dy / dist;
    pts.push({ x: to.x + ux * overshootPx, y: to.y + uy * overshootPx });
    pts.push({ x: to.x + ux * overshootPx * 0.4, y: to.y + uy * overshootPx * 0.4 });
    pts.push({ x: to.x, y: to.y });
  }
  // Cumulative rounding: each dtMs >= 0, sum telescopes to durationMs exactly.
  const m = pts.length;
  for (let i = 0; i < m; i++) {
    pts[i].dtMs = Math.round(durationMs * (i + 1) / m) - Math.round(durationMs * i / m);
  }
  return { points: pts, durationMs };
}

function planClick({ at, from, rng, rateHz = 90 } = {}) {
  if (!at || !rng) throw new Error('at, rng required');
  const src = from || { x: at.x, y: at.y };
  const moves = planMouseMove({ from: src, to: at, rng, rateHz });
  const holdMs = 30 + Math.floor(rng.next() * 91);
  return { moves, holdMs };
}

function isTypable(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return false;
  const c = ch.charCodeAt(0);
  if (c < 33 || c === 127) return false;
  if (/\s/.test(ch)) return false;
  return true;
}

function wrongNeighbor(ch, rng) {
  const lower = ch.toLowerCase();
  const adj = QWERTY_ADJ[lower];
  let nb;
  if (adj && adj.length) {
    nb = rng.pick(adj);
  } else {
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    do { nb = rng.pick(letters); } while (nb === ch);
  }
  if (ch !== lower) nb = nb.toUpperCase();
  return nb;
}

function planTyping({ text, rng, baseMs = 90, spreadMs = 120, mistakeProb = 0.02 } = {}) {
  if (!rng) throw new Error('rng required');
  if (!text) return [];
  const ops = [];
  const chars = [...String(text)];
  let prev = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const fast = i > 0 && FAST_PAIRS.has((prev + ch).toLowerCase());
    const draw = () => Math.round(baseMs * (fast ? 0.6 : 1) + rng.next() * spreadMs);
    const delay = draw();
    if (i > 0 && isTypable(ch) && mistakeProb > 0 && rng.next() < mistakeProb) {
      ops.push({ op: 'char', ch: wrongNeighbor(ch, rng), delayMs: delay });
      ops.push({ op: 'backspace', delayMs: Math.round(baseMs + rng.next() * spreadMs) });
      ops.push({ op: 'char', ch, delayMs: draw() });
    } else {
      ops.push({ op: 'char', ch, delayMs: delay });
    }
    prev = ch;
  }
  return ops;
}

function planScroll({ dy, dx = 0, rng } = {}) {
  if (typeof dy !== 'number' || !rng) throw new Error('dy, rng required');
  if (dy === 0) return { ticks: [{ dx, dy: 0, dtMs: Math.round(400 + rng.next() * 30) }] };
  const s = dy > 0 ? 1 : -1;
  // ponytail: main capped at 22 so main+2 tail ticks stay within [3,24] total.
  const n = Math.min(Math.max(Math.round(Math.abs(dy) / 40), 3), 22);
  const mainY = dy - s * 3; // tail adds 3s back so total sums to dy exactly
  const ticks = [];
  let px = 0, py = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const p = 1 - Math.pow(1 - t, 3); // easeOutCubic on cumulative progress
    const cy = Math.round(mainY * p), cx = Math.round(dx * p);
    ticks.push({ dx: cx - px, dy: cy - py, dtMs: Math.round(400 / n + rng.next() * 30) });
    px = cx; py = cy;
  }
  ticks.push({ dx: 0, dy: s * 2, dtMs: 50 }, { dx: 0, dy: s * 1, dtMs: 70 });
  return { ticks };
}

module.exports = { fittsTime, planMouseMove, planClick, planTyping, planScroll, FAST_PAIRS, QWERTY_ADJ };
