// ponytail: rotation-capable credential indirection (doc 17 Part C). http/ws/cdp used to
// capture `token`/`readToken`/`jwtSecret` as strings and compare per request; this store
// keeps current + previous entries so a rotated-out token still verifies inside a grace
// window. Back-compat: passing a plain string wraps into a single-entry store, so every
// existing caller/test is unchanged. Tokens are held as sha256 digests (raw kept only
// when the caller supplied it, for the one-time reveal + the ws URL). No new deps.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_GRACE_MS = 60000;
const CRED_FILE_NAME = 'automation-credentials.json';

function sha256hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// constant-time compare of two hex digests (equal length after hashing)
function hexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  let ba;
  let bb;
  try {
    ba = Buffer.from(a, 'hex');
    bb = Buffer.from(b, 'hex');
  } catch (_) {
    return false;
  }
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function entryFromRaw(raw) {
  if (raw == null || raw === '') return { raw: null, hash: null };
  return { raw: String(raw), hash: sha256hex(raw) };
}
// raw wins over hash when both are present (env > file precedence, per field)
function seedEntry(raw, hash) {
  if (raw != null && raw !== '') return entryFromRaw(raw);
  if (hash != null && hash !== '') return { raw: null, hash: String(hash) };
  return { raw: null, hash: null };
}

function credentialsPath(dataDir) {
  return path.join(String(dataDir), CRED_FILE_NAME);
}

// mode 0600: honoured on POSIX; on Windows the mode bits are effectively advisory
// (only the read-only flag exists) — best-effort, never fatal.
function writeCredentials(file, hashes) {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  const doc = JSON.stringify(
    {
      version: 1,
      tokenHash: (hashes && hashes.tokenHash) || null,
      readTokenHash: (hashes && hashes.readTokenHash) || null,
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  );
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, doc, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch (_) {}
  return true;
}

function readCredentials(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object') return null;
    return {
      tokenHash: typeof doc.tokenHash === 'string' ? doc.tokenHash : null,
      readTokenHash: typeof doc.readTokenHash === 'string' ? doc.readTokenHash : null,
    };
  } catch (_) {
    return null; // corrupt file -> caller falls through to generated (never crash boot)
  }
}

