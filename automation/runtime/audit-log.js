// ponytail: file-backed central audit collector (database.md §12 shape, JSONL transport).
// SQLite lands at database.md P9; until then every runtime module's audit callback
// funnels here: append-only JSONL (crash-safe, replayable per gap-appx-B step 5),
// in-memory ring for query(), and the database.md §12 index keys (actor/action/
// entity/entity_id/created_at). Query is filter+slice only — no SQL, no deps.
// Secret rule (security.md §9): the collector REDACTS known secret shapes at the
// door (token/Authorization/proxy password/FP carriers); callers must still avoid
// sending them, this is the second net, not the first.
'use strict';

const fs = require('fs');
const path = require('path');

const FP_RE = /--fingerprint-config=[A-Za-z0-9+/=]+|FP_CONFIG_DATA|Bearer\s+[A-Za-z0-9\-._~+/=]+/g;
const SECRET_KEYS = new Set(['token', 'authorization', 'password', 'secret', 'key', 'signature', 'bearerToken', 'proxyPassword']);

function scrubValue(v) {
  if (typeof v === 'string') {
    const s = v.replace(FP_RE, '[SCRUBBED:fp-carrier]');
    return s.length > 4096 ? s.slice(0, 4096) + '...[truncated]' : s;
  }
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === 'object') {
    const out = Array.isArray(v) ? [] : {};
    for (const k of Object.keys(v)) {
      out[k] = SECRET_KEYS.has(k) || SECRET_KEYS.has(String(k).toLowerCase()) ? '***' : scrubValue(v[k]);
    }
    return out;
  }
  return v;
}

function createAuditLog({ file, capacity = 10000, now } = {}) {
  const nowFn = typeof now === 'function' ? now : () => new Date().toISOString();
  const ring = [];
  let seq = 0;

  function append(ev) {
    const row = Object.assign({}, scrubValue(ev && typeof ev === 'object' ? ev : { message: String(ev) }));
    row.seq = ++seq;
    if (row.created_at === undefined) row.created_at = nowFn();
    // database.md §12 index keys, defaulted so queries never touch undefined
    if (row.actor === undefined) row.actor = row.sub || 'system';
    if (row.action === undefined) row.action = row.type || 'event';
    if (row.entity === undefined) row.entity = row.channel || row.id ? 'event' : 'system';
    if (row.entity_id === undefined) row.entity_id = row.id || row.executionId || row.runId || null;
    ring.push(row);
    if (ring.length > capacity) ring.shift();
    if (file) {
      try {
        const dir = path.dirname(file);
        if (dir) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
      } catch (_) { /* audit never breaks the run */ }
    }
    return row;
  }

  // fn compatible with every existing `audit` injection point: audit(fn) where
  // modules call audit({...}) or audit(event, detail) (ipc-bridge style).
  function fn(a, b) {
    if (typeof a === 'string' && b && typeof b === 'object') return append(Object.assign({ type: a }, b));
    return append(a);
  }
  fn.append = append;

  function query({ actor, action, entity, entity_id, type, since, until, limit = 100, offset = 0 } = {}) {
    let out = ring;
    if (actor !== undefined) out = out.filter((r) => r.actor === actor);
    if (action !== undefined) out = out.filter((r) => r.action === action);
    if (entity !== undefined) out = out.filter((r) => r.entity === entity);
    if (entity_id !== undefined) out = out.filter((r) => r.entity_id === entity_id);
    if (type !== undefined) out = out.filter((r) => r.type === type);
    if (since !== undefined) out = out.filter((r) => r.created_at >= since);
    if (until !== undefined) out = out.filter((r) => r.created_at <= until);
    const total = out.length;
    return { total, rows: out.slice(offset, offset + limit).map((r) => Object.assign({}, r)) };
  }

  function stats() {
    const byAction = {};
    for (const r of ring) byAction[r.action] = (byAction[r.action] || 0) + 1;
    return { total: seq, buffered: ring.length, byAction };
  }

  return { append, query, stats, fn };
}

module.exports = { createAuditLog, scrubValue };
