// ponytail: argv parser ~30 lines, no commander; same Service façade as HTTP — zero duplicated business rules.
'use strict';

const fs = require('fs');

const USAGE = [
  'Usage: browser <group> <action> [args] [--flags]',
  '',
  '  script list',
  '  script get <id>',
  '  script run <id> [--param k=v]... [--version v] [--profile id]',
  '  script stop <executionId>',
  '  script export <id>',
  '  script import <file>',
  '  script trust <id> --signature <hex> [--actor name]   (admin-only trust gate)',
  '  script untrust <id>   (revoke trust)',
  '  task list [--status s]',
  '  task run <scriptId> [--param k=v]... [--version v] [--profile id]',
  '  task cancel <id>',
  '  task retry <id>',
  '  profile list | profile start <id> | profile stop <id>   (NOT_IMPLEMENTED exit 2 when unwired)',
  '  profile fingerprint <id> --config \'{...}\' [--bearer tok]   (stopped-profile broker update)',
  '  profile rotate <id> --config \'{...}\' [--bearer tok]   (live stop->update->start)',
  '  metrics [--json]   (§35 aggregates; NOT_IMPLEMENTED exit 2 when unwired)',
  '  status',
  '',
  'Global flags: --json  --help',
  'Exit: 0 ok, 1 error/failed run, 2 usage or VALIDATION, 3 NOT_FOUND',
].join('\n');

const VALUE_FLAGS = new Set(['param', 'version', 'profile', 'status', 'signature', 'actor', 'config', 'bearer']);
const BOOL_FLAGS = new Set(['json', 'help']);
const ARITY = {
  'script list': 0, 'script get': 1, 'script run': 1, 'script stop': 1,
  'script export': 1, 'script import': 1,
  'script trust': 1, 'script untrust': 1,
  'task list': 0, 'task run': 1, 'task cancel': 1, 'task retry': 1,
  'profile list': 0, 'profile start': 1, 'profile stop': 1,
  'profile fingerprint': 1, 'profile rotate': 1,
  metrics: 0,
  status: 0,
};

function parseArgs(argv) {
  const positionals = [];
  const flags = { params: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? null : body.slice(eq + 1);
    if (BOOL_FLAGS.has(key)) {
      if (inline !== null) return { error: 'flag --' + key + ' takes no value' };
      flags[key] = true;
    } else if (VALUE_FLAGS.has(key)) {
      let v = inline;
      if (v === null) {
        v = argv[i + 1];
        i++;
      }
      if (v === undefined || v === null || String(v).startsWith('--')) {
        return { error: 'flag --' + key + ' requires a value' };
      }
      if (key === 'param') {
        const p = String(v).indexOf('=');
        if (p <= 0) return { error: '--param expects k=v, got: ' + v };
        flags.params.push([String(v).slice(0, p), String(v).slice(p + 1)]);
      } else {
        flags[key] = v;
      }
    } else {
      return { error: 'unknown flag: ' + a };
    }
  }
  return { positionals, flags };
}

function table(out, cols, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const cells = list.map((r) =>
    cols.map((c) => {
      if (c === 'latestVersion') {
        const v =
          r.latestVersion !== undefined
            ? r.latestVersion
            : r.versions && r.versions[0] && r.versions[0].version;
        return v == null ? '' : String(v);
      }
      return r[c] == null ? '' : String(r[c]);
    })
  );
  const w = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i].length)));
  out(cols.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd());
  for (const row of cells) out(row.map((v, i) => v.padEnd(w[i])).join('  ').trimEnd());
}

