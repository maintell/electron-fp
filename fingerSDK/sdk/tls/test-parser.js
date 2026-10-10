#!/usr/bin/env node
// Validate clienthello.js parser + probe against a KNOWN vector.
//
// Two layers:
//  1. Unit: a synthetic ClientHello built by hand, with known extension order,
//     cipher list and GREASE values -> assert exact JA3/JA4 fields.
//  2. Round-trip: real Node TLS client -> probe server -> real ClientHello parse.
//
// A parser that has only ever parsed its own output is not a verification tool,
// so layer 1 pins the arithmetic against hand-computed expectations.

'use strict';

const tls = require('tls');
const crypto = require('crypto');
const { parseClientHello, fingerprint, ja3, ja4, isGrease } = require('./clienthello.js');
const { startProbe } = require('./tls-probe.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

// ---------------------------------------------------------------------------
// Layer 1: synthetic ClientHello with hand-computed expectations
// ---------------------------------------------------------------------------
function buildHello({ ciphers, exts, groups, sigalgs, versions, alpn, sni, sessionId }) {
  const parts = [];
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
  const vec = (b, n) => Buffer.concat([n === 1 ? Buffer.from([b.length]) : u16(b.length), b]);

  let body = Buffer.concat([
    u16(0x0303),                       // legacy_version = TLS1.2
    Buffer.alloc(32, 0x42),            // random
    vec(sessionId || Buffer.alloc(0), 1),
    vec(Buffer.concat(ciphers.map(u16)), 2),
    vec(Buffer.from([0x00]), 1),       // compression_methods = [null]
  ]);

  const extBufs = [];
  if (sni !== undefined) {
    const host = Buffer.from(sni, 'utf8');
    const entry = Buffer.concat([
      Buffer.from([0x00]),
      (() => { const b = Buffer.alloc(2); b.writeUInt16BE(host.length); return b; })(),
      host,
    ]);
    const list = (() => { const b = Buffer.alloc(2); b.writeUInt16BE(entry.length); return b; })();
    extBufs.push(Buffer.concat([u16(0x0000), u16(list.length + entry.length), list, entry]));
  }
  if (groups) {
    const g = Buffer.concat(groups.map(u16));
    extBufs.push(Buffer.concat([u16(0x000a), u16(2 + g.length), u16(g.length), g]));
  }
  if (sigalgs) {
    const s = Buffer.concat(sigalgs.map(u16));
    extBufs.push(Buffer.concat([u16(0x000d), u16(2 + s.length), u16(s.length), s]));
  }
  if (versions) {
    const v = Buffer.concat(versions.map(u16));
    extBufs.push(Buffer.concat([u16(0x002b), u16(1 + v.length), Buffer.from([v.length]), v]));
  }
  if (alpn) {
    const entries = Buffer.concat(alpn.map((p) => {
      const pb = Buffer.from(p, 'utf8');
      return Buffer.concat([Buffer.from([pb.length]), pb]);
    }));
    extBufs.push(Buffer.concat([
      u16(0x0010),
      u16(2 + entries.length),
      u16(entries.length),
      entries,
    ]));
  }
  // Any remaining extension types (e.g. GREASE) with empty payloads
  for (const t of exts.filter((t) => ![0x0000, 0x000a, 0x000d, 0x002b, 0x0010].includes(t))) {
    extBufs.push(Buffer.concat([u16(t), u16(0)]));
  }

  const extAll = Buffer.concat(extBufs);
  body = Buffer.concat([body, u16(extAll.length), extAll]);

  const hs = Buffer.concat([Buffer.from([0x01]), Buffer.from([0x00, 0x00, 0x00]), body]);
  hs.writeUIntBE(body.length, 1, 3);
  // Wrap in a TLS record so we also exercise record unwrapping
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(hs.length), hs]);
}

// Known vector
const GREASE1 = 0x0a0a, GREASE2 = 0x1a1a;
const hello = buildHello({
  ciphers: [GREASE1, 0x1301, 0x1302, 0x1303],
  exts: [GREASE2, 0x0000, 0x000a, 0x000d, 0x002b, 0x0010],
  groups: [0x001d, 0x0017],
  sigalgs: [0x0403, 0x0804],
  versions: [0x0304, 0x0303],
  alpn: ['h2', 'http/1.1'],
  sni: 'example.com',
  sessionId: Buffer.alloc(0),
});

const ch = parseClientHello(hello);

