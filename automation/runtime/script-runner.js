// ponytail: node:vm capability sandbox — NOT a hard security boundary; ceiling: same-process escape. Upgrade path: utilityProcess/worker + structured clone when handling stranger-than-team scripts.
'use strict';

const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

// --- error taxonomy (script-sdk.md §6) ---
class ScriptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScriptError';
    this.code = 'SCRIPT';
    this.retriable = false;
  }
}
class TimeoutError extends ScriptError {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
    this.code = 'TIMEOUT';
    this.retriable = true;
  }
}
class SelectorError extends ScriptError {
  constructor(message) {
    super(message);
    this.name = 'SelectorError';
    this.code = 'SELECTOR';
    this.retriable = false;
  }
}
class BrowserError extends ScriptError {
  constructor(message) {
    super(message);
    this.name = 'BrowserError';
    this.code = 'BROWSER';
    this.retriable = false;
  }
}
class NetworkError extends ScriptError {
  constructor(message) {
    super(message);
    this.name = 'NetworkError';
    this.code = 'NETWORK';
    this.retriable = true;
  }
}
class PermissionError extends ScriptError {
  constructor(message) {
    super(message);
    this.name = 'PermissionError';
    this.code = 'PERMISSION';
    this.retriable = false;
  }
}
class ProfileError extends ScriptError {
  constructor(message) {
    super(message);
    this.name = 'ProfileError';
    this.code = 'PROFILE';
    this.retriable = false;
  }
}
class DownloadError extends ScriptError {
  constructor(message) {
    super(message);
    this.name = 'DownloadError';
    this.code = 'DOWNLOAD';
    this.retriable = false;
  }
}
class UploadError extends ScriptError {
  constructor(message) {
    super(message);
    this.name = 'UploadError';
    this.code = 'UPLOAD';
    this.retriable = false;
  }
}
// NOT in ERROR_CLASSES/listErrors (taxonomy stays 9): cooperative abort signal, terminal CANCELLED.
class CancelledError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CancelledError';
    this.code = 'CANCELLED';
    this.retriable = false;
  }
}

const ERROR_CLASSES = [
  ScriptError,
  TimeoutError,
  SelectorError,
  BrowserError,
  NetworkError,
  PermissionError,
  ProfileError,
  DownloadError,
  UploadError,
];
const ERROR_NAMES = ERROR_CLASSES.map((C) => C.name);
const NAME_TO_CLASS = Object.fromEntries(ERROR_CLASSES.map((C) => [C.name, C]));
// ponytail: naive code-prefix table, refine per real Adapter errors
const CODE_PREFIXES = [
  ['BROWSER_', BrowserError],
  ['NETWORK_', NetworkError],
  ['SELECTOR_', SelectorError],
  ['PROFILE_', ProfileError],
  ['DOWNLOAD_', DownloadError],
  ['UPLOAD_', UploadError],
  ['PERMISSION_', PermissionError],
  ['TIMEOUT_', TimeoutError],
];

const CAP_KEYS = ['browser', 'cookies', 'storage', 'network', 'filesystem', 'process', 'profile', 'screenshot', 'upload', 'clipboard'];
const MAX_LOGS = 1000;
// §16 failure forensics caps: DOM snapshot is bounded by bytes, network by tail entries.
const MAX_TRACE_HTML_BYTES = 262144;
const MAX_TRACE_NETWORK = 50;
// sleep/wait intentionally absent: smart waits live on page.* (script-sdk §2.2) — absence is the lesson.

function listErrors() {
  return ERROR_NAMES.slice();
}

function classify(err) {
  if (err == null) return new ScriptError(String(err));
  if (typeof err === 'object') {
    for (const C of ERROR_CLASSES) if (err instanceof C) return err;
    if (typeof err.name === 'string' && NAME_TO_CLASS[err.name]) {
      const C = NAME_TO_CLASS[err.name];
      const e = new C(String(err.message));
      if (err.stack) e.stack = err.stack;
      return e;
    }
    if (typeof err.code === 'string') {
      for (const [prefix, C] of CODE_PREFIXES) {
        if (err.code.startsWith(prefix)) {
          const e = new C(String(err.message));
          e.code = err.code;
          if (err.stack) e.stack = err.stack;
          return e;
        }
      }
    }
    if (err instanceof SyntaxError) {
      const e = new ScriptError(String(err.message));
      if (err.stack) e.stack = err.stack;
      return e;
    }
    if (err.message && /timed out/i.test(String(err.message))) return new TimeoutError(String(err.message));
    const e = new ScriptError(String(err.message || err));
    if (err.stack) e.stack = err.stack;
    return e;
  }
  return new ScriptError(String(err));
}