async function runCli(argv, service, { out = console.log, err = console.error } = {}) {
  try {
    const parsed = parseArgs(argv || []);
    if (parsed.error) {
      err('error: USAGE ' + parsed.error);
      err(USAGE);
      return 2;
    }
    const { positionals, flags } = parsed;
    if (flags.help || positionals.length === 0) {
      out(USAGE);
      return 0;
    }
    const group = positionals[0];
    const action = positionals[1];
    const args = positionals.slice(2);
    const cmd = action === undefined ? group : group + ' ' + action;
    if (!Object.prototype.hasOwnProperty.call(ARITY, cmd)) {
      err('error: USAGE unknown command: ' + cmd);
      err(USAGE);
      return 2;
    }
    if (args.length !== ARITY[cmd]) {
      err('error: USAGE ' + cmd + ' expects ' + ARITY[cmd] + ' arg(s), got ' + args.length);
      err(USAGE);
      return 2;
    }

    const serviceError = (res) => {
      const e = (res && res.error) || {};
      const code = typeof e === 'string' ? 'ERROR' : e.code || 'ERROR';
      const msg = typeof e === 'string' ? e : e.message || 'request failed';
      err('error: ' + code + ' ' + msg);
      // cli.md §3: NOT_FOUND→3, VALIDATION→2 (caller input), else→1
      return code === 'NOT_FOUND' ? 3 : code === 'VALIDATION' ? 2 : 1;
    };
    const emit = (data, human) => {
      if (flags.json) out(JSON.stringify(data));
      else human(data);
    };
    const pretty = (d) => out(JSON.stringify(d, null, 2));

    switch (cmd) {
      case 'script list': {
        const res = await service.listScripts();
        if (!res.ok) return serviceError(res);
        emit(res.data, (d) => table(out, ['id', 'name', 'latestVersion', 'updatedAt'], d));
        return 0;
      }
      case 'script get': {
        const res = await service.getScript(args[0]);
        if (!res.ok) return serviceError(res);
        emit(res.data, pretty);
        return 0;
      }
      case 'script run': {
        const opts = {};
        if (flags.params.length) opts.params = Object.fromEntries(flags.params);
        if (flags.version !== undefined) opts.version = flags.version;
        if (flags.profile !== undefined) opts.profile = flags.profile;
        const res = await service.runScript(args[0], opts);
        if (!res.ok) return serviceError(res);
        const data = res.data || {};
        emit(data, (d) => {
          out('executionId: ' + d.executionId);
          out('status: ' + d.status);
        });
        return data.status === 'SUCCESS' ? 0 : 1;
      }
      case 'script stop': {
        const res = await service.cancel(args[0]);
        if (!res.ok) return serviceError(res);
        emit(res.data, () => out('cancelled ' + args[0]));
        return 0;
      }
      case 'script export': {
        const res = await service.exportScript(args[0]);
        if (!res.ok) return serviceError(res);
        emit(res.data, pretty);
        return 0;
      }
      case 'script import': {
        let payload;
        try {
          payload = JSON.parse(fs.readFileSync(args[0], 'utf8'));
        } catch (e) {
          err('error: IMPORT ' + ((e && e.message) || e));
          return 1;
        }
        const res = await service.importScript(payload);
        if (!res.ok) return serviceError(res);
        emit(res.data, pretty);
        return 0;
      }
      case 'script trust': {
        // admin-only trust gate (script-sandbox.md §7): CLI runs in the host
        // trust domain (cli.md §4), so it may call trust() directly; the HTTP
        // path additionally requires an Automation.Admin JWT claim.
        if (flags.signature === undefined) {
          err('error: USAGE script trust requires --signature <hex> (sha256 of latest code + trust secret)');
          err(USAGE);
          return 2;
        }
        const res = await service.trustScript(args[0], { signature: flags.signature, actor: flags.actor });
        if (!res.ok) return serviceError(res);
        emit(res.data, pretty);
        return 0;
      }
      case 'script untrust': {
        const res = await service.untrustScript(args[0]);
        if (!res.ok) return serviceError(res);
        emit(res.data, pretty);
        return 0;
      }
      case 'task list': {
        const res = await service.listTasks(
          flags.status !== undefined ? { status: flags.status } : {}
        );
        if (!res.ok) return serviceError(res);
        // paged shape {total,rows} (api.md §5); legacy arrays still render.
        const page = res.data && Array.isArray(res.data.rows) ? res.data : { total: (res.data || []).length, rows: res.data };
        emit(page, (d) => {
          table(out, ['id', 'scriptId', 'status', 'attempts'], d.rows);
          if (!flags.json) out('total: ' + d.total);
        });
        return 0;
      }
      case 'task run': {
        const spec = { scriptId: args[0] };
        if (flags.params.length) spec.params = Object.fromEntries(flags.params);
        if (flags.version !== undefined) spec.version = flags.version;
        if (flags.profile !== undefined) spec.profileContext = { id: flags.profile };
        const res = await service.enqueueTask(spec);
        if (!res.ok) return serviceError(res);
        const d = res.data || {};
        emit(d, (x) => {
          out('taskId: ' + x.id);
          out('status: ' + x.status);
        });
        return 0;
      }
      case 'task cancel': {
        const res = await service.cancelTask(args[0]);
        if (!res.ok) return serviceError(res);
        emit(res.data, () => out('cancelled ' + args[0]));
        return 0;
      }
      case 'task retry': {
        const res = await service.retryTask(args[0]);
        if (!res.ok) return serviceError(res);
        emit(res.data, () => out('retried ' + args[0]));
        return 0;
      }
      case 'profile list': {
        const g = service && service.profiles;
        if (!g || typeof g.list !== 'function') {
          err('error: NOT_IMPLEMENTED profile list — no profileManager wired');
          return 2;
        }
        const res = await g.list({});
        if (!res.ok) {
          if (res.error && res.error.code === 'NOT_IMPLEMENTED') {
            err('error: NOT_IMPLEMENTED ' + (res.error.message || 'profile list'));
            return 2;
          }
          return serviceError(res);
        }
        emit(res.data, (d) => table(out, ['id', 'name', 'status', 'partition'], d));
        return 0;
      }
      case 'profile fingerprint': {
        // FingerprintBroker entry (architecture.md §4): stopped-profile update.
        // Live profiles: use `profile rotate` (stop → update → start one call).
        const g = service && service.profiles;
        if (!g || typeof g.fingerprintUpdate !== 'function') {
          err('error: NOT_IMPLEMENTED profile fingerprint — no profileManager wired');
          return 2;
        }
        let config;
        try {
          config = JSON.parse(flags.config);
        } catch {
          err('error: USAGE --config must be JSON (fingerprint planes object)');
          err(USAGE);
          return 2;
        }
        const res = await g.fingerprintUpdate(args[0], { config, bearerToken: flags.bearer });
        if (!res.ok) return serviceError(res);
        emit(res.data, pretty);
        return 0;
      }
      case 'profile rotate': {
        const g = service && service.profiles;
        if (!g || typeof g.fingerprintRotate !== 'function') {
          err('error: NOT_IMPLEMENTED profile rotate — no profileManager wired');
          return 2;
        }
        let config;
        try {
          config = JSON.parse(flags.config);
        } catch {
          err('error: USAGE --config must be JSON (fingerprint planes object)');
          err(USAGE);
          return 2;
        }
        const res = await g.fingerprintRotate(args[0], { config, bearerToken: flags.bearer });
        if (!res.ok) return serviceError(res);
        emit(res.data, pretty);
        return 0;
      }
      case 'profile start':
      case 'profile stop': {
        const verb = action; // 'start' | 'stop'
        const g = service && service.profiles;
        if (!g || typeof g[verb] !== 'function') {
          err('error: NOT_IMPLEMENTED profile ' + verb + ' — no profileManager wired');
          return 2;
        }
        const res = await g[verb](args[0]);
        if (!res.ok) {
          if (res.error && res.error.code === 'NOT_IMPLEMENTED') {
            err('error: NOT_IMPLEMENTED ' + (res.error.message || ('profile ' + verb)));
            return 2;
          }
          return serviceError(res);
        }
        emit(res.data, pretty);
        return 0;
      }
      case 'metrics': {
        const g = service && service.metrics;
        if (!g || typeof g.summary !== 'function') {
          err('error: NOT_IMPLEMENTED metrics — not wired');
          return 2;
        }
        const dataOf = (env) => (env && env.ok ? env.data : null);
        const head = g.summary({});
        if (!head.ok) {
          if (head.error && head.error.code === 'NOT_IMPLEMENTED') {
            err('error: NOT_IMPLEMENTED ' + (head.error.message || 'metrics'));
            return 2;
          }
          return serviceError(head);
        }
        const bundle = {
          summary: head.data,
          failureRate: dataOf(g.failureRate({})),
          crashRate: dataOf(g.crashRate({})),
          durationStats: dataOf(g.durationStats({})),
          topScripts: dataOf(g.topFailures('script', 5, {})),
          topProfiles: dataOf(g.topFailures('profile', 5, {})),
          topSites: dataOf(g.topFailures('site', 5, {})),
          hotSteps: dataOf(g.hotSteps(5, {})),
          volume: dataOf(g.volume({ lastMs: 86400000, bucketsMs: 3600000 })),
        };
        if (flags.json) {
          out(JSON.stringify({ ok: true, data: bundle }));
          return 0;
        }
        out('total: ' + bundle.summary.total + '  running: ' + bundle.summary.running + '  statuses: ' + JSON.stringify(bundle.summary.byStatus));
        const fr = bundle.failureRate || { failures: 0, total: 0, rate: 0 };
        out('failureRate: ' + (fr.rate * 100).toFixed(1) + '% (' + fr.failures + '/' + fr.total + ')');
        out('crashRate: ' + ((bundle.crashRate || 0) * 100).toFixed(1) + '%');
        const ds = bundle.durationStats || { count: 0, avgMs: 0, p95Ms: 0 };
        out('duration: count=' + ds.count + ' avg=' + Math.round(ds.avgMs) + 'ms p95=' + ds.p95Ms + 'ms');
        for (const row of bundle.topScripts || []) out('top script: ' + row.key + ' ' + row.failures + '/' + row.total);
        for (const row of bundle.topProfiles || []) out('top profile: ' + row.key + ' ' + row.failures + '/' + row.total);
        for (const row of bundle.topSites || []) out('top site: ' + row.key + ' ' + row.failures + '/' + row.total);
        for (const h of bundle.hotSteps || []) out('hot step: ' + h.step + ' x' + h.count);
        const buckets = (bundle.volume && bundle.volume.buckets) || [];
        let started = 0;
        for (const b of buckets) started += b.started;
        out('24h volume: ' + started + ' started in ' + buckets.length + ' bucket(s)');
        return 0;
      }
      case 'status': {
        const res = await service.status();
        if (!res.ok) return serviceError(res);
        emit(res.data, pretty);
        return 0;
      }
      default:
        err('error: USAGE unhandled command: ' + cmd);
        return 2;
    }
  } catch (e) {
    err('error: INTERNAL ' + ((e && e.message) || e));
    return 1;
  }
}

module.exports = { runCli };
