// ponytail: deterministic per-profile timing source; seed=hash(profileId) derived-and-discarded (no persistence — new seed = new persona).
'use strict';

// FNV-1a 32-bit: simple, stable across processes, good avalanche for short profile ids.
function hashSeed(str) {
  const s = String(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: tiny, fast, deterministic; state lives in closure, no Math.random anywhere in this file.
function createRng(seed) {
  let a;
  if (typeof seed === 'string') a = hashSeed(seed);
  else if (typeof seed === 'number') a = seed >>> 0;
  else a = hashSeed(String(seed));
  function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function int(min, max) {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    if (!(lo <= hi)) throw new Error('bad int range: ' + min + '..' + max);
    return lo + Math.floor(next() * (hi - lo + 1));
  }
  function pick(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return undefined;
    return arr[Math.floor(next() * arr.length)];
  }
  function jitter(base, frac) {
    return base * (1 + (next() * 2 - 1) * frac);
  }
  return { next, int, pick, jitter };
}

module.exports = { hashSeed, createRng };
