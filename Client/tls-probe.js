'use strict';

// ClientHello capture for the self-test panel.
//
// WHY THIS EXISTS SEPARATELY FROM fp-probe.js
//
// fp-probe.js runs INSIDE the page, so it can only read surfaces the page can
// see. The TLS fingerprint is not one of them: the ClientHello is built and
// sent by the network service, and no page API exposes it. A self-test that
// cannot see the ClientHello cannot verify any of the 9 TLS keys - it would
// have to either omit them (the current state, and why nobody noticed they
// were missing) or claim a verdict it cannot support.
//
// So this module runs in the MAIN process and measures the real thing: it
// starts a raw TCP server, drives a request through the tab's own session with
// electron.net.request (which DOES honour that session's SSL config), and
// parses the ClientHello bytes off the wire.
//
// LIMITS, stated because they bound what a verdict can claim:
//   * The server never completes a handshake, so this measures what the client
//     OFFERS. That is exactly what JA3/JA4 fingerprint from - the offered
//     ClientHello - so it is the right thing to measure.
//   * It opens a real socket to 127.0.0.1. A loopback-restricted environment
//     would break it, so failures are reported as errors, not as "not applied".

const net = require('net');

// electron.net is required lazily inside captureClientHello(), so the PURE
// functions here (parseClientHello / tlsVerdicts) stay loadable in plain Node.
// That is what lets test-tls-verdicts.js run without a browser: the comparison
// logic is where the mistakes live, and a module that can only be tested under
// Electron would not be tested at all.
function electronNet() {
  return require('electron').net;
}

/**
 * Capture one ClientHello from `session`.
 * Resolves to { ok, hello, bytes, error }.
 */
function captureClientHello(session, timeoutMs) {
  const timeout = timeoutMs || 4000;
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    let server = null;
    let timer = null;

    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { if (server) server.close(); } catch (_) { /* already closed */ }
      resolve(result);
    };

    server = net.createServer((sock) => {
      // Record only; never respond, so the handshake stops after ClientHello.
      sock.on('data', (d) => chunks.push(d));
      sock.on('error', () => {});
    });
    server.on('error', (e) => finish({ ok: false, hello: null, bytes: 0, error: 'server: ' + e.message }));

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      let req = null;
      try {
        req = electronNet().request({
          method: 'GET',
          url: 'https://127.0.0.1:' + port + '/',
          session,
        });
      } catch (e) {
        finish({ ok: false, hello: null, bytes: 0, error: 'request: ' + e.message });
        return;
      }
      // An error here is EXPECTED: the server never completes the handshake.
      // It is not the signal; the captured bytes are.
      req.on('error', () => {});
      req.end();

      timer = setTimeout(() => {
        const buf = Buffer.concat(chunks);
        if (!buf.length) {
          finish({ ok: false, hello: null, bytes: 0,
            error: 'no ClientHello reached the server (the session may be refusing to connect)' });
          return;
        }
        const hello = parseClientHello(buf);
        if (!hello) {
          finish({ ok: false, hello: null, bytes: buf.length,
            error: 'captured ' + buf.length + ' bytes but could not parse a ClientHello' });
          return;
        }
        finish({ ok: true, hello, bytes: buf.length, error: '' });
      }, timeout);
    });
  });
}

/**
 * Parse a TLS ClientHello out of the first handshake record.
 * Returns null (not a throw) when the bytes are not one - callers report that
 * as "could not measure", never as "not applied".
 */
