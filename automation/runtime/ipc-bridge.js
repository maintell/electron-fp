// ponytail: sender-check + allowlist choke point for renderer→main automation calls; production wires ipcMain via createIpcBridge; keeps service {ok,data,error} envelope.
'use strict';

// channel → path into nested createAutomationService() façade (automation-service.js).
// export/import/cancel short names map to exportOne/importOne/stop; list/get flatten to listTasks/getTask etc.
const CHANNEL_MAP = {
  'automation:status': ['status'],
  'automation:scripts:list': ['scripts', 'list'],
  'automation:scripts:get': ['scripts', 'get'],
  'automation:scripts:create': ['scripts', 'create'],
  'automation:scripts:update': ['scripts', 'update'],
  'automation:scripts:remove': ['scripts', 'remove'],
  'automation:scripts:saveVersion': ['scripts', 'saveVersion'],
  'automation:scripts:export': ['scripts', 'exportOne'],
  'automation:scripts:import': ['scripts', 'importOne'],
  'automation:scripts:validateParams': ['scripts', 'validateParams'],
  'automation:scripts:trust': ['scripts', 'trust'],
  'automation:scripts:untrust': ['scripts', 'untrust'],
  'automation:run': ['run', 'runScript'],
  'automation:executions:get': ['run', 'getExecution'],
  'automation:executions:list': ['run', 'listExecutions'],
  'automation:executions:logs': ['run', 'getLogs'],
  'automation:executions:cancel': ['run', 'stop'],
  'automation:tasks:enqueue': ['tasks', 'enqueue'],
  'automation:tasks:list': ['tasks', 'listTasks'],
  'automation:tasks:get': ['tasks', 'getTask'],
  'automation:tasks:cancel': ['tasks', 'cancelTask'],
  'automation:tasks:pause': ['tasks', 'pauseTask'],
  'automation:tasks:resume': ['tasks', 'resumeTask'],
  'automation:tasks:retry': ['tasks', 'retryTask'],
  'automation:schedules:add': ['schedules', 'addSchedule'],
  'automation:schedules:list': ['schedules', 'listSchedules'],
  'automation:schedules:pause': ['schedules', 'pauseSchedule'],
  'automation:schedules:resume': ['schedules', 'resumeSchedule'],
  'automation:schedules:trigger': ['schedules', 'triggerSchedule'],
  'automation:schedules:remove': ['schedules', 'removeSchedule'],
  'automation:profiles:list': ['profiles', 'list'],
  'automation:profiles:get': ['profiles', 'get'],
  'automation:profiles:create': ['profiles', 'create'],
  'automation:profiles:update': ['profiles', 'update'],
  'automation:profiles:remove': ['profiles', 'remove'],
  'automation:profiles:start': ['profiles', 'start'],
  'automation:profiles:stop': ['profiles', 'stop'],
  'automation:profiles:status': ['profiles', 'status'],
  'automation:profiles:bulkStart': ['profiles', 'bulkStart'],
  'automation:profiles:fingerprintUpdate': ['profiles', 'fingerprintUpdate'],
  'automation:profiles:fingerprintRotate': ['profiles', 'fingerprintRotate'],
  'automation:templates:list': ['templates', 'list'],
  'automation:templates:install': ['templates', 'install'],
  'automation:recorder:start': ['recorder', 'start'],
  'automation:recorder:drain': ['recorder', 'drain'],
  'automation:recorder:stop': ['recorder', 'stop'],
  'automation:recorder:state': ['recorder', 'state'],
  'automation:rpa:validate': ['rpa', 'validate'],
  'automation:rpa:save': ['rpa', 'save'],
  'automation:rpa:load': ['rpa', 'load'],
  'automation:rpa:replay': ['rpa', 'replay'],
  'automation:audit:query': ['audit', 'query'],
  'automation:audit:stats': ['audit', 'stats'],
  'automation:metrics': ['metrics', 'summary'],
};

const ALLOWED_CHANNELS = Object.freeze(Object.keys(CHANNEL_MAP));
const ALLOWED_SET = new Set(ALLOWED_CHANNELS);

// default policy when caller passes no allowedSenders rules
const DEFAULT_URL_PREFIXES = ['file://', 'http://127.0.0.1', 'http://localhost'];

