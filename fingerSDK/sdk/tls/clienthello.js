#!/usr/bin/env node
// Parse a raw TLS ClientHello captured off the wire and compute JA3 + JA4.
//
// Why this exists:
//   JA3/JA4 are DERIVED quantities. Per the task constraints we must never
//   hardcode "JA3 = xxx"; we must show the raw ClientHello and let the hash
//   fall out of it. This module is the single place that turns bytes -> facts.
//
// The probe (tls-probe.js) reads the first bytes on the socket BEFORE the TLS
// handshake is driven, so we get the ClientHello verbatim - including GREASE
// values, which is exactly what browser fingerprinting services see.
//
// JA4 spec: https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4.md
// JA4 keeps raw fields SEPARATE from the final hash, so we retain both.

'use strict';

const crypto = require('crypto');

// TLS content type / handshake type
const HANDSHAKE = 0x16;
const CLIENT_HELLO = 0x01;

// TLS extension types we care about
const EXT = {
  SERVER_NAME: 0x0000,
  ALPN: 0x0010,
  SUPPORTED_VERSIONS: 0x002b,
  SUPPORTED_GROUPS: 0x000a,
  KEY_SHARE: 0x0033,
  SIGNATURE_ALGORITHMS: 0x000d,
  SESSION_TICKET: 0x0023,
  PSK_KEY_EXCHANGE_MODES: 0x002d,
  PADDING: 0x0015,
  APPLICATION_SETTINGS: 0x4469, // ALPS
  APPLICATION_SETTINGS_NEW: 0x446a, // ALPS new codepoint
  COMPRESS_CERTIFICATE: 0x001b,
  ENCRYPTED_CLIENT_HELLO: 0xfe0d,
  GREASE_MIN: 0x0a0a,
};

// RFC 8701 GREASE values (0x?A0A where both bytes identical, low nibble 0xA)
function isGrease(v16) {
  return (v16 & 0x0f0f) === 0x0a0a;
}

// BoringSSL GREASE is 0x?A?A -> e.g. 0x0a0a, 0x1a1a ... 0xfafa
const GREASE_SET = new Set();
for (let hi = 0; hi <= 0xf; hi++) {
  GREASE_SET.add((hi << 12) | (0xa << 8) | (hi << 4) | 0xa);
}

class Reader {
  constructor(buf) {
    this.b = buf;
    this.o = 0;
  }
  get remaining() {
    return this.b.length - this.o;
  }
  u8() {
    if (this.remaining < 1) throw new Error('u8 overrun');
    return this.b[this.o++];
  }
  u16() {
    if (this.remaining < 2) throw new Error('u16 overrun');
    const v = this.b.readUInt16BE(this.o);
    this.o += 2;
    return v;
  }
  u32() {
    if (this.remaining < 4) throw new Error('u32 overrun');
    const v = this.b.readUInt32BE(this.o);
    this.o += 4;
    return v;
  }
  bytes(n) {
    if (this.remaining < n) throw new Error(`bytes(${n}) overrun`);
    const v = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return v;
  }
  vec(lenBytes) {
    const n = lenBytes === 1 ? this.u8() : lenBytes === 2 ? this.u16() : this.u32();
    return this.bytes(n);
  }
}

/**
 * Parse a raw ClientHello (handshake message body, i.e. WITHOUT the 5-byte
 * TLS record header) or a full TLS record. Accepts either.
 */
