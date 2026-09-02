#!/usr/bin/env node
// Local TLS probe server: captures the REAL ClientHello bytes off the wire.
//
// Why a local server instead of an external service (tls.peet.ws etc.):
//   1. Zero network egress - works in CI, no third-party dependency, no rate limit.
//   2. Machine-readable JSON for the regression suite.
//   3. Captures RAW ClientHello, which the task explicitly requires we retain
//      (JA4 keeps raw fields separate from the final hash).
//
// How it works: Node's tls.Server exposes 'secureConnection' only AFTER the
// handshake. To get the pre-handshake bytes we attach to the raw TCP socket
// ('connection'), read the first data event, and parse it ourselves. The
// ClientHello is the very first thing a TLS client sends, unencrypted.
//
// We then let the handshake proceed so the browser gets a real response
// (avoids the connection hanging / browser showing an error).

'use strict';

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { fingerprint } = require('./clienthello.js');

function generateSelfSigned() {
  // Generate a throwaway cert at runtime so there is no key material in the repo.
  const { execFileSync } = require('child_process');
  const dir = require('os').tmpdir();
  const keyPath = path.join(dir, 'fp-probe-key.pem');
  const certPath = path.join(dir, 'fp-probe-cert.pem');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '30',
      '-subj', '/CN=fp-probe.local',
    ], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

/**
 * Start the probe.
 * @param {object} opts  { port, maxSamples, onSample, cert }
 * @returns {Promise<{port, close, waitForSample}>}
 */
function startProbe(opts = {}) {
  const maxSamples = opts.maxSamples || 0; // 0 = unlimited
  const samples = [];
  const waiters = [];
  const cert = opts.cert || generateSelfSigned();

  const openSockets = new Set();

  const server = net.createServer((rawSocket) => {
    let captured = null;
    let capturedCount = 0;
    openSockets.add(rawSocket);
    rawSocket.on('close', () => openSockets.delete(rawSocket));

    // IMPORTANT: a raw net.Socket 'data' listener will NOT fire once the socket
    // is wrapped by TLSSocket - TLSSocket takes over as the sole consumer and
    // swallows the stream. To observe the plaintext wire bytes we interpose a
    // PassThrough duplex: every byte the client sends flows through it, so we
    // can copy the first record (the ClientHello) and still forward everything
    // to TLSSocket so the real handshake completes.
    const tap = new PassThrough();

    tap.on('data', (chunk) => {
      if (capturedCount === 0) {
        // First chunk from a TLS client is the ClientHello record.
        captured = Buffer.from(chunk);
      }
      capturedCount++;
    });

    const tlsSocket = new tls.TLSSocket(tap, {
      isServer: true,
      key: cert.key,
      cert: cert.cert,
      ALPNProtocols: opts.alpn || ['http/1.1'],
      // Client will reject the self-signed cert; that is fine - we only need
      // the ClientHello, which is sent before any cert validation.
    });

    tlsSocket.on('error', () => {});
    tlsSocket.on('secure', () => {
      tlsSocket.end(
        'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'
      );
    });

    // client -> tap -> TLSSocket
    rawSocket.pipe(tap);
    rawSocket.on('error', () => {});
    // TLSSocket -> client (encrypted responses, incl. our 200 OK)
    tlsSocket.pipe(rawSocket);

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (!captured) return;
      let fp;
      try {
        fp = fingerprint(captured);
      } catch (e) {
        fp = { error: String(e && e.message) };
      }
      const sample = {
        ts: Date.now(),
        helloHex: captured.toString('hex'),
        helloLen: captured.length,
        fp,
      };
      samples.push(sample);
      if (opts.onSample) opts.onSample(sample);
      // Resolve all pending waiters with this sample
      while (waiters.length) {
        const w = waiters.shift();
        w(sample);
      }
      if (maxSamples && samples.length >= maxSamples) {
        try { server.close(); } catch (_) {}
      }
    };

    // Report as soon as we have the ClientHello - do not wait for the socket to
    // close, because a client that rejects our self-signed cert may hold the
    // connection open or close it much later.
    rawSocket.on('data', () => {
      // Give the first full record a tick to arrive, then finish.
      setImmediate(finish);
    });
    tlsSocket.on('close', finish);
    setTimeout(finish, 5000).unref();
  });

  server.on('error', () => {});

  return new Promise((resolve) => {
    server.listen(opts.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        samples,
        // Bounded close: server.close() waits for open connections to drain,
        // and a browser may hold keep-alive sockets open. Never block a test
        // exit on that - unref the sockets and race a timeout.
        close: () => new Promise((r) => {
          let done = false;
          const fin = () => { if (!done) { done = true; r(); } };
          server.close(fin);
          // Force-close lingering keep-alive sockets so close() can't hang.
          for (const s of openSockets) {
            try { s.destroy(); } catch (_) {}
          }
          openSockets.clear();
          setTimeout(fin, 1500).unref();
        }),
        waitForSample: (timeoutMs = 15000) =>
          new Promise((res, rej) => {
            if (samples.length) return res(samples[samples.length - 1]);
            const t = setTimeout(() => rej(new Error('timeout waiting for ClientHello')), timeoutMs);
            waiters.push((s) => { clearTimeout(t); res(s); });
          }),
      });
    });
  });
}

module.exports = { startProbe };

// CLI: node tls-probe.js [port]
if (require.main === module) {
  (async () => {
    const port = Number(process.argv[2]) || 0;
    const probe = await startProbe({ port });
    console.log(JSON.stringify({ listening: probe.port }));
    try {
      const s = await probe.waitForSample(60000);
      console.log(JSON.stringify(s, null, 2));
    } catch (e) {
      console.error('no sample: ' + e.message);
      process.exit(1);
    }
    await probe.close();
  })();
}
