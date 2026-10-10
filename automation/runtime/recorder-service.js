// ponytail: thin {ok,data}|{ok,error} group over the recorder controller (same shape as
// automation-service groups). Without a wired controller every method is an honest NOT_IMPLEMENTED.
'use strict';

const NOT_IMPL = { ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'recorder controller not wired' } };
const KNOWN_CODES = new Set(['NOT_FOUND', 'VALIDATION', 'CONFLICT', 'LIMIT', 'INTERNAL', 'NOT_IMPLEMENTED']);

// local mapper (mirrors automation-service.js; no import to avoid a cycle)
function mapError(e) {
  const message = String((e && e.message) || e);
  if (e && e.code && KNOWN_CODES.has(e.code)) return { ok: false, error: { code: e.code, message } };
  if (/not found|unknown /i.test(message)) return { ok: false, error: { code: 'NOT_FOUND', message } };
  if (/conflict|illegal|already/i.test(message)) return { ok: false, error: { code: 'CONFLICT', message } };
  if (e instanceof TypeError || e instanceof RangeError) return { ok: false, error: { code: 'INTERNAL', message } };
  return { ok: false, error: { code: 'VALIDATION', message } };
}

function createRecorderService({ controller } = {}) {
  const has = (name) => controller && typeof controller[name] === 'function';
  const sync = (name) => (arg) => {
    if (!has(name)) return NOT_IMPL;
    try {
      return { ok: true, data: controller[name](arg) };
    } catch (e) {
      return mapError(e);
    }
  };
  const asyn = (name) => async (arg) => {
    if (!has(name)) return NOT_IMPL;
    try {
      return { ok: true, data: await controller[name](arg) };
    } catch (e) {
      return mapError(e);
    }
  };
  return {
    recorder: {
      start: asyn('start'),
      drain: asyn('drain'),
      stop: asyn('stop'),
      state: sync('state'),
    },
  };
}

module.exports = { createRecorderService };
