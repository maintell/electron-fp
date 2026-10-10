// ponytail: JSON-file store (profiles.json pattern) + injectable launcher; Electron BrowserView wiring is P1 glue — launcher interface = {start(profile), stop(profileId), status(profileId)}.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UPDATABLE = ['name', 'groupId', 'platform', 'browserVersion', 'proxy', 'fingerprint'];
// lifecycle rule: fingerprint/proxy/partition changes need restart (docs/automation/architecture.md §4)
const RESTART_FIELDS = ['fingerprint', 'proxy', 'partition'];
const LIVE = ['starting', 'running', 'stopping'];

class ProfileError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProfileError';
    this.code = code || 'PROFILE';
    this.retriable = false;
  }
}

function fail(message, code) {
  throw new ProfileError(message, code);
}

const clone = (x) => JSON.parse(JSON.stringify(x));

function validateName(name) {
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 120) {
    fail('name must be non-empty string <=120 chars', 'VALIDATION');
  }
}

function validateProxy(proxy) {
  if (proxy === undefined || proxy === null) return undefined;
  if (typeof proxy !== 'object' || Array.isArray(proxy)) fail('proxy must be an object', 'VALIDATION');
  if (typeof proxy.server !== 'string' || proxy.server.trim().length === 0) {
    fail('proxy.server must be a non-empty string', 'VALIDATION');
  }
  const out = { server: proxy.server };
  if (proxy.username !== undefined) out.username = proxy.username;
  if (proxy.password !== undefined) out.password = proxy.password;
  return out;
}

function hasEndpoint(ep) {
  if (!ep || typeof ep !== 'object') return false;
  // in-process Electron launcher: live handle stays in-process, endpoint is a plain JSON-safe marker
  if (ep.inProcess === true) return true;
  // debugPort 0 is a valid port — presence check, not truthiness
  return ['wsEndpoint', 'cdpUrl', 'debugPort'].some(
    (k) => ep[k] !== undefined && ep[k] !== null && ep[k] !== ''
  );
}

function redact(p) {
  const c = clone(p);
  if (c.proxy && c.proxy.password !== undefined) c.proxy.password = '***';
  return c;
}