function createTokenStore({ token, readToken, jwtSecret, graceMs, now, credentialFile, tokenHash, readTokenHash } = {}) {
  const nowFn = typeof now === 'function' ? now : () => Date.now();
  const grace = Number.isFinite(Number(graceMs)) && Number(graceMs) >= 0 ? Number(graceMs) : DEFAULT_GRACE_MS;

  const admin = { current: seedEntry(token, tokenHash), prev: [] };
  const viewer = { current: seedEntry(readToken, readTokenHash), prev: [] };
  let jwtCurrent = jwtSecret != null && jwtSecret !== '' ? String(jwtSecret) : null;
  let jwtPrev = [];

  function prune() {
    const t = nowFn();
    admin.prev = admin.prev.filter((p) => p.until > t);
    viewer.prev = viewer.prev.filter((p) => p.until > t);
    jwtPrev = jwtPrev.filter((p) => p.until > t);
  }

  function roleOf(entry, gotHash) {
    if (!gotHash) return false;
    if (entry.current.hash && hexEqual(gotHash, entry.current.hash)) return true;
    const t = nowFn();
    for (const p of entry.prev) if (p.until > t && p.hash && hexEqual(gotHash, p.hash)) return true;
    return false;
  }

  // verify(got) -> { role: 'admin'|'viewer'|null }; current OR a not-yet-expired previous.
  function verify(got) {
    if (got == null || got === '') return { role: null };
    const h = sha256hex(got);
    if (roleOf(admin, h)) return { role: 'admin' };
    if (roleOf(viewer, h)) return { role: 'viewer' };
    return { role: null };
  }

  // active JWT secrets: current first, then previous still inside their grace window.
  function jwtSecrets() {
    const out = [];
    if (jwtCurrent) out.push(jwtCurrent);
    const t = nowFn();
    for (const p of jwtPrev) if (p.until > t && p.value) out.push(p.value);
    return out;
  }
  function jwtEnabled() {
    return jwtSecrets().length > 0;
  }

  // rotate({token?, readToken?, jwtSecret?}) — supplied values become current; the
  // replaced value is kept as previous with a grace deadline. Returns the new raw
  // values (one-time reveal); a value never rotated stays unchanged.
  function rotate(values = {}) {
    const t = nowFn();
    const out = {};
    if (values.token !== undefined) {
      if (values.token == null || values.token === '') throw new Error('new token must be a non-empty string');
      const nh = sha256hex(values.token);
      if (admin.current.hash && !hexEqual(nh, admin.current.hash)) {
        admin.prev.push({ hash: admin.current.hash, until: t + grace });
      }
      admin.current = entryFromRaw(values.token);
      out.token = String(values.token);
    }
    if (values.readToken !== undefined) {
      if (values.readToken == null || values.readToken === '') throw new Error('new readToken must be a non-empty string');
      const nh = sha256hex(values.readToken);
      if (viewer.current.hash && !hexEqual(nh, viewer.current.hash)) {
        viewer.prev.push({ hash: viewer.current.hash, until: t + grace });
      }
      viewer.current = entryFromRaw(values.readToken);
      out.readToken = String(values.readToken);
    }
    if (values.jwtSecret !== undefined) {
      if (values.jwtSecret == null || values.jwtSecret === '') throw new Error('new jwtSecret must be a non-empty string');
      if (jwtCurrent && jwtCurrent !== String(values.jwtSecret)) {
        jwtPrev.push({ value: jwtCurrent, until: t + grace });
      }
      jwtCurrent = String(values.jwtSecret);
      out.jwtSecret = String(values.jwtSecret);
    }
    prune();
    persist();
    return out;
  }

  function hashes() {
    return { tokenHash: admin.current.hash || null, readTokenHash: viewer.current.hash || null };
  }

  function persist() {
    if (!credentialFile) return false;
    try {
      writeCredentials(credentialFile, hashes());
      return true;
    } catch (_) {
      return false;
    }
  }

  return {
    isTokenStore: true,
    verify,
    rotate,
    jwtSecrets,
    jwtEnabled,
    hashes,
    persist,
    rawToken: () => admin.current.raw,
    rawReadToken: () => viewer.current.raw,
    graceMs: grace,
  };
}

// Precedence env > file > generated (doc 17 Part C). An env token is authoritative and
// memory-only (the operator owns the secret); a file-loaded store holds hashes only, so
// the raw token is never recoverable at rest; otherwise generate once and persist.
function resolveTokenStore({ token, readToken, jwtSecret, graceMs, now, dataDir, credentialFile } = {}) {
  const file = credentialFile || (dataDir ? credentialsPath(dataDir) : null);
  if (token != null && token !== '') {
    return { store: createTokenStore({ token, readToken, jwtSecret, graceMs, now }), generated: null, source: 'env' };
  }
  if (file) {
    const loaded = readCredentials(file);
    if (loaded && (loaded.tokenHash || loaded.readTokenHash)) {
      return {
        store: createTokenStore({
          readToken,
          jwtSecret,
          graceMs,
          now,
          credentialFile: file,
          tokenHash: loaded.tokenHash,
          readTokenHash: loaded.readTokenHash,
        }),
        generated: null,
        source: 'file',
      };
    }
  }
  const gen = crypto.randomBytes(16).toString('hex');
  const store = createTokenStore({ token: gen, readToken, jwtSecret, graceMs, now, credentialFile: file });
  if (file) {
    try {
      writeCredentials(file, store.hashes());
    } catch (_) {}
  }
  return { store, generated: gen, source: 'generated' };
}

module.exports = {
  createTokenStore,
  resolveTokenStore,
  writeCredentials,
  readCredentials,
  credentialsPath,
  sha256hex,
  hexEqual,
  DEFAULT_GRACE_MS,
  CRED_FILE_NAME,
};
