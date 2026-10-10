// ponytail: single localhost HTTP gateway over the Service Layer (architecture.md §7 + security.md §4/§9).
'use strict';

const http = require('http');
const crypto = require('crypto');
const { createTokenStore } = require('./token-store');

const MAX_BODY = 1024 * 1024; // 1MB
const CODE_STATUS = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LIMIT: 429,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
};

function isLoopbackHost(h) {
  return /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i.test(String(h || ''));
}

function hostHeaderOk(h) {
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(h || ''));
}

function isLoopbackOrigin(origin) {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

// constant-time compare on sha256 digests (lengths always equal after hash)
function tokenEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function bearerToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

function errMsg(message) {
  return { ok: false, error: { code: 'INTERNAL', message: String(message) } };
}

function serviceHttp(result, { created } = {}) {
  if (result && result.ok) return { status: created ? 201 : 200, payload: result };
  const code = (result && result.error && result.error.code) || 'INTERNAL';
  return { status: CODE_STATUS[code] || 500, payload: result || errMsg('empty service result') };
}

function parseListQuery(searchParams, keys) {
  const out = {};
  for (const k of keys) {
    if (!searchParams.has(k)) continue;
    const v = searchParams.get(k);
    out[k] = k === 'limit' || k === 'offset' ? Number(v) : v;
  }
  return out;
}

const PROFILE_STUB = {
  ok: false,
  error: { code: 'NOT_IMPLEMENTED', message: 'Profile Manager P8' },
};

// ---------------------------------------------------------------------------
// JWT claims kernel (HS256, hand-rolled — node:crypto only, no deps).
// Layered ON TOP of the token/readToken kernel: those two paths are checked
// first and are exempt from the permission table (single-tenant admin/viewer).
// Permission names are api.md §7's set.
// ---------------------------------------------------------------------------

const PERM = {
  SCRIPT_VIEW: 'Script.View',
  SCRIPT_CREATE: 'Script.Create',
  SCRIPT_EDIT: 'Script.Edit',
  SCRIPT_DELETE: 'Script.Delete',
  SCRIPT_RUN: 'Script.Run',
  SCRIPT_EXPORT: 'Script.Export',
  SCRIPT_IMPORT: 'Script.Import',
  TASK_VIEW: 'Task.View',
  TASK_CREATE: 'Task.Create',
  TASK_CANCEL: 'Task.Cancel',
  PROFILE_VIEW: 'Profile.View',
  PROFILE_RUN: 'Profile.Run',
  API: 'Automation.API',
  ADMIN: 'Automation.Admin',
};

const ALL_PERMS = Object.values(PERM);
const READ_ONLY_PERMS = [PERM.SCRIPT_VIEW, PERM.TASK_VIEW, PERM.PROFILE_VIEW, PERM.API];
// Developer/Operator run the tool but do not manage the automation surface itself.
const NO_ADMIN_PERMS = ALL_PERMS.filter((p) => p !== PERM.ADMIN);

// Rule (documented, single): `permissions[]` is authoritative when present and
// non-empty; `role` only supplies a default when the token carries no explicit
// permissions[]. So a Viewer with permissions:['Script.Create'] MAY write — the
// explicit grant wins — while a bare Viewer defaults to READ_ONLY_PERMS (GET-only).
// Unknown role + no permissions[] grants nothing (least privilege).
const ROLE_DEFAULTS = {
  Owner: ALL_PERMS,
  Admin: ALL_PERMS,
  Developer: NO_ADMIN_PERMS,
  Operator: NO_ADMIN_PERMS,
  Viewer: READ_ONLY_PERMS,
};

const b64uDecode = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Returns { ok:true, claims } or { ok:false, reason }. Reason is a short enum,
// never the token/signature (audit-safe).
// JWT clock tolerance (api.md §7): distributed issuers drift; exp/nbf compare
// against nowMs ± skewSec (default 60s). Rejects stay exact — only the boundary
// moves, and the reason enums are unchanged.
const JWT_SKEW_SEC = 60;
function verifyJwt(token, secret, nowMs, skewSec) {
  const skew = Number.isFinite(Number(skewSec)) && Number(skewSec) >= 0 ? Number(skewSec) : JWT_SKEW_SEC;
  const parts = String(token).split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(b64uDecode(h).toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad-header' };
  }
  try {
    payload = JSON.parse(b64uDecode(p).toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad-payload' };
  }
  if (!header || typeof header !== 'object' || header.alg !== 'HS256') return { ok: false, reason: 'bad-alg' };
  if (header.typ !== undefined && header.typ !== 'JWT') return { ok: false, reason: 'bad-typ' }; // typ optional-tolerated
  const expected = crypto.createHmac('sha256', secret).update(h + '.' + p).digest();
  const got = b64uDecode(s);
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'bad-payload' };
  const nowSec = Math.floor(nowMs / 1000);
  if (payload.exp !== undefined && !(Number(payload.exp) > nowSec - skew)) return { ok: false, reason: 'expired' };
  if (payload.nbf !== undefined && !(Number(payload.nbf) <= nowSec + skew)) return { ok: false, reason: 'not-yet-valid' };
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) return { ok: false, reason: 'no-sub' };
  return { ok: true, claims: payload };
}

