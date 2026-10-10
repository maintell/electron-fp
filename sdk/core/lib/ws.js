'use strict';
// WS transport: dependency-free push/RPC over the runtime's WS API, using the
// built-in global WebSocket (Node >= 21). Token travels in ?token= (browsers
// cannot set Authorization on a WS handshake — same convention as ws-api.js).
// Client sends {id, method, params}; server replies {id, ok, data|error}; server
// pushes events as { event, ... }.
const { WsError } = require('./errors');

class WsTransport {
  constructor({ url, token } = {}) {
    if (!url) throw new WsError('url required');
    this.url = url;
    this.token = token || null;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.connected = false;
  }

  connect() {
    if (this.connected) return Promise.resolve();
    if (typeof WebSocket !== 'function') {
      return Promise.reject(new WsError('global WebSocket unavailable (need Node >= 21)'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => {
        settled = true;
        this.connected = true;
        resolve();
      });
      ws.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          reject(new WsError('ws connect failed: ' + this.url));
        }
      });
      ws.addEventListener('close', () => {
        this.connected = false;
        for (const p of this.pending.values()) {
          try {
            p.rej(new WsError('ws closed'));
          } catch (_) {}
        }
        this.pending.clear();
      });
      ws.addEventListener('message', (ev) => this._onMessage(ev));
    });
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch (_) {
      return;
    }
    if (!msg) return;
    if (msg.event) {
      const fire = (list) => {
        for (const fn of list) {
          try {
            fn(msg);
          } catch (_) {}
        }
      };
      if (this.handlers.has(msg.event)) fire(this.handlers.get(msg.event));
      if (this.handlers.has('*')) fire(this.handlers.get('*'));
      return;
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.res(msg.data);
      else p.rej(new WsError((msg.error && msg.error.message) || 'ws call failed', msg.error && msg.error.code));
    }
  }

  call(method, params) {
    return this.connect().then(
      () =>
        new Promise((res, rej) => {
          const id = ++this.seq;
          this.pending.set(id, { res, rej });
          try {
            this.ws.send(JSON.stringify({ id, method, params: params || {} }));
          } catch (e) {
            this.pending.delete(id);
            rej(new WsError(String((e && e.message) || e)));
          }
        })
    );
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
    return () => {
      const a = this.handlers.get(event);
      if (!a) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    };
  }

  subscribe(executionId) {
    return this.call('subscribe', { executionId });
  }
  unsubscribe(executionId) {
    return this.call('unsubscribe', { executionId });
  }

  close() {
    if (!this.ws) return Promise.resolve();
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    // Await the actual close so the WebSocket handle is fully released before
    // the caller (and the process) tears down — avoids a libuv teardown race.
    return new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        ws.addEventListener('close', fin);
      } catch (_) {}
      try {
        ws.close();
      } catch (_) {}
      setTimeout(fin, 800);
    });
  }
}

module.exports = { WsTransport };
