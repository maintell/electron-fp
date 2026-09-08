// Gate: FpConfigString keys must not be silently inert when passed as a number.
//
// Session::SetFingerprintConfig serialises the raw JS object with
// base::WriteJson - it does NOT go through fpNormalizeConfig(). So
// setFingerprintConfig({ device_pixel_ratio: 3 }) emits the JSON NUMBER 3, and
// FpConfigString("device_pixel_ratio") returns "" for a number. The key is
// silently inert: no error, no log, the real value is used.
//
// This was first found on audio_data_strength and believed to affect only that
// one key. It does not: 32 keys are read with FpConfigString, and 10 of 11
// measurable ones were confirmed inert as a number. device_pixel_ratio is the
// clearest case (string "3" -> dpr 3; number 3 -> dpr 1, unchanged).
//
// The CLIENT is safe: main.js:391 runs fpNormalizeConfig() before applying, so
// a user typing 3 into the JSON editor gets "3". The trap is for any caller
// that bypasses normalisation - scripts, tests, direct API use.
//
// So this test pins BOTH halves:
//   1. fpNormalizeConfig coerces a number to a string for every FpConfigString
//      key (the protection must exist).
//   2. The set of FpConfigString keys is enumerated from the delivered patches,
//      so a NEW string-read key added later is caught if it lacks coercion.
//
// Plain Node - no Electron needed.

'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..', 'Client');
const REPO = path.join(__dirname, '..');
const PATCHES = path.join(REPO, 'fingerprint', 'patches');

let pass = 0, fail = 0;
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

const { FP_KEYS, FP_KEY_NAMES } = require(path.join(CLIENT, 'fp-schema.js'));

// --- 1. enumerate every key the kernel reads with FpConfigString ------------
const readAs = {};
const re = /FpConfig(String|Int|Int64|Bool)\("([a-z0-9_]+)"/g;
let files = [];
try { files = fs.readdirSync(PATCHES).filter((f) => f.endsWith('.patch')); } catch (_) {}
for (const f of files) {
  const t = fs.readFileSync(path.join(PATCHES, f), 'utf8');
  let m;
  const r = new RegExp(re.source, 'g');
  while ((m = r.exec(t))) (readAs[m[2]] = readAs[m[2]] || new Set()).add(m[1]);
}
// helpers headers use the same readers
for (const h of ['fp_config_helpers.h', 'fp_ua_helpers.h']) {
  const p = path.join(REPO, 'fingerprint', 'helpers', h);
  if (!fs.existsSync(p)) continue;
  const t = fs.readFileSync(p, 'utf8');
  let m;
  const r = new RegExp(re.source, 'g');
  while ((m = r.exec(t))) (readAs[m[2]] = readAs[m[2]] || new Set()).add(m[1]);
}

const strKeys = FP_KEY_NAMES.filter((k) => readAs[k] && readAs[k].has('String'));
ck('found the kernel string-read keys', strKeys.length > 0, strKeys.length + ' keys');

// --- 2. fpNormalizeConfig must coerce a number to a string for each ---------
// A number that survives normalisation as a number is a key that will be inert
// for any caller using setFingerprintConfig directly.
const notCoerced = [];
for (const k of strKeys) {
  let out;
  try { out = (require(path.join(CLIENT, 'fp-schema.js')).fpNormalizeConfig({ [k]: 7 })).config; }
  catch (e) { notCoerced.push(k + ' (threw: ' + e.message + ')'); continue; }
  const v = out ? out[k] : undefined;
  if (typeof v !== 'string') notCoerced.push(k + ' -> ' + JSON.stringify(v) + ' (' + typeof v + ')');
}
ck('fpNormalizeConfig coerces a number to a string for every string-read key',
  notCoerced.length === 0,
  notCoerced.length ? notCoerced.slice(0, 6).join(' | ') : strKeys.length + ' keys coerced');

// --- 3. schema kind must agree with the kernel reader ----------------------
// A key the kernel reads as a string but the schema types as a number invites
// the caller to pass a number, which is exactly the inertness trap.
const kindMismatch = [];
for (const k of strKeys) {
  const kind = (FP_KEYS[k] || {}).kind;
  // csv / json / sp / bool are all string-on-the-wire; only int/int64 differ.
  if (kind === 'int' || kind === 'int64') {
    kindMismatch.push(k + ' (schema ' + kind + ', kernel reads String)');
  }
}
ck('no string-read key is typed as a number in the schema',
  kindMismatch.length === 0,
  kindMismatch.length ? kindMismatch.join(' | ') : '0 mismatches');

// --- 4. the two known instances stay pinned -------------------------------
// These were found by measurement, not by reading. Pinning them means a
// regression that reintroduces the number path on either fails here.
ck('audio_data_strength is string-read and coerced',
  strKeys.includes('audio_data_strength') &&
  typeof (require(path.join(CLIENT, 'fp-schema.js'))
    .fpNormalizeConfig({ audio_data_strength: 0.01 }).config.audio_data_strength) === 'string',
  'coerced');
ck('device_pixel_ratio is string-read and coerced',
  strKeys.includes('device_pixel_ratio') &&
  typeof (require(path.join(CLIENT, 'fp-schema.js'))
    .fpNormalizeConfig({ device_pixel_ratio: 3 }).config.device_pixel_ratio) === 'string',
  'coerced');

// --- 5. document the count -------------------------------------------------
// If this number grows, a new string-read key was added: check its coercion.
console.log('');
console.log('  (diagnostic) FpConfigString keys: ' + strKeys.length +
  ' of ' + FP_KEY_NAMES.length);
console.log(fail === 0
  ? 'PASS: ' + pass + ' checks'
  : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
process.exit(fail === 0 ? 0 : 1);
