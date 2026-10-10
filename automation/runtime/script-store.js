// ponytail: in-memory + JSON-file store (profiles.json pattern); swap to SQLite at database.md when 10k scripts land
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// script-sdk.md §7 capability list, filesystem/process default deny
const CAPS = ['browser', 'cookies', 'storage', 'network', 'filesystem', 'process'];
const DEFAULT_PERMISSIONS = { browser: true, cookies: true, storage: true, network: true, filesystem: false, process: false };
// script-sdk.md §2.6 / automation.d.ts ParamType: these 9 only (JSON uppercase canonical);
// database.md §3 CHECK mirrors the same 9 (DB migration keeps its own list)
const PARAM_TYPES = ['string', 'number', 'boolean', 'select', 'multi-select', 'secret', 'file', 'textarea', 'JSON'];
const META_FIELDS = ['name', 'description', 'category', 'entry', 'permissions', 'parameters', 'trusted']; // spec: update() meta fields; author intentionally not updatable; trusted: admin-only signature gate (service layer)

function fail(msg) { throw new Error(msg); }

function validateName(name) {
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 120) {
    fail('name must be non-empty string <=120 chars');
  }
}

function validatePermissions(perms) {
  if (typeof perms !== 'object' || perms === null || Array.isArray(perms)) fail('permissions must be an object');
  for (const key of Object.keys(perms)) {
    if (!CAPS.includes(key)) fail('unknown permission: ' + key);
    if (typeof perms[key] !== 'boolean') fail('permission value must be boolean: ' + key);
  }
}

function validateParameters(params) {
  if (!Array.isArray(params)) fail('parameters must be an array');
  const seen = new Set();
  for (const p of params) {
    if (typeof p !== 'object' || p === null) fail('parameter must be an object');
    if (typeof p.name !== 'string' || p.name.length === 0) fail('parameter name must be non-empty string');
    if (p.name === '__proto__' || p.name === 'constructor' || p.name === 'prototype') fail('parameter name reserved: ' + p.name);
    if (seen.has(p.name)) fail('duplicate parameter name: ' + p.name);
    seen.add(p.name);
    if (!PARAM_TYPES.includes(p.type)) fail('invalid parameter type: ' + String(p.type));
    if (typeof p.required !== 'boolean') fail('parameter required must be boolean: ' + p.name);
    if (p.type === 'select' || p.type === 'multi-select') {
      if (!Array.isArray(p.options) || p.options.length === 0) {
        fail('options must be non-empty array for type ' + p.type + ': ' + p.name);
      }
    } else if (p.options !== undefined) {
      fail('options only allowed for select/multi-select: ' + p.name);
    }
  }
}

function validateMeta(meta) {
  if (typeof meta !== 'object' || meta === null) fail('meta must be an object');
  validateName(meta.name);
  validatePermissions(meta.permissions);
  validateParameters(meta.parameters);
  if (meta.trusted !== undefined && typeof meta.trusted !== 'boolean') fail('trusted must be boolean');
  if (meta.entry !== undefined && (typeof meta.entry !== 'string' || meta.entry.length === 0)) {
    fail('entry must be a non-empty string');
  }
}

function stripVersionCodes(script) {
  return {
    ...script,
    versions: script.versions.map((v) => ({ version: v.version, createdAt: v.createdAt })),
  };
}

function coerceParam(def, raw) {
  const name = def.name;
  switch (def.type) {
    case 'string':
    case 'secret':
    case 'file':
    case 'textarea':
      if (typeof raw !== 'string') return { ok: false, message: name + ' must be a string' };
      return { ok: true, value: raw };
    case 'number': {
      if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) return { ok: false, message: name + ' must be a finite number' };
        return { ok: true, value: raw };
      }
      if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw);
        if (Number.isFinite(n)) return { ok: true, value: n };
      }
      return { ok: false, message: name + ' must be a number' };
    }
    case 'boolean':
      if (raw === true || raw === 'true') return { ok: true, value: true };
      if (raw === false || raw === 'false') return { ok: true, value: false };
      return { ok: false, message: name + ' must be a boolean' };
    case 'select':
      if (Array.isArray(def.options) && def.options.includes(raw)) return { ok: true, value: raw };
      return { ok: false, message: name + ' must be one of options' };
    case 'multi-select':
      if (!Array.isArray(raw)) return { ok: false, message: name + ' must be an array' };
      if (!Array.isArray(def.options) || raw.some((v) => !def.options.includes(v))) {
        return { ok: false, message: name + ' values must be in options' };
      }
      return { ok: true, value: raw.slice() };
    case 'JSON': {
      if (typeof raw === 'object' && raw !== null) return { ok: true, value: raw };
      if (typeof raw === 'string') {
        try {
          const v = JSON.parse(raw);
          if (typeof v === 'object' && v !== null) return { ok: true, value: v };
          return { ok: false, message: name + ' must be a JSON object' };
        } catch {
          return { ok: false, message: name + ' is not valid JSON' };
        }
      }
      return { ok: false, message: name + ' must be a JSON object' };
    }
    default:
      return { ok: false, message: name + ' has invalid type' };
  }
}

