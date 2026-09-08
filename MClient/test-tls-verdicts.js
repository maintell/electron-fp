'use strict';
// The TLS verdict table: given a captured ClientHello and a config, does it
// reach the right verdict?
//
// These run in plain Node (tls-probe.js keeps its pure functions loadable
// without Electron), because the comparison logic is where the mistakes live
// and a module only testable under a browser would not get tested.
//
// The three-valued contract from fp-probe.js applies here too: 'unknown' means
// "cannot be judged from this observable", and it must never be reported as
// pass. An unmeasurable key that reads "pass" is worse than one that reads
// "skip", because it tells the user a fingerprint is confirmed when it is not.
const { tlsVerdicts, parseClientHello } = require('./tls-probe');

let pass = 0, fail = 0;
const ck = (n, ok, d) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  (' + d + ')' : ''));
  ok ? pass++ : fail++;
};

const ALL = () => true;   // treat every key as configured

// A realistic native-ish ClientHello: GREASE present, session_ticket + ALPN.
const BASE = {
  legacyVersion: 771,
  ciphers: ['fafa', '1301', '1302', '1303', 'c02b'],
  cipherCount: 5,
  extTypes: [14906, 65037, 51, 11, 35, 16],
  extCount: 6,
  greaseCipherCount: 1,
  greaseExtCount: 2,
  hasSessionTicket: true,
  hasAlpn: true,
  ja3: '771,1301-1302-1303-c02b,51-11-35-16,,',
};
// The same handshake with GREASE off and both optional extensions dropped.
const NEG = {
  legacyVersion: 771,
  ciphers: ['1301', '1302', '1303', 'c02b'],
  cipherCount: 4,
  extTypes: [51, 11, 35, 16],
  extCount: 4,
  greaseCipherCount: 0,
  greaseExtCount: 0,
  hasSessionTicket: false,
  hasAlpn: false,
  ja3: '771,1301-1302-1303-c02b,51-11-35-16,,',
};

const v1 = (cfg, hello, baseline) => tlsVerdicts(cfg, hello, baseline, ALL).rows[0];

// --- GREASE ---------------------------------------------------------------
ck('GREASE off and no GREASE present -> pass',
  v1({ fpGreaseEnabled: false }, NEG).verdict === 'pass');
ck('GREASE off but GREASE still present -> fail',
  v1({ fpGreaseEnabled: false }, BASE).verdict === 'fail');
ck('GREASE on and GREASE present -> pass',
  v1({ fpGreaseEnabled: true }, BASE).verdict === 'pass');
ck('GREASE on but none present -> fail',
  v1({ fpGreaseEnabled: true }, NEG).verdict === 'fail');

// --- session ticket / ALPN -------------------------------------------------
ck('omit session_ticket and it is absent -> pass',
  v1({ fpOmitSessionTicket: true }, NEG).verdict === 'pass');
ck('omit session_ticket but it is present -> fail',
  v1({ fpOmitSessionTicket: true }, BASE).verdict === 'fail');
ck('omit ALPN and it is absent -> pass',
  v1({ fpOmitAlpn: true }, NEG).verdict === 'pass');
ck('omit ALPN but it is present -> fail',
  v1({ fpOmitAlpn: true }, BASE).verdict === 'fail');

// --- keys that need a baseline --------------------------------------------
ck('cipher list without a baseline -> unknown, NOT pass',
  v1({ fpCipherList: 'ECDHE-RSA-AES128-GCM-SHA256' }, BASE, null).verdict === 'unknown');
ck('cipher list that changed the offered set -> pass',
  v1({ fpCipherList: 'ECDHE-RSA-AES128-GCM-SHA256' }, NEG, BASE).verdict === 'pass');
ck('cipher list identical to native -> fail',
  v1({ fpCipherList: 'ECDHE-RSA-AES128-GCM-SHA256' }, BASE, BASE).verdict === 'fail');
ck('max version without a baseline -> unknown',
  v1({ fpAdvertisedVersionMax: 771 }, BASE, null).verdict === 'unknown');
