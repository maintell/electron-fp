#!/usr/bin/env node
// Split fp-fingerprint.patch into per-subsystem patches.
//
// Source of truth is the LIVE SOURCE TREE, not the old monolith text. This is
// deliberate: hand edits to the tree were never written back to the monolith
// (6 comment drifts), so regenerating from the tree fixes that drift and lets
// us recompute hunk headers programmatically instead of trusting stale counts.
//
// Doc blocks (# --- file --- / RANGE / PURPOSE / CONFIG / MERGE) are carried
// over from the monolith, since they are hand-written knowledge that cannot be
// derived from source.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = 'F:/code/src';
const PATCHES = 'F:/code/src/electron/fingerprint/patches';
const MONO = path.join(PATCHES, 'fp-fingerprint.patch');

// ---- classify: spec 3.2 ownership rules, in order ----
function classify(file) {
  if (file.includes('fp_config_helpers.h')) return '00-core';
  if (file.includes('/webrtc/')) return '30-webrtc';
  if (file.includes('p2p/ipc_network_manager.cc')) return '30-webrtc';
  if (file.includes('blink/renderer/modules/')) return '20-blink-modules';
  return '10-blink-core';
}

// ---- parse monolith: header + segments with doc blocks ----
const raw = fs.readFileSync(MONO, 'utf8').replace(/\r\n/g, '\n');
const parts = raw.split(/\n(?=--- a\/)/);
const header = parts[0];
const segs = parts.slice(1).filter(s => s.startsWith('--- a/'));

