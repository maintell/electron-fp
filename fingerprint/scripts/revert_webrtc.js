'use strict';
// Revert ONE webrtc file to its stock (pre-patch) state in place.
// webrtc is an uninitialized submodule, so git cannot restore it; we remove
// the fp-added lines identified by the monolith patch.
const fs = require('fs');
const path = require('path');

const SRC = 'F:/code/src';
const MONO = 'F:/code/src/electron/fingerprint/patches/fp-fingerprint.patch';
const file = process.argv[2];
if (!file) { console.error('usage: revert_webrtc.js <file>'); process.exit(2); }

const raw = fs.readFileSync(MONO, 'utf8').replace(/\r\n/g, '\n');
const segs = raw.split(/\n(?=--- a\/)/).filter(s => s.startsWith('--- a/'));
const seg = segs.find(s => s.startsWith('--- a/' + file));
if (!seg) { console.error('no segment for ' + file); process.exit(1); }

const lines = seg.split('\n');
const hunks = [];
let i = 0;
while (i < lines.length) {
  if (!/^@@ /.test(lines[i])) { i++; continue; }
  const h = []; i++;
  while (i < lines.length && !/^@@ /.test(lines[i]) &&
         !lines[i].startsWith('--- a/') && !/^# --- /.test(lines[i])) { h.push(lines[i]); i++; }
  hunks.push(h);
}

function locate(arr, block) {
  if (!block.length) return -1;
  for (let s = arr.length - block.length; s >= 0; s--) {
    let ok = true;
    for (let k = 0; k < block.length; k++) if (arr[s + k] !== block[k]) { ok = false; break; }
    if (ok) return s;
  }
  return -1;
}

let live = fs.readFileSync(path.join(SRC, file), 'utf8').replace(/\r\n/g, '\n').split('\n');
for (let h = hunks.length - 1; h >= 0; h--) {
  const added = hunks[h].filter(l => l.startsWith('+')).map(l => l.slice(1));
  if (!added.length) continue;
  let at = locate(live, added);
  if (at === -1) {
    // comment-drift tolerant fallback: match on non-comment lines
    const solid = added.filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
    let best = -1, bestAt = -1;
    for (let s = 0; s < live.length; s++) {
      let matched = 0, cursor = s;
      for (const x of solid) {
        if (live[cursor] === x) { matched++; cursor++; }
        else {
          let sk = cursor;
          while (sk < live.length && /^\s*(\/\/|\*|\/\*)/.test(live[sk])) sk++;
          if (live[sk] === x) { matched++; cursor = sk + 1; } else break;
        }
      }
      if (matched > best) { best = matched; bestAt = s; }
    }
    if (best !== solid.length || bestAt === -1) {
      console.error('  cannot revert ' + file + ' (' + best + '/' + solid.length + ')');
      process.exit(1);
    }
    let cursor = bestAt, end = bestAt;
    for (const x of solid) {
      if (live[cursor] === x) cursor++;
      else { let sk = cursor; while (sk < live.length && /^\s*(\/\/|\*|\/\*)/.test(live[sk])) sk++; cursor = sk + 1; }
      end = cursor;
    }
    live.splice(bestAt, end - bestAt);
    continue;
  }
  live.splice(at, added.length);
}
fs.writeFileSync(path.join(SRC, file), live.join('\n'), 'utf8');
console.log('    reverted ' + file);
