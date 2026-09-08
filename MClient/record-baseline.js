#!/usr/bin/env node
// Record the TLS/HTTP2 fingerprint baseline of the CURRENT build.
//
// This is the fixed point of the regression system (task phase 13):
//   baseline -> build new -> run suite -> compare -> report.
//
// The baseline must be measured, never hand-written, and must be re-recorded
// deliberately when the Chromium version changes. It stores the RAW ClientHello
// fields, not just the JA3/JA4 hashes: JA4 deliberately separates raw fields
// from the final string, and a hash alone cannot tell you WHICH surface moved.
//
// Usage: node Client/record-baseline.js [out.json]

'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');
const { startProbe } = require('./tls/tls-probe.js');

const OUT = process.argv[2] ||
  path.join(__dirname, 'baselines', 'tls-baseline.json');

async function capture(sess, url, probe) {
  sess.setCertificateVerifyProc((req, cb) => cb(0));
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, session: sess },
  });
  const sampleP = probe.waitForSample(20000).catch(() => null);
  const loadP = win.loadURL(url).catch(() => null);
  const sample = await sampleP;
  await Promise.race([loadP, new Promise((r) => setTimeout(r, 3000))]);
  return { win, sample };
}

(async () => {
  await app.whenReady();

  const probe = await startProbe({ port: 0 });
  const url = `https://127.0.0.1:${probe.port}/probe`;
  const sess = session.fromPartition('persist:baseline');

  // Discard warm-up: first handshake carries randomized GREASE.
  const warm = await capture(sess, url, probe);
  warm.win.destroy();

  const { win, sample } = await capture(sess, url, probe);
  await probe.close();

  if (!sample || !sample.fp || sample.fp.error) {
    console.log('FAIL  could not capture baseline: ' +
      (sample ? sample.fp && sample.fp.error : 'no sample'));
    app.exit(1);
    return;
  }

  const b = sample.fp;
  const record = {
    schema: 1,
    recordedAt: new Date().toISOString(),
    // Provenance: a baseline without versions is meaningless after an upgrade.
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    platform: process.platform + '-' + process.arch,
    // The derived identifiers. These are OUTPUTS, never inputs.
    ja3: b.ja3.hash,
    ja4: b.ja4.str,
    // Raw fields: which surface actually moved when a hash changes.
    raw: {
      ja3String: b.ja3.str,
      ja4Fields: b.ja4.raw,
      cipherSuites: b.cipherSuites,
      cipherSuiteCount: b.cipherSuiteCount,
      extensions: b.extensions,
      extensionCount: b.extensionCount,
      supportedGroups: b.supportedGroups,
      keyShares: b.keyShares,
      signatureAlgorithms: b.signatureAlgorithms,
      alpn: b.tls.alpn,
      supportedVersions: b.tls.supportedVersions,
      greaseCount: b.grease.count,
    },
    helloLen: sample.helloLen,
    helloHex: sample.helloHex,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(record, null, 2));

  console.log('PASS  baseline recorded: ' + OUT);
  console.log('  JA3 = ' + record.ja3);
  console.log('  JA4 = ' + record.ja4);
  console.log('  chrome=' + record.versions.chrome +
    ' electron=' + record.versions.electron +
    ' platform=' + record.platform);
  await win.destroy();
  app.exit(0);
})().catch((e) => {
  console.log('FAIL  threw: ' + (e && e.message));
  console.log(e && e.stack);
  app.exit(1);
});