function denyProxy(name) {
  const deny = (access) => new PermissionError(name + ' permission denied' + (access ? ' (access: ' + access + ')' : ''));
  return new Proxy(
    {},
    {
      get(_t, prop) {
        throw deny(String(prop));
      },
      set() {
        throw deny('set');
      },
      has() {
        throw deny('has');
      },
      apply() {
        throw deny('call');
      },
      construct() {
        throw deny('construct');
      },
    }
  );
}

function instrument(value, path, push, thisArg, secretNames) {
  if (typeof value === 'function') {
    const fn = value;
    return (...args) => {
      const safe = args.map((a) => {
        if (typeof a !== 'string') return typeof a === 'number' || typeof a === 'boolean' ? a : typeof a;
        return scrubSecrets(a, secretNames);
      });
      push('info', [path, ...safe]);
      return fn.apply(thisArg, args);
    };
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = instrument(value[k], path + '.' + k, push, value, secretNames);
    return Object.freeze(out);
  }
  return value;
}

function makeConsole(push, secretNames) {
  const wrap = (level) => (...args) => {
    const safe = (args || []).map((a) => (typeof a === 'string' ? scrubSecrets(a, secretNames) : a));
    return push(level, safe);
  };
  return Object.freeze({ log: wrap('info'), info: wrap('info'), warn: wrap('warn'), error: wrap('error'), debug: wrap('debug') });
}

// Prototype-pollution wash (security.md T3 / script-sandbox.md §6#3): params and
// task inputs cross the host→vm boundary; __proto__/constructor/prototype keys
// must die here, before Object.assign/freeze. Returns a fresh plain object.
function cleanInput(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const k of Object.keys(obj)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const v = obj[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? cleanInput(v) : v;
  }
  return out;
}

// Secret-param redaction (security.md §9): params declared `secret` in the script
// schema resolve to values but must never land in error.message / logs / audit.
// Values themselves stay intact for the script; only rendered strings are scrubbed.
function scrubSecrets(text, secretNames) {
  if (typeof text !== 'string' || !secretNames || !secretNames.size) return text;
  let out = text;
  for (const n of secretNames) {
    if (!n) continue;
    try {
      out = out.split(String(n)).join('***');
    } catch (_) {}
  }
  return out;
}

function capAllowed(spec, key) {
  const perm = spec.permissions || {};
  if (!perm[key]) return false;
  // filesystem/process: always gated by trusted opt-in, even when permission bit true.
  // Legacy boolean path (unwired test/CLI mode). Wired mode uses the trustResolver
  // in run() and ignores spec.trusted — see createScriptRunner header.
  if (key === 'filesystem' || key === 'process') return spec.trusted === true;
  return true;
}

// §16 failure forensics: best-effort DOM/HTML + network + URL snapshot. Every source is
// independently guarded — never throws, keeps partial capture. Extracted (not inlined) so the
// URL fallback is unit-testable without a live page.
async function buildTrace({ browserApi, currentUrl, now } = {}) {
  const ts = typeof now === 'function' ? now() : Date.now();
  const sources = { html: false, network: false, url: false };
  const trace = { ts, url: null, htmlBytes: 0, htmlTruncated: false, network: [], sources };
  const page = browserApi && browserApi.page;
  // URL: prefer live page.getCurrentUrl, fall back to the record's last-known URL.
  let url;
  try {
    if (page && typeof page.getCurrentUrl === 'function') url = await page.getCurrentUrl();
  } catch (_) {}
  if (typeof url !== 'string' || !url) url = currentUrl;
  if (typeof url === 'string' && url) {
    trace.url = url;
    sources.url = true;
  }
  // HTML: outerHTML string only, hard byte cap.
  try {
    if (page && typeof page.evaluate === 'function') {
      const v = await page.evaluate('document.documentElement.outerHTML');
      if (typeof v === 'string') {
        let html = v;
        if (Buffer.byteLength(html, 'utf8') > MAX_TRACE_HTML_BYTES) {
          // ponytail: byte-cap slice (ASCII-exact); a multibyte boundary may re-encode to a
          // replacement char, so stored bytes can differ from the cap by a byte or two.
          html = Buffer.from(html, 'utf8').subarray(0, MAX_TRACE_HTML_BYTES).toString('utf8');
          trace.htmlTruncated = true;
        }
        trace.html = html;
        trace.htmlBytes = Buffer.byteLength(html, 'utf8');
        sources.html = true;
      }
    }
  } catch (_) {}
  // Network: tail of the driver ring.
  try {
    const net = browserApi && browserApi.network;
    if (net && typeof net.recent === 'function') {
      const arr = await net.recent();
      if (Array.isArray(arr)) {
        trace.network = arr.slice(-MAX_TRACE_NETWORK);
        sources.network = true;
      }
    }
  } catch (_) {}
  return trace;
}

