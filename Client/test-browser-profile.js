#!/usr/bin/env node
'use strict';
/**
 * Tests for BrowserProfile: the data model and its cross-layer consistency
 * self-check.
 *
 * The point of the self-check is to catch a profile that is individually
 * plausible but mutually contradictory - which is MORE detectable than not
 * spoofing at all. So the important assertions here are not "a clean profile
 * is clean" but:
 *   - each rule actually FIRES on its specific contradiction, and
 *   - a rule that cannot evaluate says so instead of passing quietly.
 * The second is what stops this from becoming a green check that checks
 * nothing, which is exactly how the gin-whitelist bug survived earlier.
 *
 * Pure JS, no Electron: runs under plain node.
 */

const bp = require('./browser-profile.js');
const S = require('./fp-schema.js');

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond === null || cond === undefined) { skip++; console.log('SKIP  ' + name + (detail ? ': ' + detail : '')); return; }
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? ': ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
}

const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const ids = (r) => r.findings.map((f) => f.id);
const has = (r, id) => ids(r).includes(id);

// --- construction ---------------------------------------------------------

const empty = bp.createProfile({ id: 'empty' });
check('createProfile: empty profile has no active keys',
  bp.summary(empty).active === 0, String(bp.summary(empty).active));

// user_agent is NOT one of the 63 fp_* keys. Passing it as a config key must be
// reported as unknown rather than dropped in silence - otherwise a caller could
// believe the UA is part of the profile while normalization quietly discards it
// and every UA-anchored rule goes dead.
const withUaAsKey = bp.createProfile({ id: 'x', config: { user_agent: UA_WIN } });
check('createProfile: an fp-unknown key is reported, not silently dropped',
  withUaAsKey.unknownKeys.includes('user_agent'),
  JSON.stringify(withUaAsKey.unknownKeys));
check('createProfile: unknown keys do NOT reach the config',
  withUaAsKey.config.user_agent === undefined);

const win = bp.createProfile({
  id: 'win', name: 'Windows Chrome', userAgent: UA_WIN,
  config: {
    navigator_platform: 'Win32', navigator_vendor: 'Google Inc.',
    ua_platform: 'Windows', ua_mobile: 'false',
    max_touch_points: 0, device_memory: 8,
    screen_width: 1920, screen_height: 1080,
    screen_avail_width: 1920, screen_avail_height: 1040,
  },
});
check('createProfile: UA stored on the profile (not in config)',
  win.userAgent === UA_WIN, win.userAgent.slice(0, 30) + '...');
check('createProfile: normalized config keeps the set values',
  win.config.device_memory === 8 && win.config.navigator_platform === 'Win32',
  'dm=' + win.config.device_memory + ' plat=' + win.config.navigator_platform);
check('summary: counts the 9 active keys',
  bp.summary(win).active === 9, String(bp.summary(win).active));

// --- immutability ---------------------------------------------------------

const mutated = bp.withConfig(win, { navigator_platform: 'MacIntel' });
check('withConfig: returns a new profile, does not mutate',
  win.config.navigator_platform === 'Win32' &&
  mutated.config.navigator_platform === 'MacIntel',
  'orig=' + win.config.navigator_platform + ' new=' + mutated.config.navigator_platform);
check('withConfig: preserves the UA when none is given',
  mutated.userAgent === UA_WIN);
check('withConfig: replaces the UA when given',
  bp.withConfig(win, {}, UA_MAC).userAgent === UA_MAC);

// --- every rule fires on its own contradiction ----------------------------

check('empty profile: ALL rules skip (none silently passes)',
  bp.checkConsistency(empty).skipCount === bp.rules().length,
  bp.checkConsistency(empty).skipCount + '/' + bp.rules().length);

const good = bp.checkConsistency(win);
check('consistent Windows profile: no errors', good.errorCount === 0,
  JSON.stringify(ids(good)));
check('consistent Windows profile: no warnings', good.warnCount === 0,
  JSON.stringify(ids(good)));

const badPlatform = bp.checkConsistency(bp.withConfig(win, { navigator_platform: 'MacIntel' }));
check('rule platform-matches-ua FIRES on Win UA + MacIntel',
  !badPlatform.ok && has(badPlatform, 'platform-matches-ua'),
  JSON.stringify(ids(badPlatform)));
check('rule platform-matches-ua is severity=error',
  (badPlatform.findings.find((f) => f.id === 'platform-matches-ua') || {}).severity === 'error');

const badVendor = bp.checkConsistency(bp.withConfig(win, { navigator_vendor: 'Apple Computer, Inc.' }));
check('rule vendor-matches-ua FIRES on Win UA + Apple vendor',
  has(badVendor, 'vendor-matches-ua'), JSON.stringify(ids(badVendor)));