function parseClientHello(raw) {
  let buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  let r = new Reader(buf);

  // If it starts with a TLS record header (0x16 0x03 0x0x), unwrap it.
  // There may be multiple records; ClientHello is the first handshake record.
  if (r.remaining >= 5 && buf[0] === HANDSHAKE && buf[1] === 0x03) {
    const recLen = buf.readUInt16BE(3);
    buf = buf.subarray(5, 5 + recLen);
    r = new Reader(buf);
  }

  // Handshake header: type(1) + length(3)
  const hsType = r.u8();
  if (hsType !== CLIENT_HELLO) {
    throw new Error(`not a ClientHello (handshake type 0x${hsType.toString(16)})`);
  }
  const hsLen = (r.u8() << 16) | (r.u8() << 8) | r.u8();
  if (hsLen > r.remaining) {
    throw new Error(`truncated ClientHello: need ${hsLen}, have ${r.remaining}`);
  }
  const body = new Reader(r.bytes(hsLen));
  const b = body;

  const legacyVersion = b.u16();
  const random = b.bytes(32);
  const sessionIdLen = b.u8();
  const sessionId = b.bytes(sessionIdLen); // JA4: non-empty => session resumption attempt
  const cipherSuitesLen = b.u16();
  const cipherSuitesRaw = b.bytes(cipherSuitesLen);
  const cipherSuites = [];
  for (let i = 0; i + 1 < cipherSuitesRaw.length; i += 2) {
    cipherSuites.push(cipherSuitesRaw.readUInt16BE(i));
  }

  const compressionLen = b.u8();
  const compressionMethods = b.bytes(compressionLen);

  let extensionsRaw = Buffer.alloc(0);
  if (b.remaining >= 2) {
    const extLen = b.u16();
    extensionsRaw = b.bytes(extLen);
  }

  const extensions = [];
  const extByName = {};
  const e = new Reader(extensionsRaw);
  while (e.remaining >= 4) {
    const type = e.u16();
    const len = e.u16();
    const data = e.bytes(len);
    extensions.push({ type, len, data });
    if (!(type in extByName)) extByName[type] = data;
  }

  // --- supported_versions (RFC 8446): real negotiated-version list ---
  const supportedVersions = [];
  if (extByName[EXT.SUPPORTED_VERSIONS]) {
    const v = new Reader(extByName[EXT.SUPPORTED_VERSIONS]);
    const n = v.u8();
    for (let i = 0; i < n && v.remaining >= 2; i++) supportedVersions.push(v.u16());
  }

  // --- supported_groups ---
  const supportedGroups = [];
  if (extByName[EXT.SUPPORTED_GROUPS]) {
    const v = new Reader(extByName[EXT.SUPPORTED_GROUPS]);
    const n = v.u16();
    for (let i = 0; i < n && v.remaining >= 2; i++) supportedGroups.push(v.u16());
  }

  // --- key_share: list of (group, keyLen) ---
  const keyShares = [];
  if (extByName[EXT.KEY_SHARE]) {
    const v = new Reader(extByName[EXT.KEY_SHARE]);
    const total = v.u16();
    const sub = new Reader(v.bytes(Math.min(total, v.remaining)));
    while (sub.remaining >= 4) {
      const group = sub.u16();
      const klen = sub.u16();
      if (sub.remaining < klen) break;
      sub.bytes(klen);
      keyShares.push({ group, keyLen: klen });
    }
  }

  // --- signature_algorithms ---
  const signatureAlgorithms = [];
  if (extByName[EXT.SIGNATURE_ALGORITHMS]) {
    const v = new Reader(extByName[EXT.SIGNATURE_ALGORITHMS]);
    const n = v.u16();
    for (let i = 0; i < n && v.remaining >= 2; i++) signatureAlgorithms.push(v.u16());
  }

  // --- ALPN ---
  const alpn = [];
  if (extByName[EXT.ALPN]) {
    const v = new Reader(extByName[EXT.ALPN]);
    const n = v.u16();
    const sub = new Reader(v.bytes(Math.min(n, v.remaining)));
    while (sub.remaining >= 1) {
      const l = sub.u8();
      if (sub.remaining < l) break;
      alpn.push(sub.bytes(l).toString('utf8'));
    }
  }

  // --- SNI ---
  let sni = null;
  if (extByName[EXT.SERVER_NAME]) {
    try {
      const v = new Reader(extByName[EXT.SERVER_NAME]);
      v.u16(); // server_name_list length
      const t = v.u8(); // name_type (0 = host_name)
      const l = v.u16();
      if (t === 0) sni = v.bytes(l).toString('utf8');
    } catch (_) {
      /* malformed SNI: leave null, don't fail the whole parse */
    }
  }

  const extTypes = extensions.map((x) => x.type);
  const hasSessionTicket = extByName[EXT.SESSION_TICKET] !== undefined;
  const hasPskModes = extByName[EXT.PSK_KEY_EXCHANGE_MODES] !== undefined;
  const hasPadding = extByName[EXT.PADDING] !== undefined;
  const hasEch = extByName[EXT.ENCRYPTED_CLIENT_HELLO] !== undefined;

  return {
    legacyVersion,
    random,
    sessionId,
    cipherSuites,
    compressionMethods,
    extensions,
    extTypes,
    extByName,
    supportedVersions,
    supportedGroups,
    keyShares,
    signatureAlgorithms,
    alpn,
    sni,
    hasSessionTicket,
    hasPskModes,
    hasPadding,
    hasEch,
    // GREASE detection: RFC 8701 reserved values used to prevent extensibility
    // ossification. Their presence/absence is itself fingerprintable, and the
    // FIRST ClientHello differs from later ones because GREASE is randomized.
    grease: {
      cipherSuites: cipherSuites.filter(isGrease),
      extensions: extTypes.filter(isGrease),
      supportedGroups: supportedGroups.filter(isGrease),
      signatureAlgorithms: signatureAlgorithms.filter(isGrease),
      supportedVersions: supportedVersions.filter(isGrease),
    },
  };
}