// Doc blocks IMMEDIATELY PRECEDE the "--- a/" line they describe:
//
//     # --- third_party/webrtc/rtc_base/network.cc ---
//     # RANGE: ...
//     # PURPOSE: ...
//     # MERGE: HIGH risk - ...
//     --- a/third_party/webrtc/rtc_base/network.cc
//
// So scan the raw text line by line and buffer any doc lines seen since the
// last file header, then attach that buffer to the next file. The first
// segment's doc block trails the top-of-file banner.
const ordered = [];
{
  const allLines = raw.split('\n');
  let buf = [];
  let inBanner = true;   // skip the top-of-file banner comment block
  for (let i = 0; i < allLines.length; i++) {
    const l = allLines[i];
    if (l.startsWith('--- a/')) {
      const file = l.slice('--- a/'.length);
      ordered.push({ file, doc: buf.join('\n') });
      buf = [];
      inBanner = false;
      continue;
    }
    if (/^#\s/.test(l) || l === '#') {
      // Only the top-of-file banner is skipped, and it ends at its closing
      // "# ====" rule. The FIRST file's doc block follows that rule, so it
      // must be kept - dropping it would silently lose one file's docs.
      if (inBanner) {
        if (/^# =+/.test(l)) { inBanner = false; buf = []; }
        continue;
      }
      buf.push(l);
      continue;
    }
    if (l.startsWith('diff --git ')) { buf = []; inBanner = false; continue; }
    if (l.trim() === '') continue;
    // A diff body line resets; doc blocks never appear after body content.
    buf = [];
  }
}

// ---- regenerate each file's diff from the live tree ----
// Blink files are tracked in the src repo, so `git diff` gives the exact
// before/after. webrtc is an UNINITIALIZED submodule (`-` in git submodule
// status): its files exist on disk but git cannot see them, so git diff
// returns empty. Those 4 files are handed to the project's own gen_patch6.py
// logic instead, which reconstructs the "before" by reverting the fp blocks
// in Python and diffs with difflib - no git needed.
function gitDiff(file) {
  // fp_config_helpers.h is a NEW file the patch creates. It is untracked, so
  // `git diff` yields nothing; use --no-index against /dev/null instead so we
  // get a proper "new file" diff that git apply can consume.
  // ls-files --error-unmatch EXITS 1 for untracked files rather than printing
  // nothing, so read stdout and ignore the exit code.
  let tracked = false;
  try {
    const out = execFileSync('git', ['-C', SRC, 'ls-files', '--', file],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    tracked = out.trim().length > 0;
  } catch (e) {
    tracked = false;
  }
  if (!tracked) return newFileDiff(file);
  return execFileSync('git', ['-C', SRC, 'diff', '--', file], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

function newFileDiff(file) {
  const content = fs.readFileSync(path.join(SRC, file), 'utf8').replace(/\r\n/g, '\n');
  const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
  const out = [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map(l => '+' + l),
  ];
  return out.join('\n') + '\n';
}

const WEBrTC_FILES = [
  'third_party/webrtc/rtc_base/network.cc',
  'third_party/webrtc/rtc_base/network.h',
  'third_party/webrtc/p2p/base/port.cc',
  'third_party/webrtc/p2p/base/stun_port.cc',
];

// Reconstruct the pre-patch "before" for a webrtc file by replaying the
// monolith's hunks in reverse against the live tree. The monolith was
// generated from this same tree, so applying it backwards is exact and needs
// no git. Equivalent to what gen_patch6.py does with its revert_* functions,
// but without shelling out to Python or writing files as a side effect.
// Find |after| block in |lines|, returning the start index or -1. Searches
// from the END backwards: a file can contain repeated boilerplate, and the
// correct anchor for a reverse-apply is always the LAST occurrence that is
// still ahead of everything already reverted.
function locate(lines, after) {
  if (!after.length) return -1;
  for (let s = lines.length - after.length; s >= 0; s--) {
    let ok = true;
    for (let k = 0; k < after.length; k++) {
      if (lines[s + k] !== after[k]) { ok = false; break; }
    }
    if (ok) return s;
  }
  return -1;
}

function reverseApply(file) {
  const seg = segs.find(s => s.startsWith('--- a/' + file));
  if (!seg) throw new Error('no monolith segment for ' + file);
  const live = fs.readFileSync(path.join(SRC, file), 'utf8').replace(/\r\n/g, '\n').split('\n');
  // collect hunks (descending) and revert each
  // IMPORTANT: stop each hunk at the next "--- a/" too, not just the next
  // "@@ ". Segment boundaries in the monolith are followed by the doc block
  // of the NEXT file, which would otherwise be swallowed into this hunk.
  const lines = seg.split('\n');
  const hunks = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
    if (!m) { i++; continue; }
    const hunk = [];
    i++;
    while (i < lines.length && !/^@@ /.test(lines[i]) &&
           !lines[i].startsWith('--- a/') && !/^# --- /.test(lines[i])) {
      hunk.push(lines[i]);
      i++;
    }
    hunks.push({ hunk });
  }
  // Revert by deleting the ADDED lines only.
  //
  // The monolith's context lines for webrtc files are stale (it predates the
  // webrtc_ip work, and webrtc is an uninitialized submodule so there is no
  // git baseline to reconcile against). Matching context would therefore
  // fail. The added lines, however, are exactly what we put in, so locating
  // them in the live file is reliable - and it is all we need to reconstruct
  // the "before" state.
  for (let h = hunks.length - 1; h >= 0; h--) {
    const added = hunks[h].hunk
      .filter(l => l.startsWith('+'))
      .map(l => l.slice(1));
    if (!added.length) continue;
    let at = locate(live, added);
    if (at === -1) {
      // Fallback: tolerate comment drift. The tree has hand edits that were
      // never written back to the monolith, e.g. network.cc dropped the
      // "// Resolve once per process..." line. Comment lines carry no
      // semantics, so match on non-comment lines only and report the drift.
      const solid = added
        .map((l, k) => ({ l, k, keep: !/^\s*(\/\/|\*|\/\*)/.test(l) }))
        .filter(x => x.keep);
      let best = -1, bestAt = -1;
      for (let s = 0; s + solid.length <= live.length + solid.length; s++) {
        let matched = 0;
        let cursor = s;
        for (const x of solid) {
          if (live[cursor] === x.l) { matched++; cursor++; }
          else {
            // allow live to have extra/differing comment lines here
            let sk = cursor;
            while (sk < live.length && /^\s*(\/\/|\*|\/\*)/.test(live[sk])) sk++;
            if (live[sk] === x.l) { matched++; cursor = sk + 1; }
            else break;
          }
        }
        if (matched > best) { best = matched; bestAt = s; }
      }
      if (best !== solid.length || bestAt === -1) {
        throw new Error('reverse-apply: cannot locate added block in ' + file +
          '\n  matched ' + best + '/' + solid.length +
          '\n  first added-line: ' + JSON.stringify(added[0]));
      }
      const drifted = added.filter(l => /^\s*(\/\/|\*|\/\*)/.test(l)).length;
      if (drifted) {
        console.log('  note: ' + file + ' had ' + drifted +
          ' comment line(s) not matching the monolith (comment drift)');
      }
      // delete the whole region spanned by the match
      let end = bestAt;
      {
        let cursor = bestAt;
        for (const x of solid) {
          if (live[cursor] === x.l) { cursor++; }
          else {
            let sk = cursor;
            while (sk < live.length && /^\s*(\/\/|\*|\/\*)/.test(live[sk])) sk++;
            cursor = sk + 1;
          }
          end = cursor;
        }
      }
      at = bestAt;
      live.splice(at, end - at);
      continue;
    }
    live.splice(at, added.length);
  }
  return live.join('\n');
}

function revertDiff(file) {
  const before = reverseApply(file);
  const after = fs.readFileSync(path.join(SRC, file), 'utf8').replace(/\r\n/g, '\n');
  const bLines = before.endsWith('\n') ? before.slice(0, -1).split('\n') : before.split('\n');
  const aLines = after.endsWith('\n') ? after.slice(0, -1).split('\n') : after.split('\n');
  // unified diff with 3 lines of context
  const out = [`--- a/${file}`, `+++ b/${file}`];
  const sm = buildHunks(bLines.map(l => l + '\n'), aLines.map(l => l + '\n'));
  for (const h of sm) out.push(...h);
  return out.join('\n') + '\n';
}

// Minimal Myers-less LCS unified diff (3 lines context). The fp hunks are
// small and well separated, so a straightforward LCS is sufficient and exact.
function buildHunks(a, b) {
  const N = a.length, M = b.length;
  const dp = Array.from({ length: N + 1 }, () => new Uint32Array(M + 1));
  for (let i = N - 1; i >= 0; i--)
    for (let j = M - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < N && j < M) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < N) { ops.push(['-', a[i]]); i++; }
  while (j < M) { ops.push(['+', b[j]]); j++; }

  const C = 3;
  const changes = [];
  for (let k = 0; k < ops.length; k++) if (ops[k][0] !== ' ') changes.push(k);
  if (!changes.length) return [];
  const hunks = [];
  let s = Math.max(0, changes[0] - C), e = Math.min(ops.length, changes[0] + C + 1);
  for (let k = 1; k < changes.length; k++) {
    if (changes[k] - C <= e) e = Math.min(ops.length, changes[k] + C + 1);
    else { hunks.push([s, e]); s = Math.max(0, changes[k] - C); e = Math.min(ops.length, changes[k] + C + 1); }
  }
  hunks.push([s, e]);
  // Merge hunks whose context windows touch or overlap.
  const merged = [];
  for (const h of hunks) {
    if (merged.length && h[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = h[1];
    } else merged.push(h.slice());
  }

  // Emit each hunk. Old/new line numbers are tracked by walking the ops array
  // once: a '-' consumes an old line, a '+' consumes a new line, ' ' both.
  const res = [];
  for (const [s0, e0] of merged) {
    let aLine = 0, bLine = 0;         // 0-based cursors into a / b
    for (let k = 0; k < s0; k++) {
      if (ops[k][0] !== '+') aLine++;
      if (ops[k][0] !== '-') bLine++;
    }
    const aStart = aLine, bStart = bLine;
    let aCount = 0, bCount = 0;
    const body = [];
    for (let k = s0; k < e0; k++) {
      const [tag, text] = ops[k];
      body.push(tag + text.replace(/\n$/, ''));
      if (tag !== '+') { aCount++; aLine++; }
      if (tag !== '-') { bCount++; bLine++; }
    }
    if (body.length) {
      res.push([`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`, ...body]);
    }
  }
  return res;
}

const groups = {};
for (const { file, doc } of ordered) {
  const g = classify(file);
  let body;
  if (WEBrTC_FILES.includes(file)) {
    try {
      body = revertDiff(file);
    } catch (e) {
      console.error('  revert FAILED for ' + file + ': ' + e.message);
      process.exit(1);
    }
  } else {
    try {
      body = gitDiff(file);
    } catch (e) {
      console.error('  git diff FAILED for ' + file + ': ' + e.message);
      process.exit(1);
    }
  }
  if (!body || !body.trim()) {
    console.error('  EMPTY DIFF for ' + file + ' (tree matches HEAD?)');
    process.exit(1);
  }
  (groups[g] = groups[g] || []).push({ file, doc, body });
}

// ---- write ----
const ORDER = ['00-core', '10-blink-core', '20-blink-modules', '30-webrtc'];
const BANNER = {
  '00-core': 'Shared fingerprint config helpers (fp_config_helpers.h).',
  '10-blink-core': 'Blink core: screen, canvas, timing, fonts, geolocation, DOM.',
  '20-blink-modules': 'Blink modules: WebGL, WebGPU, audio, speech, media, battery, storage.',
  '30-webrtc': 'WebRTC: custom IP override (webrtc is a separate repo, no //base deps).',
};

const summary = [];
for (const g of ORDER) {
  const items = groups[g] || [];
  let out = `# ============================================================================\n`;
  out += `# ${g}.patch - ${BANNER[g]}\n`;
  out += `#\n`;
  out += `# Part of the fp-fingerprint patch set. Apply in filename order:\n`;
  out += `#   ` + ORDER.map(o => o + '.patch').join(' -> ') + `\n`;
  out += `#\n`;
  out += `# fp_config_helpers.h (00-core) is included by 32 of 36 files, so 00-core\n`;
  out += `# MUST be applied first. Any hunk mismatch aborts loudly; nothing is\n`;
  out += `# silently skipped.\n`;
  out += `#\n`;
  out += `# Regenerate with fingerprint/scripts/split_patch.js after adapting hunks.\n`;
  out += `# ============================================================================\n`;

  let add = 0;
  for (const it of items) {
    out += '\n';
    if (it.doc) out += it.doc + '\n';
    const body = it.body.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
    out += body;
    body.split('\n').forEach(l => {
      if (l.startsWith('+') && !l.startsWith('+++')) add++;
    });
  }
  fs.writeFileSync(path.join(PATCHES, g + '.patch'), out, 'utf8');
  summary.push({ g, files: items.length, add, bytes: out.length });
}

console.log('=== split result ===');
let tf = 0, ta = 0;
for (const s of summary) {
  console.log(`  ${s.g.padEnd(20)} ${String(s.files).padStart(2)} files  +${String(s.add).padStart(4)}  ${s.bytes} bytes`);
  tf += s.files; ta += s.add;
}
console.log(`  ${'TOTAL'.padEnd(20)} ${String(tf).padStart(2)} files  +${String(ta).padStart(4)}`);