ck('max version that changed the offered set -> pass',
  v1({ fpAdvertisedVersionMax: 771 }, NEG, BASE).verdict === 'pass');
ck('permute extensions without a baseline -> unknown',
  v1({ fpPermuteExtensions: true }, BASE, null).verdict === 'unknown');
ck('permute extensions with a changed order -> pass',
  v1({ fpPermuteExtensions: true }, NEG, BASE).verdict === 'pass');
ck('permute extensions with an identical order -> fail',
  v1({ fpPermuteExtensions: true }, BASE, BASE).verdict === 'fail');

// --- extension order: the only key with an exact assertion ----------------
ck('extension order present and in order -> pass',
  v1({ fpExtensionOrder: [51, 11] }, BASE).verdict === 'pass');
ck('extension order present but reversed -> fail',
  v1({ fpExtensionOrder: [11, 51] }, BASE).verdict === 'fail');
ck('extension order naming a missing type -> fail',
  v1({ fpExtensionOrder: [999] }, BASE).verdict === 'fail');
ck('extension order failure says which are missing',
  /missing extensions: 999/.test(v1({ fpExtensionOrder: [999] }, BASE).reason));

// --- the "cannot judge" case ----------------------------------------------
// Disabling GREASE sigalgs is indistinguishable from GREASE being off
// entirely, so it must be unknown rather than a guess.
ck('GREASE sigalgs disabled -> unknown (indistinguishable)',
  v1({ fpGreaseSigalgsEnabled: false }, BASE).verdict === 'unknown');
ck('GREASE sigalgs enabled and GREASE ext present -> pass',
  v1({ fpGreaseSigalgsEnabled: true }, BASE).verdict === 'pass');

// --- no hello at all -> error, never pass ---------------------------------
const rows = tlsVerdicts({ fpGreaseEnabled: false }, null, BASE, ALL).rows;
ck('a missing ClientHello yields error, not pass',
  rows.length === 1 && rows[0].verdict === 'error',
  rows[0] ? rows[0].verdict : 'no rows');

// --- inactive keys are skipped entirely ----------------------------------
const inactive = tlsVerdicts({ fpGreaseEnabled: '', fpOmitAlpn: true }, NEG,
  BASE, (k, v) => v !== undefined && v !== null && v !== '').rows;
ck('an inactive key produces no row at all',
  inactive.length === 1 && inactive[0].key === 'fpOmitAlpn',
  inactive.map((r) => r.key).join(',') || 'none');

// --- summary counts -------------------------------------------------------
// fpCipherList against NEG/BASE passes (the offered set DID change), so the
// unknown here has to come from GREASE-sigalgs-disabled, which is genuinely
// indistinguishable and must be counted as unknown rather than pass.
const s = tlsVerdicts(
  { fpGreaseEnabled: false, fpOmitAlpn: true, fpGreaseSigalgsEnabled: false },
  NEG, BASE, ALL);
ck('summary counts pass and unknown correctly',
  s.summary.pass === 2 && s.summary.unknown === 1,
  JSON.stringify(s.summary));
// With no baseline at all, every baseline-dependent key must read unknown.
const noBase = tlsVerdicts(
  { fpCipherList: 'ECDHE-RSA-AES128-GCM-SHA256', fpAdvertisedVersionMax: 771,
    fpPermuteExtensions: true, fpSignatureAlgorithms: [1027, 1283] },
  BASE, null, ALL);
ck('without a baseline every dependent key reads unknown',
  noBase.summary.unknown === 4 && noBase.summary.pass === 0,
  JSON.stringify(noBase.summary));

// --- parser ---------------------------------------------------------------
ck('parser rejects a non-TLS buffer', parseClientHello(Buffer.from('hello')) === null);
ck('parser rejects a truncated buffer', parseClientHello(Buffer.alloc(10)) === null);
ck('parser rejects null', parseClientHello(null) === null);

console.log('\n' + (fail === 0
  ? 'PASS: ' + pass + ' checks'
  : 'FAIL: ' + fail + ' of ' + (pass + fail) + ' checks failed'));
process.exit(fail === 0 ? 0 : 1);