const badChPlatform = bp.checkConsistency(bp.withConfig(win, { ua_platform: 'macOS' }));
check('rule ua-platform-ch-matches-ua FIRES on Win UA + macOS hint',
  has(badChPlatform, 'ua-platform-ch-matches-ua'), JSON.stringify(ids(badChPlatform)));

const badMobile = bp.checkConsistency(bp.withConfig(win, { ua_mobile: 'true' }));
check('rule ua-mobile-matches-ua FIRES on desktop UA + ua_mobile=true',
  has(badMobile, 'ua-mobile-matches-ua'), JSON.stringify(ids(badMobile)));

// The string "false" must NOT be treated as truthy - otherwise every desktop
// profile would be reported as claiming to be mobile.
check('ua_mobile string "false" is NOT read as mobile',
  !has(bp.checkConsistency(win), 'ua-mobile-matches-ua'));

const desktopTouch = bp.checkConsistency(bp.withConfig(win, { max_touch_points: 5 }));
check('rule mobile-hardware-consistent WARNS on desktop UA + touch points',
  has(desktopTouch, 'mobile-hardware-consistent'), JSON.stringify(ids(desktopTouch)));

const badMem = bp.checkConsistency(bp.withConfig(win, { device_memory: 7 }));
check('rule device-memory-plausible WARNS on a non-power-of-two value',
  has(badMem, 'device-memory-plausible'), JSON.stringify(ids(badMem)));
check('rule device-memory-plausible accepts 8',
  !has(bp.checkConsistency(win), 'device-memory-plausible'));

const badScreen = bp.checkConsistency(bp.withConfig(win, { screen_avail_width: 2560 }));
check('rule screen-dimensions-plausible WARNS when avail exceeds screen',
  has(badScreen, 'screen-dimensions-plausible'), JSON.stringify(ids(badScreen)));

const loneIp = bp.checkConsistency(bp.withConfig(win, { webrtc_ip: '1.2.3.4' }));
check('rule webrtc-ip-requires-network-group WARNS on a lone webrtc_ip',
  has(loneIp, 'webrtc-ip-requires-network-group'), JSON.stringify(ids(loneIp)));
const pairedIp = bp.checkConsistency(
  bp.withConfig(win, { webrtc_ip: '1.2.3.4', net_effective_type: '4g' }));
check('rule webrtc-ip-requires-network-group passes when other net keys are set',
  !has(pairedIp, 'webrtc-ip-requires-network-group'), JSON.stringify(ids(pairedIp)));

// --- a mobile profile built correctly must be clean -----------------------

const iphone = bp.createProfile({
  id: 'iphone', userAgent: UA_IPHONE,
  config: {
    navigator_platform: 'iPhone', navigator_vendor: 'Apple Computer, Inc.',
    ua_platform: 'iOS', ua_mobile: 'true',
    max_touch_points: 5, device_memory: 4,
    screen_width: 390, screen_height: 844,
    screen_avail_width: 390, screen_avail_height: 664,
  },
});
const ip = bp.checkConsistency(iphone);
check('consistent iPhone profile: clean', ip.errorCount === 0 && ip.warnCount === 0,
  JSON.stringify(ids(ip)));
check('iPhone with no touch points WARNS (real phones report touch)',
  has(bp.checkConsistency(bp.withConfig(iphone, { max_touch_points: 0 })),
    'mobile-hardware-consistent'));

// --- the shipped presets must be consistent -------------------------------
// If a profile we ship contradicts itself, that is a real bug in the presets,
// and it is the single most valuable thing this file checks.

const presets = require('./profiles.json').profiles || [];
check('shipped presets: found', presets.length > 0, String(presets.length));
let presetErrors = 0;
for (const p of presets) {
  if (!p.fingerprint) continue;                 // "no fingerprint" is valid
  const prof = bp.createProfile({
    id: p.id, name: p.name, userAgent: p.userAgent || '',
    config: p.fingerprint,
  });
  const r = bp.checkConsistency(prof);
  if (r.errorCount > 0) {
    presetErrors++;
    r.findings.filter((f) => f.severity === 'error')
      .forEach((f) => console.log('      preset "' + p.id + '": ' + f.id + ' - ' + f.message));
  }
}
check('shipped presets: none has a cross-layer ERROR',
  presetErrors === 0, presetErrors ? presetErrors + ' preset(s) inconsistent' : 'all clean');

// --- rules catalogue ------------------------------------------------------

const rules = bp.rules();
check('rules: every rule has id/severity/describe',
  rules.every((r) => r.id && r.severity && r.describe), String(rules.length));
check('rules: ids are unique',
  new Set(rules.map((r) => r.id)).size === rules.length);
check('rules: severities are known values',
  rules.every((r) => r.severity === 'error' || r.severity === 'warn'));

console.log('');
console.log(fail === 0 ? 'PASS: ' + pass + ' checks' : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks');
process.exit(fail === 0 ? 0 : 1);