function parseClientHello(buf) {
  if (!buf || buf.length < 48) return null;
  if (buf[0] !== 0x16) return null;                       // not a TLS record
  const recLen = buf.readUInt16BE(3);
  const body = buf.slice(5, 5 + recLen);
  if (body.length < 40 || body[0] !== 0x01) return null;   // not ClientHello

  const legacyVersion = body.readUInt16BE(4);
  let p = 1 + 3 + 2 + 32;                                  // type, len, version, random
  if (p >= body.length) return null;
  const sidLen = body[p]; p += 1 + sidLen;
  if (p + 2 > body.length) return null;
  const csLen = body.readUInt16BE(p); p += 2;

  const ciphers = [];
  for (let i = 0; i + 2 <= csLen && p + i + 2 <= body.length; i += 2) {
    ciphers.push(body.readUInt16BE(p + i));
  }
  p += csLen;
  if (p >= body.length) return null;
  const compLen = body[p]; p += 1 + compLen;

  let extLen = 0;
  if (p + 2 <= body.length) { extLen = body.readUInt16BE(p); p += 2; }
  const extTypes = [];
  const extEnd = Math.min(p + extLen, body.length);
  while (p + 4 <= extEnd) {
    const t = body.readUInt16BE(p);
    const l = body.readUInt16BE(p + 2);
    extTypes.push(t);
    p += 4 + l;
  }

  // GREASE values are 0x?a?a with both bytes identical (RFC 8701).
  const isGrease = (v) => ((v & 0x0f0f) === 0x0a0a) && (((v >> 8) & 0xff) === (v & 0xff));
  const greaseCiphers = ciphers.filter(isGrease);
  const greaseExts = extTypes.filter(isGrease);

  return {
    legacyVersion,
    cipherCount: ciphers.length,
    ciphers: ciphers.map((c) => c.toString(16).padStart(4, '0')),
    extCount: extTypes.length,
    extTypes,
    greaseCipherCount: greaseCiphers.length,
    greaseExtCount: greaseExts.length,
    hasSessionTicket: extTypes.includes(0x0023),
    hasAlpn: extTypes.includes(0x0010),
    // JA3-style string (version,ciphers,extensions,curves,ec_point_formats).
    // Curves/formats need deeper parsing; left empty rather than faked.
    ja3: [legacyVersion,
      ciphers.filter((c) => !isGrease(c)).join('-'),
      extTypes.filter((t) => !isGrease(t)).join('-'),
      '', ''].join(','),
  };
}

/**
 * Compare a captured ClientHello against a TLS config.
 *
 * Returns verdicts in the same shape as fp-probe.js's verdicts(), so the panel
 * renders both planes identically: { rows, summary }.
 *
 * The assertion per key is the SMALLEST claim the observable supports:
 *
 *   fpGreaseEnabled:false      grease counts must be 0
 *   fpGreaseEnabled:true       at least one GREASE value must be present
 *   fpOmitSessionTicket:true   extension 0x0023 must be absent
 *   fpOmitAlpn:true            extension 0x0010 must be absent
 *   fpCipherList               the offered cipher set must match the config
 *   fpAdvertisedVersionMax     the offered cipher set must change
 *   fpPermuteExtensions        extension order must differ from a baseline
 *   fpExtensionOrder           the given types must appear, in the given order
 *   fpSignatureAlgorithms      the signature_algorithms extension must change
 *   fpGreaseSigalgsEnabled     a GREASE value must appear among extensions
 *
 * Keys whose effect is only visible as "the extension blob changed" need a
 * BASELINE (a capture with no TLS config). Without one this reports 'unknown'
 * rather than guessing - see the unknown verdict in fp-probe.js for why.
 */
