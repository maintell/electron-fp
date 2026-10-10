// ponytail: in-memory schedule registry + 5-field cron subset; SQLite cron worker swap later — onFire injects into task-queue.enqueue (batch fan-out).
'use strict';

const { randomUUID } = require('crypto');

const MACROS = { '@daily': '0 0 * * *', '@hourly': '0 * * * *', '@weekly': '0 0 * * 0' };
const RANGES = { min: [0, 59], hour: [0, 23], dom: [1, 31], mon: [1, 12], dow: [0, 6] };
const NAMES = ['min', 'hour', 'dom', 'mon', 'dow'];
const WINDOW_MS = 366 * 24 * 60 * 60 * 1000; // search cap for nextCronAt

// one comma-item: `*` `n` `a-b` `*/n` `a,b,c` (step also on a-b/n); dow 0-6 (0=Sun)
function parseField(raw, min, max, name) {
  const set = new Set();
  for (const part of raw.split(',')) {
    if (!part) throw new Error(`empty item in ${name} field: "${raw}"`);
    let body = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash !== -1) {
      body = part.slice(0, slash);
      const s = part.slice(slash + 1);
      if (!/^\d+$/.test(s) || +s < 1) throw new Error(`bad step in ${name}: ${part}`);
      step = +s;
    }
    if (body === '*') {
      for (let v = min; v <= max; v += step) set.add(v);
    } else if (body.includes('-')) {
      const [a, b] = body.split('-');
      if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) throw new Error(`bad range in ${name}: ${part}`);
      const lo = +a;
      const hi = +b;
      if (lo < min || hi > max || lo > hi) throw new Error(`bad range in ${name}: ${part}`);
      for (let v = lo; v <= hi; v += step) set.add(v);
    } else {
      if (slash !== -1) throw new Error(`step needs * or range in ${name}: ${part}`);
      if (!/^\d+$/.test(body)) throw new Error(`non-numeric ${name} field value: ${part}`);
      const v = +body;
      if (v < min || v > max) throw new Error(`${name} out of range [${min}-${max}]: ${v}`);
      set.add(v);
    }
  }
  if (!set.size) throw new Error(`empty ${name} field`);
  return set;
}