// (method, path) -> required permission name, or null when no rule applies
// (null lets dispatch answer 404 for unknown shapes rather than lying 403).
function requiredPermission(method, pathname) {
  const seg = pathname.split('/').filter(Boolean);
  if (seg[0] !== 'api') return null;
  const [, root, id, action] = seg;
  const m = method;

  if (root === 'automation' && id === 'status' && !action) return m === 'GET' ? PERM.API : null;
  // token rotation mints a new bearer: admin-only (mirrors the trust route).
  if (root === 'automation' && id === 'token' && action === 'rotate' && m === 'POST') return PERM.ADMIN;

  if (root === 'scripts') {
    if (id === 'import' && !action && m === 'POST') return PERM.SCRIPT_IMPORT;
    if (!id) return m === 'GET' ? PERM.SCRIPT_VIEW : m === 'POST' ? PERM.SCRIPT_CREATE : null;
    if (!action) return m === 'GET' ? PERM.SCRIPT_VIEW : m === 'PUT' ? PERM.SCRIPT_EDIT : m === 'DELETE' ? PERM.SCRIPT_DELETE : null;
    if (action === 'run' && m === 'POST') return PERM.SCRIPT_RUN;
    if (action === 'versions' && m === 'POST') return PERM.SCRIPT_EDIT; // saving a version is an edit
    if (action === 'export' && m === 'GET') return PERM.SCRIPT_EXPORT;
    if ((action === 'trust' || action === 'untrust') && m === 'POST') return PERM.ADMIN; // trust gate: admin only
    return null;
  }
  if (root === 'executions') {
    if (m === 'GET') return PERM.SCRIPT_VIEW; // list / get / logs
    if ((action === 'cancel' || action === 'stop') && m === 'POST') return PERM.SCRIPT_RUN; // stopping is a run op
    return null;
  }
  if (root === 'tasks') {
    if (!id) return m === 'GET' ? PERM.TASK_VIEW : m === 'POST' ? PERM.TASK_CREATE : null;
    if (!action) return m === 'GET' ? PERM.TASK_VIEW : null;
    if (m === 'POST' && (action === 'cancel' || action === 'pause' || action === 'resume' || action === 'retry')) {
      return PERM.TASK_CANCEL;
    }
    return null;
  }
  if (root === 'schedules') return PERM.API; // whole automation surface, read or mutate
  if (root === 'templates') {
    if (!id && m === 'GET') return PERM.SCRIPT_VIEW;
    if (id === 'install' && !action && m === 'POST') return PERM.SCRIPT_CREATE; // install creates a script
    return null;
  }
  if (root === 'profiles') {
    if (!id) return m === 'GET' ? PERM.PROFILE_VIEW : m === 'POST' ? PERM.ADMIN : null;
    if (!action) {
      if (m === 'GET') return PERM.PROFILE_VIEW;
      return m === 'PUT' || m === 'DELETE' ? PERM.ADMIN : null; // managing profile entities is admin
    }
    if (m === 'GET' && (action === 'status' || action === 'cdp')) return PERM.PROFILE_VIEW;
    if (m === 'POST' && (action === 'start' || action === 'stop')) return PERM.PROFILE_RUN;
    if (m === 'POST' && action === 'fingerprint') return PERM.PROFILE_RUN; // broker: same gate as start/stop
    if (m === 'POST' && action === 'fingerprint-rotate') return PERM.PROFILE_RUN; // broker rotation: same gate
    return null;
  }
  if (root === 'metrics') return m === 'GET' ? PERM.API : null; // §35 read (viewer-readable)
  if (root === 'audit') return m === 'GET' ? PERM.API : null; // central audit query (viewer-readable)
  return null;
}