check('parse: legacy_version 0x0303', ch.legacyVersion === 0x0303, hexs(ch.legacyVersion));
check('parse: 4 cipher suites', ch.cipherSuites.length === 4, String(ch.cipherSuites.length));
check('parse: GREASE cipher detected', ch.grease.cipherSuites.length === 1 && ch.grease.cipherSuites[0] === GREASE1);
check('parse: 6 extensions', ch.extTypes.length === 6, String(ch.extTypes.length));
check('parse: GREASE extension detected', ch.grease.extensions.length === 1 && ch.grease.extensions[0] === GREASE2);
// The builder emits structured extensions first, then appends GREASE last,
// so expected order = [sni, groups, sigalgs, versions, alpn, GREASE2].
// Order preservation is the point: JA4 depends on it via sorted-ext hashing
// and JA3 depends on it via the verbatim extension list.
check('parse: extension ORDER preserved', ch.extTypes.join(',') === [0,0x0a,0x0d,0x2b,0x10,GREASE2].join(','), ch.extTypes.join(','));
check('parse: supported_groups', ch.supportedGroups.join(',') === '29,23', ch.supportedGroups.join(','));
check('parse: signature_algorithms', ch.signatureAlgorithms.join(',') === '1027,2052', ch.signatureAlgorithms.join(','));
check('parse: supported_versions', ch.supportedVersions.join(',') === '772,771', ch.supportedVersions.join(','));
check('parse: ALPN h2,http/1.1', ch.alpn.join(',') === 'h2,http/1.1', ch.alpn.join(','));
check('parse: SNI example.com', ch.sni === 'example.com', String(ch.sni));

function hexs(n) { return '0x' + n.toString(16); }

// JA3: GREASE excluded. ciphers = 1301,1302,1303 = 4865,4866,4867
const j3 = ja3(ch);
check('ja3: excludes GREASE from ciphers', j3.str.split(',')[1] === '4865-4866-4867', j3.str);
check('ja3: excludes GREASE from extensions', j3.str.split(',')[2] === '0-10-13-43-16', j3.str);
check('ja3: version field 771', j3.str.split(',')[0] === '771', j3.str);
const expectJa3Hash = crypto.createHash('md5').update(j3.str).digest('hex');
check('ja3: hash matches md5(str)', j3.hash === expectJa3Hash);

// JA4: t (tcp) + 3 (tls1.3) + d (sni) + 03 (3 non-grease ciphers) + 05 (5 non-grease exts) + first/last of 'h2' = 'h2'
const j4 = ja4(ch);
check('ja4: a1 = t13d0305h2', j4.raw.a1 === 't13d0305h2', j4.raw.a1);
check('ja4: a2 sorted ciphers', j4.raw.a2Raw === '4865,4866,4867', j4.raw.a2Raw);
check('ja4: a3 excludes SNI(0) and ALPN(16)', j4.raw.a3Raw === '10,13,43_1027,2052', j4.raw.a3Raw);
check('ja4: str shape a_b_c', /^t13d0305h2_[0-9a-f]{12}_[0-9a-f]{12}$/.test(j4.str), j4.str);

// isGrease sanity across the RFC 8701 range
check('isGrease: 0x0a0a true', isGrease(0x0a0a) === true);
check('isGrease: 0xfafa true', isGrease(0xfafa) === true);
check('isGrease: 0x1301 false', isGrease(0x1301) === false);
check('isGrease: 0x0a0b false', isGrease(0x0a0b) === false);

// ---------------------------------------------------------------------------
// Layer 2: real round-trip through the probe
// ---------------------------------------------------------------------------
(async () => {
  const probe = await startProbe({ port: 0 });
  const host = '127.0.0.1';

  const client = tls.connect({
    host,
    port: probe.port,
    servername: 'fp-probe.local',
    ALPNProtocols: ['h2', 'http/1.1'],
    rejectUnauthorized: false,
  });
  client.on('error', () => {});

  let sample = null;
  try {
    sample = await probe.waitForSample(15000);
  } catch (e) {
    check('roundtrip: captured ClientHello', false, e.message);
  }
  client.destroy();

  if (sample) {
    check('roundtrip: captured ClientHello', sample.helloLen > 0, String(sample.helloLen));
    if (sample.fp && !sample.fp.error) {
      const f = sample.fp;
      check('roundtrip: real ClientHello has ciphers', f.cipherSuites.length > 0, String(f.cipherSuites.length));
      check('roundtrip: real ClientHello has extensions', f.extensions.length > 0, String(f.extensions.length));
      check('roundtrip: JA3 computed', /^[0-9a-f]{32}$/.test(f.ja3.hash), f.ja3.hash);
      check('roundtrip: JA4 computed', /^[a-z0-9]{10}_[0-9a-f]{12}_[0-9a-f]{12}$/.test(f.ja4.str), f.ja4.str);
      check('roundtrip: SNI captured', f.tls.sni === 'fp-probe.local', String(f.tls.sni));
      check('roundtrip: ALPN captured', f.tls.alpn.includes('h2') || f.tls.alpn.includes('http/1.1'), JSON.stringify(f.tls.alpn));
      console.log('\n--- real Node TLS ClientHello ---');
      console.log('JA3: ' + f.ja3.hash);
      console.log('JA4: ' + f.ja4.str);
      console.log('ciphers(' + f.cipherSuiteCount + '): ' + f.cipherSuites.join(' '));
      console.log('extensions(' + f.extensionCount + '): ' + f.extensions.join(' '));
      console.log('groups: ' + f.supportedGroups.join(' '));
      console.log('GREASE count: ' + f.grease.count);
    } else {
      check('roundtrip: parsed without error', false, JSON.stringify(sample.fp && sample.fp.error));
    }
  }

  await probe.close();

  console.log('\nTOTAL: pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})();