// 5 fields: min hour dom mon dow (no seconds). @daily/@hourly/@weekly sugar.
function parseCron(expr) {
  if (typeof expr !== 'string') throw new Error('cron must be a string');
  const trimmed = expr.trim();
  const fields = (MACROS[trimmed] || trimmed).split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron needs 5 fields (min hour dom mon dow), got ${fields.length}: "${expr}"`);
  }
  const out = { expr };
  for (let i = 0; i < 5; i++) {
    const name = NAMES[i];
    out[name] = parseField(fields[i], RANGES[name][0], RANGES[name][1], name);
  }
  // dom/dow OR-semantics only when BOTH restricted; a full-span field never restricts
  out.domRestricted = out.dom.size < 31;
  out.dowRestricted = out.dow.size < 7;
  return out;
}

function domDowOk(c, d) {
  const dom = c.dom.has(d.getUTCDate());
  const dow = c.dow.has(d.getUTCDay());
  if (c.domRestricted && c.dowRestricted) return dom || dow;
  if (c.domRestricted) return dom;
  if (c.dowRestricted) return dow;
  return true;
}

// next matching epoch ms strictly > afterMs; minute-by-minute, 366-day cap (impossible combos like Feb 30 throw)
function nextCronAt(expr, afterMs) {
  const c = expr && typeof expr === 'object' ? expr : parseCron(expr);
  let t = Math.floor(afterMs / 60000) * 60000 + 60000;
  const deadline = afterMs + WINDOW_MS;
  while (t <= deadline) {
    const d = new Date(t);
    if (
      c.min.has(d.getUTCMinutes()) &&
      c.hour.has(d.getUTCHours()) &&
      c.mon.has(d.getUTCMonth() + 1) &&
      domDowOk(c, d)
    ) {
      return t;
    }
    t += 60000;
  }
  throw new Error(`cron matches nothing within 366 days: "${c.expr}"`);
}

function validate(s) {
  if (!s.scriptId) throw new Error('scriptId required');
  if (!Array.isArray(s.profileContexts) || s.profileContexts.length === 0) {
    throw new Error('profileContexts required (1+)');
  }
  if (s.type === 'once') {
    if (typeof s.atMs !== 'number') throw new Error('atMs (number) required for once');
  } else if (s.type === 'interval') {
    if (typeof s.everyMs !== 'number' || !(s.everyMs >= 1000)) {
      throw new Error('everyMs >= 1000 required for interval');
    }
  } else if (s.type === 'cron') {
    if (typeof s.cron !== 'string') throw new Error('cron (string) required');
    s._cron = parseCron(s.cron); // throws on bad field; cached for tick
  } else {
    throw new Error(`bad type: ${s.type}`);
  }
}

// once -> atMs (past atMs => fires on next tick, intentional); interval/cron -> relative to afterMs
function computeNext(s, afterMs) {
  if (s.type === 'once') return s.atMs;
  if (s.type === 'interval') return afterMs + s.everyMs;
  return nextCronAt(s._cron || s.cron, afterMs);
}

function createScheduler({ now, audit, onFire } = {}) {
  if (typeof onFire !== 'function') throw new Error('onFire required');
  const nowFn = typeof now === 'function' ? now : () => Date.now();
  const auditFn = typeof audit === 'function' ? audit : () => {};
  const schedules = new Map();

  function mustGet(id) {
    const s = schedules.get(id);
    if (!s) throw new Error('unknown schedule: ' + id);
    return s;
  }

  function add(spec = {}) {
    const t = nowFn();
    const s = {
      id: randomUUID(),
      name: spec.name,
      scriptId: spec.scriptId,
      version: spec.version,
      params: spec.params || {},
      profileContexts: [...(spec.profileContexts || [])],
      type: spec.type,
      atMs: spec.atMs,
      everyMs: spec.everyMs,
      cron: spec.cron,
      enabled: spec.enabled !== false,
      maxAttempts: spec.maxAttempts,
      priority: spec.priority,
      lastFiredAt: null,
      nextRunAt: null,
      createdAt: t,
      updatedAt: t,
      state: 'active',
    };
    validate(s);
    s.nextRunAt = computeNext(s, t);
    schedules.set(s.id, s);
    return s;
  }

  function update(id, patch = {}) {
    const s = mustGet(id);
    const t = nowFn();
    const timingChanged =
      'type' in patch || 'atMs' in patch || 'everyMs' in patch || 'cron' in patch;
    const merged = Object.assign({}, s, patch, { id: s.id, updatedAt: t });
    validate(merged); // throws before any mutation => bad patch never half-applies
    Object.assign(s, merged);
    if (timingChanged) {
      s.nextRunAt = computeNext(s, t);
      if (s.state === 'done' && s.nextRunAt != null) s.state = 'active'; // re-arm a re-timed once
    }
    return s;
  }

  function remove(id) {
    return schedules.delete(mustGet(id).id);
  }

  function get(id) {
    return schedules.get(id);
  }

  function list({ enabled, limit, offset } = {}) {
    let out = [...schedules.values()];
    if (enabled != null) out = out.filter((s) => s.enabled === enabled);
    if (offset) out = out.slice(offset);
    if (limit != null) out = out.slice(0, limit);
    return out;
  }

  function pause(id) {
    const s = mustGet(id);
    s.state = 'paused'; // keeps nextRunAt
    s.updatedAt = nowFn();
    return s;
  }

  function resume(id) {
    const s = mustGet(id);
    const t = nowFn();
    s.state = 'active';
    if (s.nextRunAt != null && s.nextRunAt <= t) {
      // overdue while paused: cron/interval jump to future; once keeps past atMs => fires on next tick
      if (s.type !== 'once') s.nextRunAt = computeNext(s, t);
    }
    s.updatedAt = t;
    return s;
  }

  // manual fire regardless of state/enabled (db.md §9: manual trigger doesn't flip status);
  // no skip audit here — skip is a tick-side missed-window signal only
  function triggerNow(id) {
    const s = mustGet(id);
    const t = nowFn();
    fire(s, t);
    reschedule(s, t);
    return s;
  }

  function fire(s, t) {
    // fan-out: one onFire(schedule, ctx) per profileContext so tests/callers can count per-ctx
    for (const ctx of s.profileContexts) onFire(s, ctx);
    s.lastFiredAt = t;
    auditFn({ type: 'schedule-fire', id: s.id, ctxCount: s.profileContexts.length });
  }

  function reschedule(s, t) {
    s.updatedAt = t;
    if (s.type === 'once') {
      s.state = 'done';
      s.nextRunAt = null;
    } else if (s.type === 'interval') {
      s.nextRunAt = t + s.everyMs; // never backfill missed windows
    } else {
      s.nextRunAt = nextCronAt(s._cron || s.cron, t);
    }
  }

  function tick() {
    const t = nowFn();
    for (const s of [...schedules.values()]) {
      if (s.state !== 'active' || !s.enabled) continue;
      if (s.nextRunAt == null || s.nextRunAt > t) continue;
      const overdueMs = t - s.nextRunAt;
      fire(s, t);
      if (s.type === 'interval' && overdueMs > 2 * s.everyMs) {
        auditFn({ type: 'schedule-skip', id: s.id, ctxCount: s.profileContexts.length });
      }
      reschedule(s, t);
    }
  }

  function stats() {
    const out = { total: schedules.size, active: 0, paused: 0, done: 0, nextDueInMs: null };
    const t = nowFn();
    for (const s of schedules.values()) {
      if (s.state === 'active') out.active++;
      else if (s.state === 'paused') out.paused++;
      else if (s.state === 'done') out.done++;
      if (s.state === 'active' && s.enabled && s.nextRunAt != null) {
        const due = s.nextRunAt - t;
        if (out.nextDueInMs == null || due < out.nextDueInMs) out.nextDueInMs = due;
      }
    }
    return out;
  }

  return { add, update, remove, get, list, pause, resume, triggerNow, tick, stats };
}

module.exports = { parseCron, nextCronAt, createScheduler };
