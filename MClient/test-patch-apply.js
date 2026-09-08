// Client/test-patch-apply.js
//
// Validates the patch set the way the docs CLAIM it is validated, which until
// now nothing did.
//
// fingerprint/scripts/apply.py covers the 5 Chromium patches (it has idempotency
// markers for them). For 50-electron-glue and 60-electron-inspector it prints
// "Electron-tree patch, not applicable to Chromium (verify with check.py)" - but
// check.py only greps the patch text; it never tries to apply them to the tree
// those patches actually target. So both were documented as verified by a step
// that does not exist.
//
// This test closes that gap. The subtle part is telling "already applied" apart
// from "broken": git apply --check fails in BOTH cases. The discriminator is
// --reverse: if the patch applies backwards, the forward direction is already
// present, which proves the patch matches the tree and is valid. Only when
// neither direction works is the patch genuinely broken. Reporting the first
// case as a failure would cry wolf on a healthy tree; missing the second would
// hide a patch that can never be applied again.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PATCH_DIR = path.join(REPO, 'fingerprint', 'patches');
const TMP = path.join(require('os').tmpdir(), 'electron_fp_patchcheck');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// run-tests.js parses /^PASS/ and /^(FAIL|THREW)/ anchored at COLUMN 0, and
// treats "pass=0 && fail=0" as a crash rather than success. So these markers
// must be unindented - the indented form above printed correctly but was
// invisible to the runner, which reported pass=0 fail=0 and failed the file.
let pass = 0, fail = 0, skip = 0;
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}
function sk(name, why) { skip++; console.log('SKIP  ' + name + '  (' + why + ')'); }

// Strip the leading '#' documentation block; git apply wants only the diff.
function diffBody(raw) {
  const m = /(?:^--- a\/|^diff --git )/m.exec(raw);
  return m ? raw.slice(m.index) : raw;
}

function applyCheck(diffPath, reverse) {
  const args = ['apply', '--check'];
  if (reverse) args.push('--reverse');
  args.push('-p1', diffPath);
  try {
    execFileSync('git', args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, err: '' };
  } catch (e) {
    const s = typeof e.stderr === 'string' ? e.stderr
      : (e.stderr ? Buffer.from(e.stderr).toString('utf8') : '');
    return { ok: false, err: s.split('\n')[0] || '' };
  }
}

const ELECTRON_PATCHES = ['50-electron-glue', '60-electron-inspector'];
const CHROMIUM_PATCHES = ['00-core', '10-blink-core', '20-blink-modules',
                          '30-webrtc', '40-net-tls'];

console.log('=== Electron-tree patches: apply-verified against this repo ===');
for (const name of ELECTRON_PATCHES) {
  const p = path.join(PATCH_DIR, name + '.patch');
  if (!fs.existsSync(p)) { sk(name + ' present', 'file missing'); continue; }
  const raw = fs.readFileSync(p, 'utf8');
  const diffPath = path.join(TMP, name + '.diff');
  fs.writeFileSync(diffPath, diffBody(raw), 'utf8');

  const fwd = applyCheck(diffPath, false);
  const rev = applyCheck(diffPath, true);
  // Valid = applies forward (fresh tree) OR reverse (already applied).
  ck(name + ' matches the tree',
    fwd.ok || rev.ok,
    fwd.ok ? 'applies forward (tree is unpatched)'
      : (rev.ok ? 'already applied; reverse-check proves the patch matches'
        : 'neither direction: forward=' + fwd.err.slice(0, 70) +
          ' reverse=' + rev.err.slice(0, 70)));
}

console.log('');
console.log('=== every active patch is documented and well-formed ===');
const all = ['00-core', '10-blink-core', '20-blink-modules', '30-webrtc',
             '40-net-tls', '50-electron-glue', '60-electron-inspector'];
for (const name of all) {
  const p = path.join(PATCH_DIR, name + '.patch');
  if (!fs.existsSync(p)) { sk(name, 'missing'); continue; }
  const s = fs.readFileSync(p, 'utf8');
  ck(name + ' has an upgrade guide',
    s.includes('MERGE/UPGRADE GUIDE') || s.includes('MERGE/UPGRADE GUIDE (new Chromium versions)'),
    s.includes('MERGE/UPGRADE GUIDE') ? 'present' : 'ABSENT');
  ck(name + ' states apply ordering', s.includes('Apply in filename order'), '');
}