function safeGetURL(sender) {
  try {
    return sender && typeof sender.getURL === 'function' ? sender.getURL() : undefined;
  } catch {
    return undefined;
  }
}

// ponytail: rules[].frame reserved — webContents has no stable frame-name API in mocks; urlPrefix is the enforced field.
function isSenderAllowed(sender, allowedSenders) {
  if (!sender || typeof sender.getType !== 'function' || typeof sender.getURL !== 'function') return false;
  let type;
  try {
    type = sender.getType();
  } catch {
    return false;
  }
  if (type !== 'window' && type !== 'webContents') return false; // webview frames die here
  const url = safeGetURL(sender) || '';
  if (Array.isArray(allowedSenders) && allowedSenders.length > 0) {
    return allowedSenders.some((r) => r && typeof r.urlPrefix === 'string' && url.startsWith(r.urlPrefix));
  }
  return DEFAULT_URL_PREFIXES.some((p) => url.startsWith(p));
}

function deny(message) {
  return { ok: false, error: { code: 'DENY', message } };
}

// mapError-lite: throws only — service normally returns envelopes itself
function mapThrow(e) {
  const message = String((e && e.message) || e);
  if (/not found/i.test(message)) return { ok: false, error: { code: 'NOT_FOUND', message } };
  return { ok: false, error: { code: 'INTERNAL', message } };
}

function normalize(result) {
  if (result && typeof result === 'object' && typeof result.ok === 'boolean') return result;
  return { ok: true, data: result };
}

function resolve(service, path) {
  let cur = service;
  for (const key of path) {
    if (!cur || (typeof cur !== 'object' && typeof cur !== 'function')) return null;
    cur = cur[key];
  }
  return typeof cur === 'function' ? cur : null;
}

function createIpcBridge({ service, audit, allowedSenders, now } = {}) {
  if (!service || typeof service !== 'object') throw new Error('service required');
  const log = typeof audit === 'function' ? audit : () => {};
  const ts = typeof now === 'function' ? now : Date.now;

  async function handle(channel, event, ...args) {
    if (!ALLOWED_SET.has(channel)) {
      log('ipc-deny', { reason: 'unknown-channel', channel, ts: ts() });
      return deny('channel not allowed');
    }
    const sender = event && event.sender;
    if (!isSenderAllowed(sender, allowedSenders)) {
      log('ipc-deny', { reason: 'sender', url: safeGetURL(sender), ts: ts() });
      return deny('sender not allowed'); // never leak which check failed
    }
    const fn = resolve(service, CHANNEL_MAP[channel]);
    if (!fn) {
      log('ipc-call', { channel, status: 'error', code: 'INTERNAL', ts: ts() });
      return { ok: false, error: { code: 'INTERNAL', message: 'service method missing' } };
    }
    let out;
    try {
      out = normalize(await fn(...args));
    } catch (e) {
      out = mapThrow(e);
      log('ipc-call', { channel, status: 'error', code: out.error.code, ts: ts() });
      return out;
    }
    // channel + status + code only — args may hold secrets, never dumped
    log('ipc-call', {
      channel,
      status: out.ok ? 'ok' : 'error',
      ...(out.ok ? {} : { code: (out.error && out.error.code) || 'ERROR' }),
      ts: ts(),
    });
    return out;
  }

  // register only allowlisted channels; optional requested list must be a subset or it throws
  function register(ipcMainLike, channels) {
    if (!ipcMainLike || typeof ipcMainLike.handle !== 'function') throw new Error('ipcMain-like required');
    const wanted = channels === undefined ? ALLOWED_CHANNELS : channels;
    if (!Array.isArray(wanted)) throw new Error('channels must be an array');
    for (const ch of wanted) {
      if (!ALLOWED_SET.has(ch)) throw new Error('channel not allowed: ' + ch);
    }
    const registered = [];
    for (const channel of wanted) {
      ipcMainLike.handle(channel, (event, ...args) => handle(channel, event, ...args));
      registered.push(channel);
    }
    return registered;
  }

  return {
    handle,
    register,
    isSenderAllowed: (sender) => isSenderAllowed(sender, allowedSenders),
    allowedChannels: ALLOWED_CHANNELS,
  };
}

module.exports = { createIpcBridge, ALLOWED_CHANNELS, isSenderAllowed };