// ---------------------------------------------------------------------------
// JA3: TLSVersion,Ciphers,Extensions,EllipticCurves,EllipticCurvePointFormats
// GREASE values are IGNORED (that is the JA3 convention).
// ---------------------------------------------------------------------------
function ja3(ch) {
  const ciphers = ch.cipherSuites.filter((c) => !isGrease(c)).join('-');
  const exts = ch.extTypes.filter((t) => !isGrease(t)).join('-');
  const groups = ch.supportedGroups.filter((g) => !isGrease(g)).join('-');
  const ecFmt = Array.from(ch.compressionMethods).join('-');
  const ver = ch.legacyVersion;
  const str = [ver, ciphers, exts, groups, ecFmt].join(',');
  return { str, hash: crypto.createHash('md5').update(str).digest('hex') };
}

// ---------------------------------------------------------------------------
// JA4 (FoxIO). Format:  <p><vv><d><cc><bb><aa>_<b>_<a>
//   p   = protocol: 't' TCP / 'q' QUIC / 'd' DTLS
//   vv  = TLS version, TWO digits: "13" TLS1.3, "12" TLS1.2, "11", "10",
//         "s3" SSL3. This is the highest supported_versions entry (or legacy
//         version when the extension is absent). NOTE: two characters - a
//         common bug is emitting a single digit.
//   d   = SNI present ('d' domain / 'i' IP)
//   cc  = number of ciphers (2 digits, capped 99) excluding GREASE
//   bb  = number of extensions excluding GREASE (2 digits)
//   aa  = first+last char of the first ALPN, '00' if none
//   part2 (b) = sha256(sorted ciphers joined by ',')  -> first 12 hex
//   part3 (a) = sha256(sorted extensions except SNI/ALPN, '_', sigalgs)
// ---------------------------------------------------------------------------
function ja4(ch, { protocol = 't' } = {}) {
  const noGreaseCiphers = ch.cipherSuites.filter((c) => !isGrease(c));
  const noGreaseExts = ch.extTypes.filter((t) => !isGrease(t));
  const noGreaseSigAlgs = ch.signatureAlgorithms.filter((s) => !isGrease(s));

  // TLS version: prefer supported_versions max, fall back to legacy.
  // Emitted as TWO characters per the JA4 spec ("13", "12", "11", "10").
  let ver = ch.legacyVersion;
  const sv = ch.supportedVersions.filter((v) => !isGrease(v));
  if (sv.length) ver = Math.max(...sv);
  const t =
    ver === 0x0304 ? '13' :
    ver === 0x0303 ? '12' :
    ver === 0x0302 ? '11' :
    ver === 0x0301 ? '10' :
    ver === 0x0300 ? 's3' : '00';

  const d = ch.sni ? 'd' : 'i';
  const c = String(Math.min(noGreaseCiphers.length, 99)).padStart(2, '0');
  const b = String(Math.min(noGreaseExts.length, 99)).padStart(2, '0');

  let a = '00';
  if (ch.alpn.length) {
    const first = ch.alpn[0];
    // use first and last char of the first ALPN
    a = (first[0] || '0') + (first[first.length - 1] || '0');
    a = a.toLowerCase().replace(/[^a-z0-9]/g, '0');
  }

  const a1 = `${protocol}${t}${d}${c}${b}${a}`;

  const sortedCiphers = [...noGreaseCiphers].sort((x, y) => x - y);
  const a2Raw = sortedCiphers.join(',');
  const a2 = crypto.createHash('sha256').update(a2Raw).digest('hex').slice(0, 12);

  // Extensions excluding SNI (0x0000) and ALPN (0x0010), sorted, then '_' + sigalgs
  const extSorted = [...noGreaseExts]
    .filter((t) => t !== EXT.SERVER_NAME && t !== EXT.ALPN)
    .sort((x, y) => x - y);
  const sigSorted = [...noGreaseSigAlgs].sort((x, y) => x - y);
  const a3Raw = extSorted.join(',') + '_' + sigSorted.join(',');
  const a3 = crypto.createHash('sha256').update(a3Raw).digest('hex').slice(0, 12);

  return {
    str: `${a1}_${a2}_${a3}`,
    raw: { a1, a2Raw, a3Raw, ver, sortedCiphers, extSorted, sigSorted },
  };
}