function createScriptRunner({ browserApi, audit, timeoutMs = 30000, trustResolver } = {}) {
  let cancelled = false;
  // trustResolver(scriptId) -> boolean|Promise<boolean>: service-layer trust lookup.
  // When wired (production), spec.trusted is IGNORED and trust comes from the store
  // via this resolver; when absent (unit tests, bin/browser-cli.js), the legacy
  // spec.trusted boolean applies. This keeps the runner testable without a store.

  function pushLog(logs, level, args, onLog) {
    if (logs.length >= MAX_LOGS) return;
    const line = { ts: Date.now(), level, args };
    logs.push(line);
    // ponytail: live-log fan-out (wire emit → preload → panel). Same trust zone as
    // getLogs polling; never throws into the run.
    if (typeof onLog === 'function') {
      try {
        onLog(line);
      } catch {}
    }
  }

  async function run(spec, params, { signal, onLog } = {}) {
    const record = {
      executionId: randomUUID(),
      scriptId: spec && spec.id,
      scriptVersion: spec && spec.version,
      profileId: (spec && spec.profileContext && spec.profileContext.id) || null,
      status: 'RUNNING',
      startTime: Date.now(),
      endTime: null,
      durationMs: null,
      error: null,
      currentStep: null,
      currentUrl: null,
      logs: [],
      result: undefined,
      artifacts: [], // failure screenshots / traces (§41 #10); failure-only, never on SUCCESS
    };
    const logs = record.logs;
    let timer = null;
    // secret params: names resolved from the script schema so values can be
    // scrubbed from every rendered string (logs/error/audit), never the values.
    // Declared OUTSIDE try: the catch path (error scrub) needs it even when the
    // try body throws before its own declaration would run (TDZ crash).
    const secretNames = new Set();
    try {
      for (const p of (spec && spec.parameters) || []) {
        if (p && (p.type === 'secret' || p.secret === true) && typeof p.name === 'string') secretNames.add(p.name);
      }
      for (const n of [...secretNames]) {
        const v = params && params[n];
        if (typeof v === 'string' && v) secretNames.add(v);
      }
    } catch (_) {}
    // ponytail: browserApi.screenshot preferred, browserApi.browser.screenshot fallback (bin mock shape).
    async function captureArtifact() {
      try {
        const fn =
          browserApi && typeof browserApi.screenshot === 'function'
            ? browserApi.screenshot
            : browserApi && browserApi.browser && typeof browserApi.browser.screenshot === 'function'
              ? browserApi.browser.screenshot.bind(browserApi.browser)
              : null;
        if (!fn) return;
        const shot = await fn();
        record.artifacts.push({
          ts: Date.now(),
          kind: 'screenshot',
          bytes: Buffer.isBuffer(shot) ? shot.length : typeof shot === 'string' ? shot.length : undefined,
        });
      } catch (e) {
        record.artifacts.push({ ts: Date.now(), kind: 'screenshot', error: String((e && e.message) || e) });
      }
    }
    try {
      if (cancelled || (signal && signal.aborted)) {
        record.status = 'CANCELLED';
        record.error = { name: 'CancelledError', message: 'script cancelled before start', stack: null };
        return record;
      }
      const perm = (spec && spec.permissions) || {};
      if (perm.browser && !browserApi) {
        throw new ScriptError('browserApi is required when permissions.browser is true');
      }
      const push = (level, args) => pushLog(logs, level, args, onLog);
      const sandbox = {
        params: Object.freeze(cleanInput(params || {})),
        context: Object.freeze({ profile: spec.profileContext }),
        console: makeConsole(push, secretNames),
        step(name) {
          // cooperative seam for future smart-waits: abort surfaces here as CancelledError
          if (signal && signal.aborted) throw new CancelledError('script cancelled at step: ' + String(name));
          record.currentStep = String(name);
          push('info', ['step', String(name)]);
        },
        // explicit allowlist — sandbox does not inherit host globals
        JSON,
        Math,
        Date,
        Promise,
        URL,
        structuredClone,
      };
      for (const C of ERROR_CLASSES) sandbox[C.name] = Object.freeze(C);

      const expose = (key) => {
        if (browserApi && browserApi[key] !== undefined) return instrument(browserApi[key], key, push, browserApi[key], secretNames);
        // gate open but api not injected: global present as undefined → clean TypeError, not PermissionError
        return undefined;
      };

      // trust gate (script-sandbox.md §7): filesystem/process need the permission bit
      // AND store-level trust. Resolver wins when wired; legacy spec.trusted boolean
      // only applies in unwired (test/CLI) mode.
      let storeTrusted = null;
      if (typeof trustResolver === 'function' && spec && spec.id) {
        try {
          storeTrusted = !!(await trustResolver(spec.id));
        } catch (_) {
          storeTrusted = false; // resolver failure = deny, never fail-open
        }
      }
      const isAllowed = (key) => {
        const perm = (spec && spec.permissions) || {};
        if (!perm[key]) return false;
        if (key === 'filesystem' || key === 'process') {
          if (storeTrusted !== null) return storeTrusted;
          return spec.trusted === true;
        }
        return true;
      };

      for (const key of CAP_KEYS) {
        sandbox[key] = isAllowed(key) ? expose(key) : denyProxy(key);
      }
      // page rides the browser permission group (script-sdk: browser-facing surface)
      sandbox.page = isAllowed('browser') ? expose('page') : denyProxy('browser');

      // RPA-compiled helpers (astToScript emits log(...)/delay(...)/download.wait()):
      // host-provided, no I/O capability — log/delay are pure; download rides the
      // browser permission group (same as page). Lets a visual-workflow flow replay.
      sandbox.log = (...a) => push('info', a);
      sandbox.delay = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(Number(ms) || 0, 30000))));
      if (browserApi && browserApi.download !== undefined) {
        sandbox.download = isAllowed('browser') ? expose('download') : denyProxy('browser');
      }

      const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
      const wrapped = "(async () => {\n'use strict';\n" + String((spec && spec.code) || '') + '\n})()';
      const script = new vm.Script(wrapped, { filename: ((spec && spec.id) || 'script') + '.js' });
      const p = script.runInContext(ctx, { timeout: Math.max(1, timeoutMs) });
      const timeoutPromise = new Promise((_res, rej) => {
        timer = setTimeout(() => rej(new TimeoutError('script timed out after ' + timeoutMs + 'ms')), timeoutMs);
      });
      // abort vs timeout: whichever settles first wins (TIMEOUT path unchanged when it fires first)
      let onAbort = null;
      let abortPromise = null;
      if (signal) {
        abortPromise = new Promise((_res, rej) => {
          onAbort = () => rej(new CancelledError('script cancelled'));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      try {
        record.result = await Promise.race(abortPromise ? [p, timeoutPromise, abortPromise] : [p, timeoutPromise]);
      } finally {
        if (signal && onAbort) {
          try {
            signal.removeEventListener('abort', onAbort);
          } catch (_) {}
        }
      }
      record.status = 'SUCCESS';
    } catch (e) {
      if (e && (e.name === 'CancelledError' || e.name === 'AbortError')) {
        record.error = { name: 'CancelledError', message: String((e && e.message) || 'cancelled'), stack: (e && e.stack) || null };
        record.status = 'CANCELLED';
      } else {
      let ce = null;
      try {
        ce = classify(e);
      } catch (e2) {
        record.status = 'CRASHED';
        record.error = { name: 'Error', message: String((e2 && e2.message) || e2), stack: (e2 && e2.stack) || null };
      }
      if (record.status !== 'CRASHED') {
        record.error = {
          name: ce.name,
          message: scrubSecrets(String(ce.message), secretNames),
          stack: ce.stack ? scrubSecrets(String(ce.stack), secretNames) : null,
        };
        record.status = ce instanceof TimeoutError ? 'TIMEOUT' : 'FAILED';
      }
      }
      // §41 #10: failure-only artifact capture; never throws, never delays SUCCESS.
      // ceiling: a hanging screenshot fn delays record settlement — worker taskTimeout still bounds the item.
      if (record.status === 'FAILED' || record.status === 'TIMEOUT') {
        await captureArtifact();
        // §16 forensics: DOM/HTML + network + URL ride alongside the screenshot.
        try {
          record.trace = await buildTrace({ browserApi, currentUrl: record.currentUrl });
        } catch (_) {}
      }
    } finally {
      if (timer) clearTimeout(timer);
      record.endTime = Date.now();
      record.durationMs = Math.max(1, record.endTime - record.startTime);
      if (typeof audit === 'function') {
        audit({
          type: 'script-exec',
          scriptId: record.scriptId,
          profileId: record.profileId,
          status: record.status,
          durationMs: record.durationMs,
        });
      }
    }
    return record;
  }

  return {
    run,
    cancel() {
      cancelled = true;
    },
    listErrors,
  };
}

module.exports = {
  createScriptRunner,
  buildTrace,
  listErrors,
  ScriptError,
  TimeoutError,
  CancelledError,
  SelectorError,
  BrowserError,
  NetworkError,
  PermissionError,
  ProfileError,
  DownloadError,
  UploadError,
};
