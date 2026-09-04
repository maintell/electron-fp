// Gate the COUNTS in Client/README.md.
//
// The README said "60/60 exact match" and "178 checks, 16 files" long after the
// real numbers were 63 and 766/51. Stale counts are worse than no counts: a
// reader sizing the system, or trusting that a table is complete, is misled.
//
// So the numbers the README states about the schema are checked against the
// schema itself. The suite total is deliberately NOT pinned - it legitimately
// changes whenever a test is added, and a test that fails on every commit for a
// correct reason gets muted. Key and group counts are different: they describe
// the contract, and they are what a reader relies on.
//
// Plain Node - no Electron.

'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..', 'Client');
const README = path.join(CLIENT, 'README.md');

let pass = 0, fail = 0;
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

const { FP_KEY_NAMES, FP_GROUP_IDS, FP_KEYS } = require(path.join(CLIENT, 'fp-schema.js'));
const md = fs.existsSync(README) ? fs.readFileSync(README, 'utf8') : '';

ck('README is present', !!md, README);
if (!md) { console.log('FAIL: 1 of 1'); process.exit(1); }

// --- key count ---------------------------------------------------------------
// Any "<n>/<n> exact match" or "<n> keys" claim about the schema must equal the
// real key count. Catch the stale "60/60" shape specifically.
const exactMatch = [...md.matchAll(/(\d+)\s*\/\s*(\d+)\s+exact match/g)];
const wrongExact = exactMatch.filter((m) => m[1] !== String(FP_KEY_NAMES.length));
ck('every "N/N exact match" claim equals the real key count',
  wrongExact.length === 0,
  wrongExact.length
    ? wrongExact.map((m) => m[0]).join(' | ')
    : exactMatch.length + ' claim(s), all ' + FP_KEY_NAMES.length);

// --- group count -------------------------------------------------------------
const groupClaims = [...md.matchAll(/(\d+)\s+groups/g)].map((m) => m[1]);
const wrongGroups = groupClaims.filter((n) => n !== String(FP_GROUP_IDS.length));
ck('every "N groups" claim equals the real group count',
  wrongGroups.length === 0,
  wrongGroups.length ? wrongGroups.join(', ')
    : groupClaims.length + ' claim(s), all ' + FP_GROUP_IDS.length);

// --- the key table must list every key --------------------------------------
// A table that silently omits keys is the exact staleness that hides a gap.
const missing = FP_KEY_NAMES.filter((k) => !md.includes(k));
ck('the README key table mentions every schema key', missing.length === 0,
  missing.length ? 'missing: ' + missing.slice(0, 8).join(', ')
    : FP_KEY_NAMES.length + ' keys all present');

// --- every documented group has a row ---------------------------------------
// Accept the group's LABEL as well as its id: the table is prose for humans and
// uses "Locale & Privacy" rather than the id "env". Requiring the raw id would
// demand the doc be written for the test instead of for the reader.
const FP_GROUPS = require(path.join(CLIENT, 'fp-schema.js')).FP_GROUPS;
const missingGroups = FP_GROUPS.filter((g) => !md.includes(g.id) && !md.includes(g.label));
ck('the README group table covers every group', missingGroups.length === 0,
  missingGroups.length ? missingGroups.map((g) => g.id + '/' + g.label).join(', ')
    : FP_GROUPS.length + ' groups');