function hex(n, width = 4) {
  return '0x' + n.toString(16).padStart(width, '0');
}

/** Full fingerprint report for one ClientHello. */
function fingerprint(rawClientHello, opts) {
  const ch = parseClientHello(rawClientHello);
  const j3 = ja3(ch);
  const j4 = ja4(ch, opts);
  return {
    tls: {
      legacyVersion: hex(ch.legacyVersion),
      supportedVersions: ch.supportedVersions.map((v) => hex(v)),
      sni: ch.sni,
      alpn: ch.alpn,
      sessionIdLen: ch.sessionId.length,
      sessionResumptionAttempted: ch.sessionId.length > 0,
      hasSessionTicket: ch.hasSessionTicket,
      hasPskModes: ch.hasPskModes,
      hasPadding: ch.hasPadding,
      hasEch: ch.hasEch,
    },
    cipherSuites: ch.cipherSuites.map((c) => hex(c)),
    cipherSuiteCount: ch.cipherSuites.length,
    extensions: ch.extTypes.map((t) => hex(t)),
    extensionCount: ch.extTypes.length,
    supportedGroups: ch.supportedGroups.map((g) => hex(g)),
    keyShares: ch.keyShares.map((k) => ({ group: hex(k.group), keyLen: k.keyLen })),
    signatureAlgorithms: ch.signatureAlgorithms.map((s) => hex(s)),
    grease: {
      cipherSuites: ch.grease.cipherSuites.map((v) => hex(v)),
      extensions: ch.grease.extensions.map((v) => hex(v)),
      supportedGroups: ch.grease.supportedGroups.map((v) => hex(v)),
      signatureAlgorithms: ch.grease.signatureAlgorithms.map((v) => hex(v)),
      count:
        ch.grease.cipherSuites.length +
        ch.grease.extensions.length +
        ch.grease.supportedGroups.length +
        ch.grease.signatureAlgorithms.length,
    },
    ja3: { str: j3.str, hash: j3.hash },
    ja4: { str: j4.str, raw: j4.raw },
  };
}

module.exports = { parseClientHello, fingerprint, ja3, ja4, isGrease, GREASE_SET };
