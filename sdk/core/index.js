'use strict';
// @fp-automation/core — thin loopback client for the electron-fp automation
// runtime. Layering: transport (HTTP + WS) -> Client (namespaces) -> capability
// handshake. Zero browser logic: every call becomes one loopback request.
//
//   const { connect } = require('@fp-automation/core');
//   const client = await connect({ url: 'http://127.0.0.1:PORT', token });
//   await client.status();
//   await client.scripts.list();
//   await client.close();
const { HttpTransport } = require('./lib/http');
const { WsTransport } = require('./lib/ws');
const errors = require('./lib/errors');

const SDK_VERSION = '0.1.0';

// Derive the capability set from the runtime's /api/automation/status envelope.
// "Handshake" = fetch status once, expose what the runtime actually has wired,
// and (optionally) assert a required subset before the caller does real work.
function deriveCapabilities(statusEnvelope) {
  const c = (statusEnvelope && statusEnvelope.data && statusEnvelope.data.components) || {};
  return {
    store: !!c.store,
    queue: c.queueDepth !== undefined,
    scheduler: c.schedules != null,
    profiles: !!c.profiles,
  };
}

function enc(id) {
  return encodeURIComponent(id);
}

class Client {
  constructor({ http, ws }) {
    this.http = http;
    this.ws = ws;
    this.capabilities = null;
    this.version = SDK_VERSION;
  }

  async handshake({ required = [] } = {}) {
    const st = await this.http.get('/api/automation/status');
    this.capabilities = deriveCapabilities(st);
    const missing = required.filter((k) => !this.capabilities[k]);
    if (missing.length) throw new errors.CapabilityError('missing capabilities: ' + missing.join(', '));
    return this.capabilities;
  }

  async status() {
    return (await this.http.get('/api/automation/status')).data;
  }

  get scripts() {
    const h = this.http;
    return {
      list: async () => (await h.get('/api/scripts')).data,
      get: async (id) => (await h.get('/api/scripts/' + enc(id))).data,
      create: async (meta) => (await h.post('/api/scripts', meta)).data,
      update: async (id, patch) => (await h.put('/api/scripts/' + enc(id), patch)).data,
      remove: async (id) => (await h.del('/api/scripts/' + enc(id))).data,
      run: async (id, opts) => (await h.post('/api/scripts/' + enc(id) + '/run', opts || {})).data,
      saveVersion: async (id, code, version) =>
        (await h.post('/api/scripts/' + enc(id) + '/versions', { code, version })).data,
      exportOne: async (id) => (await h.get('/api/scripts/' + enc(id) + '/export')).data,
      importOne: async (doc) => (await h.post('/api/scripts/import', doc)).data,
    };
  }

  get executions() {
    const h = this.http;
    return {
      list: async (q) => (await h.get('/api/executions' + query(q))).data,
      get: async (id) => (await h.get('/api/executions/' + enc(id))).data,
      logs: async (id) => (await h.get('/api/executions/' + enc(id) + '/logs')).data,
      cancel: async (id) => (await h.post('/api/executions/' + enc(id) + '/cancel', {})).data,
    };
  }

  get tasks() {
    const h = this.http;
    return {
      list: async (q) => (await h.get('/api/tasks' + query(q))).data,
      get: async (id) => (await h.get('/api/tasks/' + enc(id))).data,
      enqueue: async (body) => (await h.post('/api/tasks', body)).data,
      pause: async (id, interrupt) => (await h.post('/api/tasks/' + enc(id) + '/pause', { interrupt })).data,
      resume: async (id) => (await h.post('/api/tasks/' + enc(id) + '/resume', {})).data,
      cancel: async (id) => (await h.post('/api/tasks/' + enc(id) + '/cancel', {})).data,
    };
  }

  get schedules() {
    const h = this.http;
    return {
      list: async (q) => (await h.get('/api/schedules' + query(q))).data,
      add: async (body) => (await h.post('/api/schedules', body)).data,
      remove: async (id) => (await h.del('/api/schedules/' + enc(id))).data,
      pause: async (id) => (await h.post('/api/schedules/' + enc(id) + '/pause', {})).data,
      resume: async (id) => (await h.post('/api/schedules/' + enc(id) + '/resume', {})).data,
      trigger: async (id) => (await h.post('/api/schedules/' + enc(id) + '/trigger', {})).data,
    };
  }

  get profiles() {
    const h = this.http;
    return {
      list: async (q) => (await h.get('/api/profiles' + query(q))).data,
      get: async (id) => (await h.get('/api/profiles/' + enc(id))).data,
      status: async (id) => (await h.get('/api/profiles/' + enc(id) + '/status')).data,
      start: async (id) => (await h.post('/api/profiles/' + enc(id) + '/start', {})).data,
      stop: async (id) => (await h.post('/api/profiles/' + enc(id) + '/stop', {})).data,
    };
  }

  // WS: server-pushed execution events + read/write RPC methods.
  on(event, fn) {
    return this.ws.on(event, fn);
  }
  call(method, params) {
    return this.ws.call(method, params);
  }
  subscribe(executionId) {
    return this.ws.subscribe(executionId);
  }

  async close() {
    await this.ws.close();
  }
}

function query(q) {
  if (!q) return '';
  const parts = [];
  for (const k of Object.keys(q)) {
    if (q[k] === undefined || q[k] === null) continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(q[k]));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

async function connect({ url, token, wsUrl, required } = {}) {
  const http = new HttpTransport({ baseUrl: url, token });
  const resolvedWs =
    wsUrl || String(url).replace(/^http/, 'ws') + '/api/ws?token=' + encodeURIComponent(token);
  const ws = new WsTransport({ url: resolvedWs, token });
  const client = new Client({ http, ws });
  await client.handshake({ required });
  return client;
}

module.exports = { connect, Client, errors, SDK_VERSION, HttpTransport, WsTransport, deriveCapabilities };