function createScriptStore({ file, now } = {}) {
  const nowFn = typeof now === 'function' ? now : () => new Date().toISOString();
  let scripts = [];
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
    scripts = JSON.parse(raw); // corrupt file throws — silent reset would lose data
  }

  function persist() {
    if (!file) return;
    const dir = path.dirname(file);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(scripts, null, 2), 'utf8');
    fs.renameSync(tmp, file); // atomic replace; Node maps rename onto MOVEFILE_REPLACE_EXISTING on win32
  }

  function find(id) {
    load();
    return scripts.find((s) => s.id === id && !s.deletedAt);
  }

  function nextVersion(s) {
    const latest = s.versions[0] && s.versions[0].version;
    if (!latest) return '1.0.0'; // spec's 'v'+count is for non-semver latest; first version stays semver
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(latest);
    if (m) return m[1] + '.' + m[2] + '.' + (Number(m[3]) + 1);
    return 'v' + (s.versions.length + 1);
  }

  function create(meta) {
    if (typeof meta !== 'object' || meta === null) fail('meta must be an object');
    const norm = {
      ...meta,
      permissions: meta.permissions === undefined ? { ...DEFAULT_PERMISSIONS } : meta.permissions,
      parameters: meta.parameters === undefined ? [] : meta.parameters,
      // trusted defaults false and is stripped from direct writes: only the
      // service-layer trust() endpoint (admin/JWT path) may set it. Callers
      // passing trusted:true here get it silently dropped, never granted.
      trusted: undefined,
    };
    if (meta.trusted !== undefined && meta.trusted !== false) fail('trusted is admin-only: use the trust endpoint');
    validateMeta({ ...norm, trusted: undefined });
    load();
    const ts = nowFn();
    const s = {
      id: crypto.randomUUID(),
      name: norm.name,
      author: typeof norm.author === 'string' ? norm.author : undefined,
      description: typeof norm.description === 'string' ? norm.description : undefined,
      category: typeof norm.category === 'string' ? norm.category : undefined,
      entry: typeof norm.entry === 'string' ? norm.entry : 'main.js',
      permissions: { ...DEFAULT_PERMISSIONS, ...norm.permissions },
      parameters: norm.parameters.map((p) => ({ ...p })),
      // trusted: admin-only trust bit (script-sandbox.md §7). Default false;
      // only set via trust()/untrust() at the service layer — never via create/update/import.
      trusted: false,
      versions: [],
      createdAt: ts,
      updatedAt: ts,
    };
    if (norm.code !== undefined) {
      if (typeof norm.code !== 'string' || norm.code.trim().length === 0) fail('code must be a non-empty string');
      s.versions.push({
        version: typeof norm.version === 'string' && norm.version.length > 0 ? norm.version : nextVersion(s),
        code: norm.code,
        createdAt: ts,
      });
    }
    scripts.push(s);
    persist();
    return JSON.parse(JSON.stringify(s));
  }

  function get(id) {
    const s = find(id);
    return s ? JSON.parse(JSON.stringify(s)) : undefined;
  }

  function list({ includeDeleted = false } = {}) {
    load();
    return scripts
      .filter((s) => includeDeleted || !s.deletedAt)
      .map(stripVersionCodes)
      .map((s) => JSON.parse(JSON.stringify(s)));
  }

  function update(id, patch) {
    const s = find(id);
    if (!s) return undefined;
    if (typeof patch !== 'object' || patch === null) fail('patch must be an object');
    if (patch.trusted !== undefined) fail('trusted is admin-only: use the trust endpoint');
    const next = { ...s };
    for (const key of Object.keys(patch)) {
      if (key === 'trusted') continue; // belt: even if META_FIELDS check is bypassed, trusted never lands here
      if (!META_FIELDS.includes(key)) fail('not an updatable meta field: ' + key);
      next[key] = patch[key];
    }
    validateMeta(next);
    Object.assign(s, {
      name: next.name,
      description: next.description,
      category: next.category,
      entry: next.entry,
      permissions: { ...DEFAULT_PERMISSIONS, ...next.permissions },
      parameters: next.parameters.map((p) => ({ ...p })),
      updatedAt: nowFn(),
    });
    persist();
    return JSON.parse(JSON.stringify(s));
  }

  // Admin-only trust gate (script-sandbox.md §7): hash-signature + explicit
  // grant. signature = sha256(code-of-latest-version + ':' + trustSecret);
  // trust() verifies the signature against the CURRENT latest code, so any
  // later addVersion() invalidates trust until re-signed (see addVersion below).
  function trust(id, { signature, trustSecret, actor } = {}) {
    const s = find(id);
    if (!s) return undefined;
    if (typeof trustSecret !== 'string' || trustSecret === '') fail('trustSecret required');
    if (typeof signature !== 'string' || signature === '') fail('signature required');
    const latest = s.versions[0];
    if (!latest) fail('script has no versions to sign');
    const expected = crypto.createHash('sha256').update(String(latest.code) + ':' + trustSecret).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(signature), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail('bad signature: code or secret mismatch');
    s.trusted = true;
    s.trustedAt = nowFn();
    s.trustedVersion = latest.version;
    if (actor !== undefined) s.trustedBy = String(actor);
    persist();
    return JSON.parse(JSON.stringify(s));
  }

  function untrust(id) {
    const s = find(id);
    if (!s) return undefined;
    s.trusted = false;
    delete s.trustedAt;
    delete s.trustedVersion;
    delete s.trustedBy;
    persist();
    return JSON.parse(JSON.stringify(s));
  }

  function remove(id) {
    const s = find(id);
    if (!s) return undefined;
    s.deletedAt = nowFn();
    persist();
    return JSON.parse(JSON.stringify(s));
  }

  function addVersion(id, code, version) {
    const s = find(id);
    if (!s) return undefined;
    if (typeof code !== 'string' || code.trim().length === 0) fail('code must be a non-empty string');
    const v = typeof version === 'string' && version.length > 0 ? version : nextVersion(s);
    if (s.versions.some((x) => x.version === v)) fail('version already exists: ' + v);
    const entry = { version: v, code, createdAt: nowFn() };
    s.versions.unshift(entry); // newest first
    s.updatedAt = entry.createdAt;
    // new code invalidates the old signature: trust must be re-granted per version
    if (s.trusted) {
      s.trusted = false;
      delete s.trustedAt;
      delete s.trustedVersion;
      delete s.trustedBy;
    }
    persist();
    return { ...entry };
  }

  function getVersion(id, version) {
    const s = find(id);
    if (!s) return undefined;
    if (version === undefined) {
      return s.versions[0] ? { ...s.versions[0] } : undefined;
    }
    const v = s.versions.find((x) => x.version === version);
    return v ? { ...v } : undefined;
  }

  function validateParameters(id, params) {
    const s = find(id);
    if (!s) return { ok: false, errors: [{ name: '', message: 'script not found' }] };
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return { ok: false, errors: [{ name: '', message: 'params must be an object' }] };
    }
    // T3 wash at the boundary: __proto__/constructor/prototype keys die before coerce
    const clean = {};
    for (const k of Object.keys(params)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      clean[k] = params[k];
    }
    const defs = new Map(s.parameters.map((p) => [p.name, p]));
    const errors = [];
    for (const key of Object.keys(clean)) {
      if (!defs.has(key)) errors.push({ name: key, message: 'unknown parameter' });
    }
    const values = {};
    for (const def of s.parameters) {
      const raw = clean[def.name];
      const present = raw !== undefined && raw !== null;
      if (!present) {
        if (def.default !== undefined) {
          values[def.name] = def.default;
        } else if (def.required) {
          errors.push({ name: def.name, message: 'required parameter missing' });
        }
        continue;
      }
      const r = coerceParam(def, raw);
      if (r.ok) values[def.name] = r.value;
      else errors.push({ name: def.name, message: r.message });
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, values };
  }

  function exportScript(id) {
    const s = find(id);
    if (!s) return undefined;
    const latest = s.versions[0];
    return {
      format: 'fp-script',
      v: 1,
      script: {
        name: s.name,
        author: s.author,
        description: s.description,
        category: s.category,
        entry: s.entry,
        permissions: s.permissions,
        parameters: s.parameters,
        // trust bit intentionally NOT exported: trust is per-install signature state,
        // re-granted via trust() after import, never carried in the package.
      },
      version: latest ? latest.version : undefined,
      code: latest ? latest.code : undefined,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  function importScript(json) {
    if (typeof json !== 'object' || json === null) fail('import payload must be an object');
    if (json.format !== 'fp-script') fail('invalid format: expected fp-script');
    if (json.v !== 1) fail('unsupported fp-script version: ' + String(json.v));
    const meta = typeof json.script === 'object' && json.script !== null ? json.script : {};
    // fresh uuid inside create — never overwrites an existing script.
    // Imported scripts always land untrusted even if the payload carries a trust bit.
    const { trusted: _drop, trustedAt: _d1, trustedVersion: _d2, trustedBy: _d3, ...clean } = meta;
    return create({
      ...clean,
      code: typeof json.code === 'string' ? json.code : undefined,
      version: typeof json.version === 'string' ? json.version : undefined,
    });
  }

  return { create, get, list, update, remove, addVersion, getVersion, validateParameters, exportScript, importScript, trust, untrust };
}

module.exports = { createScriptStore };