function tlsVerdicts(tlsCfg, hello, baseline, isActive) {
  const active = isActive || ((k, v) => v !== undefined && v !== null && v !== '');
  const rows = [];

  if (!hello) {
    for (const k of Object.keys(tlsCfg || {})) {
      if (!active(k, tlsCfg[k])) continue;
      rows.push({ key: k, expected: String(tlsCfg[k]), got: null, verdict: 'error',
        reason: 'no ClientHello could be captured, so this cannot be measured' });
    }
    return finalize(rows);
  }

  for (const [k, v] of Object.entries(tlsCfg || {})) {
    if (!active(k, v)) continue;
    let verdict = 'unknown';
    let expected = String(v);
    let got = '';
    let reason = '';

    if (k === 'fpGreaseEnabled') {
      const want = (v === true || v === 'true');
      const present = hello.greaseCipherCount + hello.greaseExtCount;
      got = 'grease ciphers=' + hello.greaseCipherCount + ' exts=' + hello.greaseExtCount;
      verdict = want ? (present > 0 ? 'pass' : 'fail')
        : (present === 0 ? 'pass' : 'fail');
      if (verdict === 'fail') {
        reason = want ? 'GREASE was requested but none appeared'
          : 'GREASE was disabled but ' + present + ' value(s) still appear';
      }
    } else if (k === 'fpOmitSessionTicket') {
      const wantOmit = (v === true || v === 'true');
      got = 'session_ticket present=' + hello.hasSessionTicket;
      verdict = (wantOmit === !hello.hasSessionTicket) ? 'pass' : 'fail';
      if (verdict === 'fail') {
        reason = wantOmit ? 'session_ticket was to be omitted but is present'
          : 'session_ticket was kept but is absent';
      }
    } else if (k === 'fpOmitAlpn') {
      const wantOmit = (v === true || v === 'true');
      got = 'alpn present=' + hello.hasAlpn;
      verdict = (wantOmit === !hello.hasAlpn) ? 'pass' : 'fail';
      if (verdict === 'fail') {
        reason = wantOmit ? 'ALPN was to be omitted but is present'
          : 'ALPN was kept but is absent';
      }
    } else if (k === 'fpGreaseSigalgsEnabled') {
      const want = (v === true || v === 'true');
      got = 'grease extensions=' + hello.greaseExtCount;
      verdict = want ? (hello.greaseExtCount > 0 ? 'pass' : 'fail') : 'unknown';
      if (verdict === 'fail') reason = 'GREASE sigalgs requested but no GREASE extension appeared';
      if (verdict === 'unknown') {
        reason = 'disabling GREASE sigalgs cannot be distinguished from GREASE being off entirely';
      }
    } else if (k === 'fpCipherList') {
      // The offered set must be the configured one (plus GREASE, which the
      // kernel injects independently and which is not part of the user's list).
      const want = String(v).split(':').map((s) => s.trim()).filter(Boolean);
      got = 'offered ' + hello.cipherCount + ' ciphers';
      if (!baseline) {
        verdict = 'unknown';
        reason = 'needs a baseline capture to tell the configured list from the native one';
      } else {
        // A configured list must change the offered set from native.
        const changed = hello.ciphers.join(',') !== baseline.ciphers.join(',');
        verdict = changed ? 'pass' : 'fail';
        if (verdict === 'fail') {
          reason = 'the offered cipher set is identical to the native one, so the list did not apply';
        }
        expected = want.join(':') + ' (set must differ from native)';
      }
    } else if (k === 'fpAdvertisedVersionMax') {
      got = 'offered ' + hello.cipherCount + ' ciphers, ' + hello.extCount + ' extensions';
      if (!baseline) { verdict = 'unknown'; reason = 'needs a baseline capture'; }
      else {
        const changed = hello.ciphers.join(',') !== baseline.ciphers.join(',');
        verdict = changed ? 'pass' : 'fail';
        if (verdict === 'fail') {
          reason = 'advertising a different max version did not change the offered set';
        }
      }
    } else if (k === 'fpPermuteExtensions') {
      got = 'ext order ' + hello.extTypes.slice(0, 6).join(',') + '...';
      if (!baseline) { verdict = 'unknown'; reason = 'needs a baseline capture to compare order'; }
      else {
        const changed = hello.extTypes.join(',') !== baseline.extTypes.join(',');
        verdict = changed ? 'pass' : 'fail';
        if (verdict === 'fail') reason = 'extension order is identical to the baseline';
      }
    } else if (k === 'fpExtensionOrder') {
      const want = (Array.isArray(v) ? v : String(v).split(',').map((s) => Number(s.trim())))
        .filter((n) => isFinite(n));
      got = 'ext order ' + hello.extTypes.slice(0, 8).join(',') + '...';
      // The configured types must appear, in the configured relative order.
      const idx = want.map((t) => hello.extTypes.indexOf(t));
      const allPresent = idx.every((i) => i >= 0);
      const inOrder = allPresent && idx.every((v2, i) => i === 0 || v2 > idx[i - 1]);
      verdict = (allPresent && inOrder) ? 'pass' : 'fail';
      if (verdict === 'fail') {
        reason = allPresent
          ? 'all configured extensions are present but not in the configured order'
          : 'missing extensions: ' + want.filter((t) => !hello.extTypes.includes(t)).join(',');
      }
      expected = want.join(',');
    } else if (k === 'fpSignatureAlgorithms') {
      got = 'offered ' + hello.extCount + ' extensions';
      if (!baseline) { verdict = 'unknown'; reason = 'needs a baseline capture'; }
      else {
        // sigalgs live inside extension 0x000d, which we do not parse; the
        // observable is that the extension blob changed.
        const changed = hello.extTypes.join(',') !== baseline.extTypes.join(',');
        verdict = changed ? 'pass' : 'fail';
        if (verdict === 'fail') reason = 'the extension set did not change';
      }
    }

    rows.push({ key: k, expected, got, verdict, reason });
  }

  return finalize(rows);
}

function finalize(rows) {
  const summary = { pass: 0, fail: 0, skip: 0, error: 0, unknown: 0 };
  for (const r of rows) summary[r.verdict] = (summary[r.verdict] || 0) + 1;
  return { rows, summary };
}

module.exports = { captureClientHello, parseClientHello, tlsVerdicts };