function authorizeJwt(claims, required) {
  if (!required) return { ok: true };
  const explicit = Array.isArray(claims.permissions) ? claims.permissions : null;
  const granted = explicit && explicit.length > 0 ? new Set(explicit) : new Set(ROLE_DEFAULTS[claims.role] || []);
  return granted.has(required) ? { ok: true } : { ok: false, required };
}

function createHttpApi({
  service,
  token,
  readToken, // optional viewer token: GET-only (RBAC kernel: admin token = full, viewer = read)
  jwtSecret, // optional HS256 secret: enables the JWT claims path (P9). Unset => old behavior exactly.
  creds: credsOpt, // optional token store (doc 17 Part C); a plain token string wraps into one
  graceMs, // rotation grace window for a wrapped store (default 60s / env-driven)
  port = 0,
  host = '127.0.0.1',
  now,
  audit,
  upgradeHandler, // optional (ws-api.js): server 'upgrade' listener for /api/ws
  rateLimit: { max = 60, windowMs = 60000 } = {},
} = {}) {
  if (!service) throw new Error('service required');
  const nowFn = typeof now === 'function' ? now : () => Date.now();
  // Rotation indirection: callers may pass a shared store (serve.js) or the legacy
  // token/readToken/jwtSecret strings, which wrap into a single-entry store.
  const creds =
    credsOpt && typeof credsOpt.verify === 'function'
      ? credsOpt
      : createTokenStore({ token, readToken, jwtSecret, graceMs, now: nowFn });
  if (!credsOpt && (token == null || token === '')) throw new Error('token required');
  const auditFn = typeof audit === 'function' ? audit : () => {};
  const buckets = new Map(); // sha256(token) -> { count, resetAt }

  function rateCheck(tok) {
    const key = crypto.createHash('sha256').update(tok).digest('hex');
    const t = nowFn();
    let b = buckets.get(key);
    if (!b || t >= b.resetAt) {
      b = { count: 0, resetAt: t + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > max) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - t) / 1000)) };
    }
    return { ok: true };
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          tooLarge = true;
          return; // keep draining, drop payload
        }
        chunks.push(c);
      });
      req.on('end', () => resolve({ tooLarge, raw: Buffer.concat(chunks).toString('utf8') }));
      req.on('error', () => resolve({ tooLarge, raw: '', readError: true }));
    });
  }

  async function dispatch(method, pathname, searchParams, body, ctx) {
    const seg = pathname.split('/').filter(Boolean); // ['api', ...]
    if (seg[0] !== 'api') return { status: 404, payload: { ok: false, error: { code: 'NOT_FOUND', message: 'no route: ' + pathname } } };
    const [, root, id, action] = seg;

    if (root === 'automation' && id === 'status' && !action && method === 'GET') {
      return serviceHttp(service.status());
    }

    // --- token rotation (doc 17 Part C): gated in handler() by an explicit
    // Automation.Admin JWT claim, so only authorized calls reach here. The new
    // token is generated when the body omits it and returned exactly once; the
    // audit records {type,by} and never the value.
    if (root === 'automation' && id === 'token' && action === 'rotate' && method === 'POST') {
      if (!creds || typeof creds.rotate !== 'function') {
        return { status: 501, payload: { ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'token store has no rotate()' } } };
      }
      const newToken = body && typeof body.newToken === 'string' && body.newToken ? body.newToken : crypto.randomBytes(16).toString('hex');
      const jwtNew = body && typeof body.jwtSecret === 'string' && body.jwtSecret ? body.jwtSecret : undefined;
      let rotated;
      try {
        rotated = creds.rotate(jwtNew !== undefined ? { token: newToken, jwtSecret: jwtNew } : { token: newToken });
      } catch (e) {
        return { status: 400, payload: { ok: false, error: { code: 'VALIDATION', message: String((e && e.message) || e) } } };
      }
      auditFn({ type: 'token-rotate', by: ctx && ctx.claims ? ctx.claims.sub : null });
      return { status: 200, payload: { ok: true, data: rotated } };
    }

    // --- scripts ---
    if (root === 'scripts') {
      if (!id) {
        if (method === 'GET') return serviceHttp(service.scripts.list());
        if (method === 'POST') return serviceHttp(service.scripts.create(body), { created: true });
      } else if (!action) {
        if (method === 'GET') return serviceHttp(service.scripts.get(id));
        if (method === 'PUT') return serviceHttp(service.scripts.update(id, body));
        if (method === 'DELETE') return serviceHttp(service.scripts.remove(id));
      } else if (action === 'run' && method === 'POST') {
        const { version, params, profileContext } = body || {};
        return serviceHttp(await service.run.runScript(id, { version, params, profileContext }));
      } else if (action === 'versions' && method === 'POST') {
        const { code, version } = body || {};
        return serviceHttp(service.scripts.saveVersion(id, code, version), { created: true });
      } else if (action === 'export' && method === 'GET') {
        return serviceHttp(service.scripts.exportOne(id));
      } else if (action === 'trust' && method === 'POST') {
        // viewer POST already denied in handler(); admin-bearer without JWT claim
        // denied in handler() via isTrustRoute — dispatch only routes authorized calls.
        return serviceHttp(service.scripts.trust(id, body));
      } else if (action === 'untrust' && method === 'POST') {
        return serviceHttp(service.scripts.untrust(id));
      }
    }
    if (root === 'scripts' && id === 'import' && !action && method === 'POST') {
      return serviceHttp(service.scripts.importOne(body), { created: true });
    }

    // --- executions ---
    if (root === 'executions') {
      if (!id) {
        if (method === 'GET') {
          return serviceHttp(service.run.listExecutions(parseListQuery(searchParams, ['scriptId', 'status', 'limit', 'offset'])));
        }
      } else if (!action) {
        if (method === 'GET') return serviceHttp(service.run.getExecution(id));
      } else if (action === 'logs' && method === 'GET') {
        return serviceHttp(service.run.getLogs(id));
      } else if ((action === 'cancel' || action === 'stop') && method === 'POST') {
        return serviceHttp(service.run.stop(id));
      }
    }

    // --- tasks ---
    if (root === 'tasks') {
      if (!id) {
        if (method === 'GET') return serviceHttp(service.tasks.listTasks(parseListQuery(searchParams, ['status', 'scriptId', 'limit', 'offset'])));
        if (method === 'POST') return serviceHttp(service.tasks.enqueue(body));
      } else if (!action) {
        if (method === 'GET') return serviceHttp(service.tasks.getTask(id));
      } else if (method === 'POST') {
        const map = { cancel: service.tasks.cancelTask, pause: service.tasks.pauseTask, resume: service.tasks.resumeTask, retry: service.tasks.retryTask };
        // body forwarded so pause accepts {interrupt:true} and retry accepts opts;
        // actions that take no opts ignore the extra argument.
        if (map[action]) return serviceHttp(map[action](id, body));
      }
    }

    // --- schedules ---
    if (root === 'schedules') {
      if (!id) {
        if (method === 'GET') return serviceHttp(service.schedules.listSchedules(parseListQuery(searchParams, ['enabled', 'limit', 'offset'])));
        if (method === 'POST') return serviceHttp(service.schedules.addSchedule(body));
      } else if (!action) {
        if (method === 'DELETE') return serviceHttp(service.schedules.removeSchedule(id));
      } else if (method === 'POST') {
        const map = { pause: service.schedules.pauseSchedule, resume: service.schedules.resumeSchedule, trigger: service.schedules.triggerSchedule };
        if (map[action]) return serviceHttp(map[action](id));
      }
    }

    // --- profiles: real routes (P8); 501 only when service has no profileManager ---
    if (root === 'profiles') {
      const P = service.profiles;
      const stub = () => ({ status: 501, payload: PROFILE_STUB });
      if (!id) {
        if (method === 'GET') {
          if (!P) return stub();
          return serviceHttp(P.list(parseListQuery(searchParams, ['groupId', 'status', 'limit', 'offset'])));
        }
        if (method === 'POST') {
          if (!P) return stub();
          return serviceHttp(P.create(body), { created: true });
        }
      } else if (!action) {
        if (!P) return stub();
        if (method === 'GET') return serviceHttp(P.get(id));
        if (method === 'PUT') return serviceHttp(P.update(id, body));
        if (method === 'DELETE') return serviceHttp(P.remove(id));
      } else if (!seg[4]) {
        if (!P) return stub();
        if (action === 'status' && method === 'GET') return serviceHttp(P.status(id));
        if ((action === 'start' || action === 'stop') && method === 'POST') {
          return serviceHttp(await P[action](id));
        }
        // §41 #25: publish the launcher-reported live endpoint for connectOverCDP.
        // No --remote-debugging-port per ADR-3; URL exists only while the profile runs.
        if (action === 'cdp' && method === 'GET') {
          const st = P.status(id);
          if (!st.ok) return serviceHttp(st);
          const ep = st.data && st.data.endpoint;
          if (!ep) {
            return { status: 404, payload: { ok: false, error: { code: 'NOT_FOUND', message: 'no live endpoint for profile: ' + id + ' (start it first)' } } };
          }
          return { status: 200, payload: { ok: true, data: { id, status: st.data.status, endpoint: ep } } };
        }
        // FingerprintBroker entry (architecture.md §4): POST /api/profiles/:id/fingerprint.
        // Body: { config, bearerToken? }. Bearer needed only when brokerToken configured
        // (serve.js FP_FINGERPRINT_TOKEN); without it any authenticated caller may update
        // stopped profiles — same posture as PUT /api/profiles/:id.
        if (action === 'fingerprint' && method === 'POST') {
          if (!P) return stub();
          if (typeof P.fingerprintUpdate !== 'function') {
            return { status: 501, payload: { ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'fingerprint broker not wired' } } };
          }
          return serviceHttp(await P.fingerprintUpdate(id, body));
        }
        // Broker rotation: stop → update → start in one call (live profiles).
        if (action === 'fingerprint-rotate' && method === 'POST') {
          if (!P) return stub();
          if (typeof P.fingerprintRotate !== 'function') {
            return { status: 501, payload: { ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'fingerprint broker rotate not wired' } } };
          }
          return serviceHttp(await P.fingerprintRotate(id, body));
        }
      }
    }

    // --- templates: catalog + idempotent install (P-templates) ---
    if (root === 'templates') {
      const T = service.templates;
      const stub = () => ({ status: 501, payload: PROFILE_STUB });
      if (!id && method === 'GET') {
        if (!T) return stub();
        return serviceHttp(T.list());
      }
      if (id === 'install' && !action && method === 'POST') {
        if (!T) return stub();
        return serviceHttp(T.install(body), { created: true });
      }
    }

    // --- audit: central collector query (database.md §12 shape; viewer-readable GET) ---
    if (root === 'audit' && !action && method === 'GET') {
      const A = service.audit;
      if (!A) return { status: 501, payload: { ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'audit log not wired' } } };
      if (!id) return serviceHttp(A.query(parseListQuery(searchParams, ['actor', 'action', 'entity', 'entity_id', 'type', 'since', 'until', 'limit', 'offset'])));
      if (id === 'stats') return serviceHttp(A.stats());
    }

    // --- metrics: §35 aggregate bundle (viewer-readable GET; ?scriptId= passthrough) ---
    if (root === 'metrics' && !id && !action && method === 'GET') {
      const M = service.metrics;
      if (!M) {
        return { status: 501, payload: { ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'metrics not wired' } } };
      }
      const scriptId = searchParams.get('scriptId') || undefined;
      const opts = scriptId ? { scriptId } : {};
      const head = M.summary(opts);
      if (!head.ok) return serviceHttp(head); // NOT_IMPLEMENTED -> 501 via CODE_STATUS
      const pick = (env) => (env && env.ok ? env.data : undefined);
      return {
        status: 200,
        payload: {
          ok: true,
          data: {
            summary: head.data,
            failureRate: pick(M.failureRate(opts)),
            crashRate: pick(M.crashRate(opts)),
            durationStats: pick(M.durationStats(opts)),
            topFailures: pick(M.topFailures('script', 5, opts)),
            hotSteps: pick(M.hotSteps(5, opts)),
            volume: pick(M.volume(opts)),
          },
        },
      };
    }

    return { status: 404, payload: { ok: false, error: { code: 'NOT_FOUND', message: 'no route: ' + method + ' ' + pathname } } };
  }

  async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method || 'GET';
    let status = 500;
    let payload = errMsg('unhandled');

    try {
      // 1) DNS-rebinding gate: Host must be loopback (security.md §4)
      if (!hostHeaderOk(req.headers.host)) {
        status = 403;
        payload = { ok: false, error: { code: 'FORBIDDEN', message: 'bad host header' } };
      } else if (method === 'OPTIONS') {
        // 2) CORS preflight: origin must parse to http loopback, reflect it exactly
        const origin = req.headers.origin;
        if (!origin || !isLoopbackOrigin(origin)) {
          status = 403;
          payload = { ok: false, error: { code: 'FORBIDDEN', message: 'bad origin' } };
        } else {
          status = 204;
          payload = null;
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
          res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
        }
      } else {
        // 3) Bearer, in order: admin token -> viewer token -> JWT claims (api.md §7).
        //    The first two are exempt from the permission table; only JWTs get route-level checks.
        //    Exception: /scripts/:id/trust|untrust require Automation.Admin even for the
        //    admin token — bearer possession alone is not enough to mint trust.
        const got = bearerToken(req);
        const role = got ? creds.verify(got).role : null;
        const isAdmin = role === 'admin';
        const isViewer = role === 'viewer';
        const jwtSecrets = typeof creds.jwtSecrets === 'function' ? creds.jwtSecrets() : jwtSecret != null && jwtSecret !== '' ? [jwtSecret] : [];
        const jwtOn = jwtSecrets.length > 0;
        const isTrustRoute =
          method === 'POST' &&
          (() => {
            const seg = pathname.split('/').filter(Boolean);
            return seg[0] === 'api' && seg[1] === 'scripts' && seg[2] && (seg[3] === 'trust' || seg[3] === 'untrust') && !seg[4];
          })();
        // Token rotation mints a bearer, so — like trust — it requires an explicit
        // Automation.Admin JWT claim; the admin bearer token alone is not enough.
        const isRotateRoute =
          method === 'POST' &&
          (() => {
            const seg = pathname.split('/').filter(Boolean);
            return seg[0] === 'api' && seg[1] === 'automation' && seg[2] === 'token' && seg[3] === 'rotate' && !seg[4];
          })();
        let claims = null;
        if (!isAdmin && !isViewer && jwtOn && got) {
          // Try every active secret (current first, then previous inside grace) so a
          // jwtSecret rotation does not reject tokens signed with the old secret.
          let reason = 'bad-signature';
          for (const secret of jwtSecrets) {
            const v = verifyJwt(got, secret, nowFn());
            if (v.ok) {
              claims = v.claims;
              break;
            }
            reason = v.reason;
          }
          if (!claims) auditFn({ type: 'auth-jwt', ok: false, reason }); // never the token
        }

        let deny = null;
        if (!isAdmin && !isViewer && !claims) {
          // covers: no token, wrong token, and (when jwtSecret unset) any JWT-looking token
          deny = { status: 401, payload: { ok: false, error: { code: 'UNAUTHORIZED', message: 'missing or bad bearer token' } } };
        } else if ((isTrustRoute || isRotateRoute) && !claims) {
          // trust minting / token rotation need an explicit Automation.Admin JWT
          // claim — even the admin bearer token is not sufficient (possession != admin intent).
          deny = { status: 403, payload: { ok: false, error: { code: 'FORBIDDEN', message: 'missing permission: Automation.Admin' } } };
        } else if (isViewer && method !== 'GET') {
          deny = { status: 403, payload: { ok: false, error: { code: 'FORBIDDEN', message: 'read-only token: GET only' } } };
        } else if (claims) {
          const required = requiredPermission(method, pathname);
          const az = authorizeJwt(claims, required);
          if (!az.ok) {
            deny = {
              status: 403,
              payload: { ok: false, error: { code: 'FORBIDDEN', message: 'missing permission: ' + az.required } },
            };
            auditFn({ type: 'auth-jwt', sub: claims.sub, ok: false, reason: 'forbidden:' + az.required });
          } else {
            auditFn({ type: 'auth-jwt', sub: claims.sub, ok: true });
          }
        }

        if (deny) {
          status = deny.status;
          payload = deny.payload;
        } else {
          // 4) fixed-window rate limit per token
          const r = rateCheck(got);
          if (!r.ok) {
            status = 429;
            payload = { ok: false, error: { code: 'RATE_LIMITED', message: 'rate limit exceeded' } };
            res.setHeader('Retry-After', String(r.retryAfter));
            auditFn({ type: 'rate-limit', method, path: pathname, status: 429 });
          } else {
            let body;
            let bodyFailed = false;
            if (method === 'POST' || method === 'PUT') {
              const read = await readBody(req);
              if (read.readError) {
                bodyFailed = true;
                status = 400;
                payload = { ok: false, error: { code: 'VALIDATION', message: 'body read error' } };
              } else if (read.tooLarge) {
                bodyFailed = true;
                status = 413;
                payload = { ok: false, error: { code: 'LIMIT', message: 'body exceeds 1MB' } };
              } else if (read.raw.length > 0) {
                try {
                  body = JSON.parse(read.raw);
                } catch {
                  bodyFailed = true;
                  status = 400;
                  payload = { ok: false, error: { code: 'VALIDATION', message: 'malformed JSON body' } };
                }
              }
            }
            if (!bodyFailed) {
              const routed = await dispatch(method, pathname, url.searchParams, body, { claims });
              status = routed.status;
              payload = routed.payload;
            }
          }
        }
      }
    } catch (e) {
      status = 500;
      payload = errMsg((e && e.message) || e);
      if (typeof auditFn === 'function') auditFn({ type: 'api-error', method, path: pathname, status: 500 });
    }

    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (status === 204) {
      res.writeHead(204, headers);
      res.end();
    } else {
      const text = JSON.stringify(payload === null ? {} : payload);
      res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    }
    // 5) audit every request — method/path/status only, never token or body (security.md §9)
    auditFn({ type: 'api', method, path: pathname, status });
  }

  async function start() {
    if (!isLoopbackHost(host)) throw new Error('refusing non-loopback host: ' + host);
    const server = http.createServer((req, res) => {
      handler(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(errMsg('handler crash')));
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    if (typeof upgradeHandler === 'function') server.on('upgrade', upgradeHandler);
    return {
      port: addr.port,
      close: () =>
        new Promise((resolve) => {
          server.closeAllConnections && server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  return { start, handler };
}

module.exports = { createHttpApi };
