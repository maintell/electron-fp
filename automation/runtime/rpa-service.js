// ponytail: RPA flow persistence + replay over the EXISTING script store/manager —
// no second runtime. The flow rides in a header comment on a normal script version,
// so Save/Load/Replay reuse the script pipeline (the executor injects browser/page
// and replay never calls runAst directly). Same {ok,data}|{ok,error} envelope as
// the recorder/service groups so the IPC bridge/preload autoCall unwrap works.
'use strict';

const { validateAst, astToScript } = require('./rpa-ast');

const HEADER = '/* FP_RPA_FLOW:';
const KNOWN_CODES = new Set(['NOT_FOUND', 'VALIDATION', 'CONFLICT', 'LIMIT', 'INTERNAL', 'NOT_IMPLEMENTED']);

function mapError(e) {
  const message = String((e && e.message) || e);
  if (e && e.code && KNOWN_CODES.has(e.code)) return { ok: false, error: { code: e.code, message } };
  if (/not found|unknown /i.test(message)) return { ok: false, error: { code: 'NOT_FOUND', message } };
  if (/conflict|illegal|already/i.test(message)) return { ok: false, error: { code: 'CONFLICT', message } };
  if (e instanceof TypeError || e instanceof RangeError) return { ok: false, error: { code: 'INTERNAL', message } };
  return { ok: false, error: { code: 'VALIDATION', message } };
}

function isRpaCode(code) {
  return typeof code === 'string' && code.startsWith(HEADER);
}

// Header is `/* FP_RPA_FLOW:<json> */\n<generated code>`. JSON.stringify never emits
// a raw newline, so the ` */\n` terminator is unambiguous; fall back to `*/` if the
// generated body has no newline for some reason.
function parseHeader(code) {
  if (!isRpaCode(code)) return null;
  let end = code.indexOf(' */\n');
  if (end === -1) end = code.indexOf('*/', HEADER.length);
  if (end === -1) return null;
  const json = code.slice(HEADER.length, end).trim();
  try {
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

// store.list() strips version codes (HTTP shape), so scan full records for the
// header. Script counts are small; this is a local in-process lookup.
function findRpaScript(store) {
  let rows = [];
  try {
    rows = store.list() || [];
  } catch (_) {
    return null;
  }
  for (const row of rows) {
    let full;
    try {
      full = store.get(row.id);
    } catch (_) {
      continue;
    }
    const latest = full && full.versions && full.versions[0];
    if (latest && isRpaCode(latest.code)) return full;
  }
  return null;
}

function createRpaService({ store, manager } = {}) {
  const ok = (data) => ({ ok: true, data });
  const fail = (code, message) => ({ ok: false, error: { code, message: String(message) } });

  // ALWAYS ok:true — the validation result (which may itself be ok:false) rides in
  // data so the builder can render per-node errors instead of a thrown banner.
  function validate(flow) {
    const nodes = flow && Array.isArray(flow.nodes) ? flow.nodes : [];
    try {
      return ok(validateAst(nodes));
    } catch (e) {
      return ok({ ok: false, errors: [String((e && e.message) || e)] });
    }
  }

  function save(flow) {
    try {
      const name = flow && typeof flow.name === 'string' ? flow.name : '';
      const nodes = flow && Array.isArray(flow.nodes) ? flow.nodes : [];
      const v = validateAst(nodes);
      if (!v.ok) return fail('VALIDATION', 'invalid flow: ' + v.errors.join('; '));
      const code = HEADER + JSON.stringify({ name, nodes }) + ' */\n' + astToScript(nodes).code;
      const existing = findRpaScript(store);
      let script;
      if (existing) {
        store.update(existing.id, { name: name || existing.name });
        store.addVersion(existing.id, code);
        script = store.get(existing.id);
      } else {
        // Default permissions keep browser/cookies/storage/network ON so replay can
        // actually drive the tab; store.create merges DEFAULT_PERMISSIONS over {}.
        script = store.create({ name: name || 'rpa-flow', code });
      }
      return ok({ id: script.id, name: script.name, nodes });
    } catch (e) {
      return mapError(e);
    }
  }

  function load() {
    try {
      const existing = findRpaScript(store);
      if (!existing) return ok({ name: '', nodes: [] });
      const parsed = parseHeader(existing.versions[0].code);
      if (!parsed) return ok({ name: '', nodes: [] });
      return ok({ name: String(parsed.name || ''), nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [] });
    } catch (e) {
      return mapError(e);
    }
  }

  // Compile through the normal script path (do NOT await the run): the executor
  // injects browser/page for the bound profileContext. Returns the executionId so
  // the UI can subscribe to live logs / poll.
  function replay(flow, opts) {
    try {
      const saved = save(flow);
      if (!saved.ok) return saved;
      const profileContext = opts && opts.profileContext;
      const h = manager.runScriptCancellable(saved.data.id, { profileContext });
      return ok({ executionId: h.executionId });
    } catch (e) {
      return mapError(e);
    }
  }

  return { rpa: { validate, save, load, replay } };
}

module.exports = { createRpaService, HEADER, isRpaCode, parseHeader };