// Per-file documentation coverage.
//
// Last round only checked that each patch HAD an upgrade guide, not that its
// per-file blocks were usable. 40-net-tls and 50-electron-glue - the two
// network-layer patches, i.e. the ones that most need it - had zero MERGE risk
// ratings across all 13 blocks, and the gate was green. RANGE and PURPOSE say
// what a block does; MERGE says how likely it is to break on a Chromium bump
// and what the trap is. Without it the upgrade guide exists but does not help.
console.log('');
console.log('=== per-file doc coverage: every touched file carries RANGE/PURPOSE/MERGE ===');
for (const name of all) {
  const p = path.join(PATCH_DIR, name + '.patch');
  const s = fs.readFileSync(p, 'utf8');
  const L = s.split('\n');

  // Two kinds of file need two kinds of documentation, and the first version
  // of this check wrongly demanded a per-file doc block for both:
  //   MODIFIED files -> a "# --- path" doc block with RANGE/PURPOSE/MERGE,
  //     because a re-anchoring porter needs to know what the hunk touches.
  //   NEW files ("--- /dev/null") -> listed in the patch header's "NEW FILES"
  //     section instead. They have no upstream anchor to describe, so a doc
  //     block would be filler; requiring one just forces boilerplate.
  const touched = new Set();
  const created = new Set();
  for (let i = 0; i < L.length; i++) {
    const m = /^\+\+\+ b\/(\S+)/.exec(L[i]);
    if (!m || m[1] === '/dev/null') continue;
    // A file is "new" when its own diff says so, immediately above +++ b/.
    const near = L.slice(Math.max(0, i - 4), i).join('\n');
    if (/new file mode/.test(near) || /^--- \/dev\/null$/m.test(near)) created.add(m[1]);
    else touched.add(m[1]);
  }
  // Doc blocks and which fields each declares.
  const blocks = [];
  let cur = null;
  for (const l of L) {
    const m = /^# --- (\S+)/.exec(l);
    if (m) { cur = { path: m[1], fields: [] }; blocks.push(cur); }
    const fl = /^# (RANGE|PURPOSE|MERGE):/.exec(l);
    if (fl && cur) cur.fields.push(fl[1]);
  }
  const docPaths = new Set(blocks.map((b) => b.path));
  const undocumented = [...touched].filter((x) => !docPaths.has(x));
  const orphan = [...docPaths].filter((x) => !touched.has(x) && !created.has(x));
  // New files must at least be named in the header block.
  const header = s.split(/^diff --git /m)[0];
  const unnamedNew = [...created].filter((x) => !header.includes(x.split('/').pop()));
  const noRP = blocks.filter((b) => !b.fields.includes('RANGE') ||
                                    !b.fields.includes('PURPOSE'));
  const noMerge = blocks.filter((b) => !b.fields.includes('MERGE'));

  ck(name + ': every modified file has a doc block',
    undocumented.length === 0 && orphan.length === 0,
    undocumented.length ? 'undocumented: ' + undocumented.join(', ')
      : (orphan.length ? 'orphan blocks: ' + orphan.join(', ')
        : blocks.length + ' blocks / ' + touched.size + ' modified'));
  ck(name + ': every new file is named in the header',
    unnamedNew.length === 0,
    unnamedNew.length ? 'unnamed: ' + unnamedNew.join(', ')
      : (created.size ? created.size + ' new, all named' : 'no new files'));
  ck(name + ': every block has RANGE and PURPOSE', noRP.length === 0,
    noRP.length ? noRP.map((b) => b.path.split('/').pop()).join(', ') : 'all present');
  ck(name + ': every block has a MERGE risk rating', noMerge.length === 0,
    noMerge.length ? 'missing: ' + noMerge.map((b) => b.path.split('/').pop()).join(', ')
      : 'all ' + blocks.length + ' rated');
}

console.log('');
console.log('=== the retired monolith stays retired ===');
const mono = path.join(PATCH_DIR, 'fp-fingerprint.patch');
if (fs.existsSync(mono)) {
  const s = fs.readFileSync(mono, 'utf8');
  ck('monolith is marked DEAD WEIGHT', s.includes('DEAD WEIGHT'), '');
  ck('monolith is not in the apply order claim',
    !s.includes('Apply in filename order'),
    s.includes('Apply in filename order') ? 'it claims to be applyable' : 'correctly excluded');
} else {
  sk('monolith', 'not present');
}

console.log('');
console.log('  pass=' + pass + ' fail=' + fail + ' skip=' + skip);
process.exit(fail === 0 ? 0 : 1);