function createProfileManager({ file, launcher, now, audit, fpValidate, fpBroker } = {}) {
  const nowFn = typeof now === 'function' ? now : () => new Date().toISOString();
  const auditFn = typeof audit === 'function' ? audit : () => {};
  let profiles = [];
  let loaded = false;

  function load() {
    if (loaded || !file) {
      loaded = true;
      return;
    }
    loaded = true;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return; // first run: empty store
      throw err;
    }
    profiles = JSON.parse(raw); // corrupt file throws — silent reset would lose data
  }

  function persist() {
    if (!file) return;
    const dir = path.dirname(file);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    // lastEndpoint is ephemeral (runtime connect info) — strip on save; restart clears it while status survives
    const data = profiles.map((p) => {
      const { lastEndpoint, ...rest } = p;
      return rest;
    });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file); // atomic replace; Node maps rename onto MOVEFILE_REPLACE_EXISTING on win32
  }

  function find(id) {
    load();
    return profiles.find((p) => p.id === id && !p.deletedAt);
  }

  function touch(p) {
    if (!p.meta) p.meta = {};
    p.meta.updatedAt = nowFn();
  }

  function markStarted(p) {
    if (!p.meta) p.meta = {};
    p.meta.everStarted = true; // partition materialized: H2 plane frozen from here (h2Error on change)
    touch(p);
  }

  function create(spec) {
    if (typeof spec !== 'object' || spec === null) fail('spec must be an object', 'VALIDATION');
    validateName(spec.name);
    const proxy = validateProxy(spec.proxy);
    if (typeof fpValidate === 'function' && spec.fingerprint !== undefined && spec.fingerprint !== null) {
      fpValidate(spec.fingerprint);
    }
    load();
    const ts = nowFn();
    const id = crypto.randomUUID();
    const p = {
      id,
      name: spec.name,
      groupId: typeof spec.groupId === 'string' ? spec.groupId : undefined,
      platform: typeof spec.platform === 'string' ? spec.platform : undefined,
      browserVersion: typeof spec.browserVersion === 'string' ? spec.browserVersion : undefined,
      proxy,
      fingerprint: spec.fingerprint !== undefined && spec.fingerprint !== null ? clone(spec.fingerprint) : undefined,
      partition: 'persist:auto-' + id, // derived, never in-memory — fp-tab-style bare names impossible by construction
      status: 'stopped',
      meta: { createdAt: ts, updatedAt: ts },
    };
    profiles.push(p);
    persist();
    auditFn({ action: 'profile-create', id, at: ts });
    return clone(p);
  }

  function get(id) {
    const p = find(id);
    return p ? clone(p) : undefined; // full object incl. proxy.password — caller is in-process
  }

  function list({ groupId, status, includeDeleted = false, limit = Infinity, offset = 0 } = {}) {
    load();
    return profiles
      .filter(
        (p) =>
          (includeDeleted || !p.deletedAt) &&
          (groupId === undefined || p.groupId === groupId) &&
          (status === undefined || p.status === status)
      )
      .slice(offset, offset + limit)
      .map(redact); // strip proxy.password -> '***'
  }

  function update(id, patch) {
    const p = find(id);
    if (!p) fail('profile not found: ' + id, 'NOT_FOUND');
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      fail('patch must be an object', 'VALIDATION');
    }
    const keys = Object.keys(patch);
    if (p.status === 'running' && keys.some((k) => RESTART_FIELDS.includes(k))) {
      fail('CONFLICT: stop profile before changing fingerprint/proxy', 'CONFLICT');
    }
    for (const k of keys) {
      if (k === 'partition') fail('partition is derived from id, not updatable', 'VALIDATION');
      if (!UPDATABLE.includes(k)) fail('not an updatable field: ' + k, 'VALIDATION');
    }
    if ('name' in patch) validateName(patch.name);
    if ('proxy' in patch) p.proxy = validateProxy(patch.proxy);
    if ('fingerprint' in patch) {
      const fp = patch.fingerprint;
      if (fp !== undefined && fp !== null) {
        if (typeof fpValidate === 'function') fpValidate(fp);
        p.fingerprint = clone(fp);
      } else {
        p.fingerprint = undefined;
      }
    }
    if ('name' in patch) p.name = patch.name;
    if ('groupId' in patch) p.groupId = patch.groupId;
    if ('platform' in patch) p.platform = patch.platform;
    if ('browserVersion' in patch) p.browserVersion = patch.browserVersion;
    touch(p);
    persist();
    auditFn({ action: 'profile-update', id, fields: keys, at: p.meta.updatedAt });
    return clone(p);
  }

  function remove(id) {
    const p = find(id);
    if (!p) fail('profile not found: ' + id, 'NOT_FOUND');
    if (LIVE.includes(p.status)) {
      fail('CONFLICT: stop profile before deleting (status ' + p.status + ')', 'CONFLICT');
    }
    p.deletedAt = nowFn();
    persist();
    auditFn({ action: 'profile-remove', id, at: p.deletedAt });
    return clone(p);
  }

  async function start(id) {
    const p = find(id);
    if (!p) fail('profile not found: ' + id, 'NOT_FOUND');
    if (p.status === 'running') fail('CONFLICT: profile already running: ' + id, 'CONFLICT');
    if (p.status !== 'stopped' && p.status !== 'error') {
      fail('CONFLICT: cannot start profile in status ' + p.status, 'CONFLICT');
    }
    if (!launcher || typeof launcher.start !== 'function') fail('launcher not wired', 'LIMIT');
    p.status = 'starting';
    persist();
    auditFn({ action: 'profile-start', id, at: nowFn() });
    let ep;
    try {
      ep = await launcher.start(clone(p));
    } catch (e) {
      p.status = 'error';
      persist();
      throw e;
    }
    if (!hasEndpoint(ep)) {
      p.status = 'error';
      persist();
      fail('launcher.start returned no endpoint (need inProcess/wsEndpoint/cdpUrl/debugPort)', 'VALIDATION');
    }
    p.status = 'running';
    p.lastEndpoint = ep; // ephemeral — stripped on save (see persist)
    markStarted(p);
    persist();
    return clone(p);
  }

  async function stop(id) {
    const p = find(id);
    if (!p) fail('profile not found: ' + id, 'NOT_FOUND');
    if (p.status === 'stopped') fail('CONFLICT: profile not running: ' + id, 'CONFLICT');
    if (p.status !== 'running') fail('CONFLICT: cannot stop profile in status ' + p.status, 'CONFLICT');
    if (!launcher || typeof launcher.stop !== 'function') fail('launcher not wired', 'LIMIT');
    p.status = 'stopping';
    persist();
    try {
      await launcher.stop(id);
    } catch (e) {
      p.status = 'error';
      persist();
      throw e;
    }
    p.status = 'stopped';
    p.lastEndpoint = null;
    persist();
    auditFn({ action: 'profile-stop', id, at: nowFn() });
    return clone(p);
  }

  function status(id) {
    const p = find(id);
    if (!p) fail('profile not found: ' + id, 'NOT_FOUND');
    return { id: p.id, status: p.status, endpoint: p.lastEndpoint || null };
  }

  // additive: merge runtime-only connect info (e.g. cdpUrl) into the live endpoint.
  // Ephemeral by design — persist() strips lastEndpoint; only meaningful while running.
  function setEndpoint(id, patch) {
    const p = find(id);
    if (!p) fail('profile not found: ' + id, 'NOT_FOUND');
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      fail('patch must be an object', 'VALIDATION');
    }
    if (p.status !== 'running') {
      fail('CONFLICT: profile not running: ' + id, 'CONFLICT');
    }
    p.lastEndpoint = Object.assign({}, p.lastEndpoint || {}, patch);
    return Object.assign({}, p.lastEndpoint);
  }

  async function bulkStart(ids, { concurrency = 5 } = {}) {
    if (!Array.isArray(ids)) fail('ids must be an array', 'VALIDATION');
    const started = [];
    const failed = [];
    for (let i = 0; i < ids.length; i += concurrency) {
      const chunk = ids.slice(i, i + concurrency);
      const results = await Promise.allSettled(chunk.map((id) => start(id)));
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          started.push(chunk[idx]);
        } else {
          const reason = r.reason || {};
          failed.push({
            id: chunk[idx],
            error: { code: reason.code || 'INTERNAL', message: String(reason.message || reason) },
          });
        }
      });
    }
    auditFn({ action: 'profile-bulk-start', started: started.length, failed: failed.length, at: nowFn() });
    return { started, failed };
  }

  // future Script API profiles.get ACL — ctxProfileId absent = trusted in-process caller
  function assertOwned(profileId, ctxProfileId) {
    if (ctxProfileId && ctxProfileId !== profileId) {
      throw new ProfileError('cross-profile access denied');
    }
    return true;
  }

  // FingerprintBroker entry (architecture.md §4, minimal main-side shape):
  // fingerprint.update(id|config, { bearerToken }) — the ONLY sanctioned path for
  // changing a profile's fingerprint planes after creation.
  // Five gates (security.md §8), enforced in order:
  //   1. validate: fpSplitConfig-style shape check + fpValidate hook (unknown keys rejected)
  //   2. permission: bearer token required (brokerToken configured), else UNAUTHORIZED
  //   3. lifecycle: running profiles are CONFLICT (stop → update → start); H2 changes
  //      on an already-frozen partition are honestly refused (h2Error), never silently dropped
  //   4. restart: applied via launcher restart when wired (stop → update → start);
  //      without a launcher the update lands on the stopped profile for next start
  //   5. log: audit line with key-hash, never the carrier plaintext
  // Returns { ok:true, planes, restartRequired } or throws ProfileError (code UNAUTHORIZED/
  // VALIDATION/CONFLICT). Atomicity: validation runs BEFORE any mutation, so a failed
  // gate leaves the stored fingerprint untouched (no half-switched identity).
  async function fingerprintUpdate(id, config, { bearerToken, brokerToken } = {}) {
    const p = find(id);
    if (!p) fail('profile not found: ' + id, 'NOT_FOUND');
    const need = brokerToken !== undefined ? brokerToken : (fpBroker && fpBroker.token);
    if (typeof need === 'string' && need !== '') {
      if (typeof bearerToken !== 'string' || bearerToken === '') {
        auditFn({ type: 'fingerprint-deny', id, gate: 'permission', reason: 'missing bearer' });
        fail('UNAUTHORIZED: fingerprint.update requires bearer token', 'UNAUTHORIZED');
      }
      const a = Buffer.from(String(bearerToken), 'utf8');
      const b = Buffer.from(String(need), 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        auditFn({ type: 'fingerprint-deny', id, gate: 'permission', reason: 'bad bearer' });
        fail('UNAUTHORIZED: bad bearer token', 'UNAUTHORIZED');
      }
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      fail('fingerprint config must be an object', 'VALIDATION');
    }
    const keys = Object.keys(config);
    if (keys.length === 0) fail('fingerprint config must not be empty', 'VALIDATION');
    // fpSplitConfig-style plane split (client fp-schema.js:979 semantics mirrored here
    // without importing Electron code): TLS 9 keys / H2 3 keys / rest = blink.
    const TLS_KEYS = new Set(['tls_version_min', 'tls_version_max', 'tls_cipher_suites', 'tls_curves', 'tls_sigalgs', 'tls_alps', 'tls_extension_order', 'tls_grease', 'tls_session_tickets']);
    const H2_KEYS = new Set(['h2_settings', 'h2_window_update', 'h2_priority']);
    const planes = { blink: {}, tls: {}, h2: {} };
    for (const k of keys) {
      if (H2_KEYS.has(k)) planes.h2[k] = config[k];
      else if (TLS_KEYS.has(k)) planes.tls[k] = config[k];
      else planes.blink[k] = config[k];
    }
    // gate 1: shape validation BEFORE any mutation (atomicity)
    if (typeof fpValidate === 'function') fpValidate({ blink: planes.blink, tls: planes.tls, h2: planes.h2, raw: config });
    // gate 3: lifecycle — running profile cannot be hot-swapped
    const wasRunning = p.status === 'running';
    if (wasRunning) {
      auditFn({ type: 'fingerprint-deny', id, gate: 'lifecycle', reason: 'running' });
      fail('CONFLICT: stop profile before fingerprint.update (running)', 'CONFLICT');
    }
    // gate 3b: H2 frozen-partition honesty — H2 keys on a profile whose partition
    // has already been materialized (started at least once) are refused, not dropped.
    const h2Wanted = Object.keys(planes.h2).length > 0;
    const frozen = p.meta && p.meta.everStarted === true;
    if (h2Wanted && frozen) {
      auditFn({ type: 'fingerprint-deny', id, gate: 'lifecycle', reason: 'h2-frozen' });
      const e = new ProfileError('h2Error: partition already frozen (stop → recreate partition to change H2)');
      e.code = 'CONFLICT';
      e.plane = 'h2';
      throw e;
    }
    // gate 4: apply — stopped profile: mutate + persist; restart orchestration
    // (stop → update → start) is the caller's job via launcher, restartRequired flags it.
    const keyHash = crypto.createHash('sha256').update(keys.slice().sort().join(',')).digest('hex').slice(0, 16);
    const applied = [];
    if (Object.keys(planes.blink).length) applied.push('blink');
    if (Object.keys(planes.tls).length) applied.push('tls');
    if (Object.keys(planes.h2).length) applied.push('h2');
    p.fingerprint = Object.assign({}, p.fingerprint || {}, config);
    touch(p);
    persist();
    // gate 5: audit with key-hash only — carrier plaintext never logged
    auditFn({ type: 'fingerprint-update', id, planes: applied, keyHash, restartRequired: wasRunning });
    return { ok: true, planes: applied, restartRequired: wasRunning };
  }

  // FingerprintBroker rotation (architecture.md §4 gate 4, live-profile path):
  // rotate(id, config, { bearerToken, brokerToken }) — stop → update → start in
  // ONE call for launcher-wired managers. Steps: lifecycle pre-check (running or
  // stopped both accepted), fingerprintUpdate gates (validate/permission/H2), then
  // launcher.stop → launcher.start when the profile was running. If start fails
  // the profile lands `error` (honest, never half-switched silent); the stored
  // fingerprint is already the NEW one (update precedes restart by design — the
  // restart replays it, it does not re-decide it). Returns fingerprintUpdate's
  // result plus { restarted: bool }.
  async function fingerprintRotate(id, config, { bearerToken, brokerToken } = {}) {
    const p = find(id);
    if (!p) fail('profile not found: ' + id, 'NOT_FOUND');
    const wasRunning = p.status === 'running';
    // reuse the gate path (validate/permission/lifecycle-shape) on a stopped
    // shadow: temporarily treat running as stopped for gate 3, then orchestrate.
    if (wasRunning) {
      // H2 honesty still applies — frozen partition refuses before any stop.
      const upd = await fingerprintUpdateShadow(id, config, { bearerToken, brokerToken });
      if (!launcher || typeof launcher.stop !== 'function' || typeof launcher.start !== 'function') {
        fail('launcher not wired', 'LIMIT');
      }
      await stop(id);
      try {
        await start(id);
      } catch (e) {
        auditFn({ type: 'fingerprint-rotate', id, restarted: false, error: String((e && e.message) || e) });
        throw e;
      }
      auditFn({ type: 'fingerprint-rotate', id, restarted: true, planes: upd.planes });
      return Object.assign({}, upd, { restarted: true, restartRequired: false });
    }
    const upd = await fingerprintUpdate(id, config, { bearerToken, brokerToken });
    auditFn({ type: 'fingerprint-rotate', id, restarted: false, planes: upd.planes });
    return Object.assign({}, upd, { restarted: false });
  }

  // Shadow gate: same five gates as fingerprintUpdate but tolerates running
  // status (the caller stops the profile immediately after). Used ONLY by rotate.
  async function fingerprintUpdateShadow(id, config, { bearerToken, brokerToken } = {}) {
    const p = find(id);
    if (!p) fail('profile not found: ' + id, 'NOT_FOUND');
    const need = brokerToken !== undefined ? brokerToken : (fpBroker && fpBroker.token);
    if (typeof need === 'string' && need !== '') {
      if (typeof bearerToken !== 'string' || bearerToken === '') {
        auditFn({ type: 'fingerprint-deny', id, gate: 'permission', reason: 'missing bearer' });
        fail('UNAUTHORIZED: fingerprint.update requires bearer token', 'UNAUTHORIZED');
      }
      const a = Buffer.from(String(bearerToken), 'utf8');
      const b = Buffer.from(String(need), 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        auditFn({ type: 'fingerprint-deny', id, gate: 'permission', reason: 'bad bearer' });
        fail('UNAUTHORIZED: bad bearer token', 'UNAUTHORIZED');
      }
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      fail('fingerprint config must be an object', 'VALIDATION');
    }
    const keys = Object.keys(config);
    if (keys.length === 0) fail('fingerprint config must not be empty', 'VALIDATION');
    const H2S = new Set(['h2_settings', 'h2_window_update', 'h2_priority']);
    const h2Wanted = keys.some((k) => H2S.has(k));
    if (h2Wanted && p.meta && p.meta.everStarted === true) {
      auditFn({ type: 'fingerprint-deny', id, gate: 'lifecycle', reason: 'h2-frozen' });
      const e = new ProfileError('h2Error: partition already frozen (stop → recreate partition to change H2)');
      e.code = 'CONFLICT';
      e.plane = 'h2';
      throw e;
    }
    if (typeof fpValidate === 'function') fpValidate(config);
    const keyHash = crypto.createHash('sha256').update(keys.slice().sort().join(',')).digest('hex').slice(0, 16);
    p.fingerprint = Object.assign({}, p.fingerprint || {}, config);
    touch(p);
    persist();
    auditFn({ type: 'fingerprint-update', id, planes: ['rotate-shadow'], keyHash, restartRequired: true });
    return { ok: true, planes: ['rotate-shadow'], restartRequired: true };
  }

  return { create, get, list, update, remove, start, stop, status, setEndpoint, bulkStart, assertOwned, fingerprintUpdate, fingerprintRotate };
}

module.exports = { createProfileManager, ProfileError };