// The table's row count must equal the group count - a group can be mentioned
// in passing prose without having a row, which is the subtler staleness.
//
// Scoped to the "Fingerprint Keys" section: the Known Limitations table further
// down uses the same 3-column shape, and counting it here produced 16 rows for
// 15 groups. A check that over-counts by accident is a check that gets muted.
const SECTION = '### Fingerprint Keys';
let section = md.includes(SECTION) ? md.slice(md.indexOf(SECTION)) : '';
// Cut at the NEXT heading: the Known Limitations table below shares the shape.
const next = section.indexOf('\n#', 1);
if (next > 0) section = section.slice(0, next);
const rows = section.split(/\r?\n/)
  .filter((l) => /^\|\s*[A-Za-z][^|]*\s*\|\s*[^|]+\s*\|\s*`[^`]+`/.test(l));
ck('the group table has one row per group (scoped to its own section)',
  rows.length === FP_GROUPS.length,
  rows.length + ' rows vs ' + FP_GROUPS.length + ' groups');

// --- the group table's per-group key counts must be right -------------------
// Parse "| Group | Description | Keys |" rows and compare the listed key count
// to the schema.
let tableErrors = [];
for (const line of md.split(/\r?\n/)) {
  const m = line.match(/^\|\s*([A-Za-z][^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(`[^`]+`(?:,\s*`[^`]+`)*)\s*\|/);
  if (!m) continue;
  const keys = [...m[3].matchAll(/`([a-z0-9_]+)`/g)].map((x) => x[1]);
  if (!keys.length) continue;
  const unknown = keys.filter((k) => !FP_KEYS[k]);
  if (unknown.length) tableErrors.push(m[1].trim() + ': unknown keys ' + unknown.join(','));
}
ck('every key named in the group table exists in the schema',
  tableErrors.length === 0,
  tableErrors.length ? tableErrors.slice(0, 4).join(' | ') : 'all rows reference real keys');

// --- documented key total vs table total ------------------------------------
// If the table lists a key in two rows (or zero), the total silently drifts
// from the stated count.
const tableKeys = new Set();
for (const line of md.split(/\r?\n/)) {
  const m = line.match(/^\|\s*([A-Za-z][^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(`[^`]+`(?:,\s*`[^`]+`)*)\s*\|/);
  if (!m) continue;
  for (const x of m[3].matchAll(/`([a-z0-9_]+)`/g)) tableKeys.add(x[1]);
}
const inTableNotSchema = [...tableKeys].filter((k) => !FP_KEYS[k]);
const inSchemaNotTable = FP_KEY_NAMES.filter((k) => !tableKeys.has(k));
ck('the group table covers each key exactly once',
  inSchemaNotTable.length === 0 && inTableNotSchema.length === 0,
  (inSchemaNotTable.length ? 'not in table: ' + inSchemaNotTable.slice(0, 6).join(', ') + ' ' : '') +
  (inTableNotSchema.length ? 'not in schema: ' + inTableNotSchema.join(', ') : '') +
  (inSchemaNotTable.length || inTableNotSchema.length ? '' : tableKeys.size + ' keys'));

// --- the self-test coverage claim -------------------------------------------
// The README states how many of the 63 keys the self-test pane can show ("58 of
// the 63") and names the remainder. Both halves can rot independently: the
// probe gains a field and the number goes stale, or a key becomes readable and
// stays listed as impossible. Derive both from fp-probe.js.
const { PROBE_FIELDS } = require(path.join(CLIENT, 'fp-probe.js'));
const probed = PROBE_FIELDS.length;
const unprobed = FP_KEY_NAMES.filter((k) => !PROBE_FIELDS.includes(k));

// Match "**58 of the 63 keys**" wherever it appears; the surrounding wording
// is not pinned, only the two numbers.
const claimedProbed = [...md.matchAll(/(\d+)\s+of\s+the\s+(\d+)\s+keys/g)]
  .map((m) => ({ n: Number(m[1]), total: Number(m[2]) }))
  .filter((c) => c.total === FP_KEY_NAMES.length);
ck('the README states the real self-test coverage',
  claimedProbed.length > 0 && claimedProbed.every(
    (c) => c.n === probed && c.total === FP_KEY_NAMES.length),
  claimedProbed.length
    ? 'README says ' + claimedProbed[0].n + '/' + claimedProbed[0].total +
      ', probe reads ' + probed + '/' + FP_KEY_NAMES.length
    : 'no coverage claim found in README');

// Every key the README lists as unreadable must ACTUALLY be unreadable. Two
// of the five are modifiers gated on a companion seed; three are geo keys that
// need a privileged channel. If any of them becomes probeable, this fails and
// the documented caveat must be removed rather than left to mislead.
const stillExcluded = unprobed.filter((k) => !new RegExp('`' + k + '`').test(md));
ck('every key the probe cannot read is named in the README as such',
  stillExcluded.length === 0,
  stillExcluded.length ? 'undocumented: ' + stillExcluded.join(', ')
    : unprobed.length + ' excluded, all documented');

// The inverse: a key documented as impossible but now probed is a stale caveat
// - it understates what the user can verify.
const excludedSection = md.slice(md.indexOf('### The 5 keys the self-test cannot show'),
  md.indexOf('Both noise-strength keys are real'));
const documentedExcluded = [...excludedSection.matchAll(/`([a-z0-9_]+)`/g)]
  .map((m) => m[1]).filter((k) => FP_KEYS[k]);
const nowProbed = documentedExcluded.filter((k) => PROBE_FIELDS.includes(k));
ck('no key documented as unreadable is actually readable now',
  nowProbed.length === 0,
  nowProbed.length ? 'stale caveat: ' + nowProbed.join(', ') + ' is probeable'
    : documentedExcluded.length + ' documented, none readable');

console.log('');
console.log('  (diagnostic) schema: ' + FP_KEY_NAMES.length + ' keys / ' +
  FP_GROUP_IDS.length + ' groups; table lists ' + tableKeys.size + ' keys; ' +
  'probe reads ' + probed + ', excludes ' + unprobed.length);
console.log(fail === 0
  ? 'PASS: ' + pass + ' checks'
  : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
process.exit(fail === 0 ? 0 : 1);
