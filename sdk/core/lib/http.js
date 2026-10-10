'use strict';
// HTTP transport: thin loopback REST client built on node:http (no undici/fetch
// — a per-request agent keeps zero keep-alive sockets alive, so the process can
// exit deterministically). `Authorization: Bearer <token>`, envelope
// { ok:true, data } | { ok:false, error:{code,message} }. No browser logic.
const http = require('http');
const { URL } = require('url');
const { HttpError, mapError } = require('./errors');

class HttpTransport {
  constructor({ baseUrl, token } = {}) {
    if (!baseUrl) throw new HttpError('baseUrl required', 'CONFIG');
    if (!token) throw new HttpError('token required', 'CONFIG');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.token = token;
  }

  request(method, path, body) {
    return new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(this.baseUrl + path);
      } catch (e) {
        reject(new HttpError('bad url: ' + this.baseUrl + path, 'CONFIG'));
        return;
      }
      const headers = { Authorization: 'Bearer ' + this.token };
      let payload;
      if (body !== undefined) {
        payload = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port || 80,
          path: u.pathname + u.search,
          method,
          headers,
          agent: false, // no keep-alive: nothing lingers on the event loop
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(data);
            } catch (_) {}
            if (!json) {
              reject(new HttpError('empty/invalid response (HTTP ' + res.statusCode + ')', 'HTTP_' + res.statusCode, res.statusCode));
              return;
            }
            if (json.ok !== true) {
              const err = json.error || { code: 'HTTP_' + res.statusCode, message: res.statusMessage };
              reject(mapError(err.code, err.message, res.statusCode));
              return;
            }
            resolve(json); // { ok:true, data, created? }
          });
        }
      );
      req.on('error', (e) => reject(new HttpError('request failed: ' + ((e && e.message) || e), 'NETWORK')));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  get(path) {
    return this.request('GET', path);
  }
  post(path, body) {
    return this.request('POST', path, body);
  }
  put(path, body) {
    return this.request('PUT', path, body);
  }
  del(path) {
    return this.request('DELETE', path);
  }
}

module.exports = { HttpTransport };
