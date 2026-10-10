// ponytail: SDK facade over the injected page driver — 1:1 method mapping, no logic of its own.
// Conditional pass-throughs (key present only when the driver really exposes the primitive —
// buildTrace/scripts guard on typeof): page.evaluate, page.getCurrentUrl, network.enable.
// Driver page.js exposes enableNetwork/recentRequests among those, but has NO evaluate/
// getCurrentUrl; those two therefore stay absent until page.js exports them (trace.html/url gap).
// Deliberate omissions (page.js exposes no such primitive; printed as SKIP in test-browser-api.js):
//   browser.back/forward/reload/close/getTitle/getCurrentUrl
//   page.locator/waitForVisible/waitForHidden/waitForNavigation/waitForNetworkIdle/waitForResponse/waitForRequest
'use strict';

const path = require('path');

class PermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermissionError';
    this.code = 'PERMISSION';
    this.retriable = false;
  }
}

function createBrowserApi({ page, adapter, electronSession, profileContext, fences } = {}) {
  if (!page) throw new Error('page driver required');
  void adapter; // driver already binds the adapter; kept for SDK-signature symmetry

  // Upload/download fence (script-sandbox.md §2 upload=fence, script-sdk.md §2.6):
  // file paths must stay inside an authorized directory. Fences come from the
  // host (executor per-profile dir); absent fences = deny (fail-closed).
  // checkPath(p): throws PermissionError on escape, returns normalized path.
  function checkPath(p) {
    const raw = String(p === undefined || p === null ? '' : p);
    if (!raw) throw new PermissionError('path required');
    if (/\0/.test(raw)) throw new PermissionError('path contains null byte');
    const roots = fences && Array.isArray(fences.dirs) ? fences.dirs.map((r) => path.normalize(String(r))) : [];
    if (!roots.length) throw new PermissionError('no authorized directory configured (fence)');
    const norm = path.normalize(raw);
    const abs = path.isAbsolute(norm) ? norm : path.join(roots[0], norm);
    const inside = roots.some((rr) => abs === rr || abs.startsWith(rr + path.sep));
    if (!inside) throw new PermissionError('path outside authorized directory: ' + raw);
    return abs;
  }

  const cookies = {
    get: (filter) => (electronSession ? electronSession.cookies.get(filter || {}) : page.cookies.get(filter)),
    set: (c) => (electronSession ? electronSession.cookies.set(c) : page.cookies.set(c)),
    remove: (url, name) => (electronSession ? electronSession.cookies.remove(url, name) : page.cookies.remove(url, name)),
    clear: () => {
      if (!electronSession || typeof electronSession.clearStorageData !== 'function') {
        throw new Error('cookies.clear requires electronSession');
      }
      return electronSession.clearStorageData({ storages: ['cookies'] });
    },
  };

  const pageApi = {
    click: (...a) => page.click(...a),
    fill: (...a) => page.fill(...a),
    type: (...a) => page.type(...a),
    press: (...a) => page.press(...a),
    waitForSelector: (...a) => page.waitForSelector(...a),
    waitForText: (...a) => page.waitForText(...a),
    waitForURL: (...a) => page.waitForURL(...a),
    waitForFunction: (...a) => page.waitForFunction(...a),
    getText: (...a) => page.getText(...a),
    getAttribute: (...a) => page.getAttribute(...a),
    getValue: (...a) => page.getValue(...a),
  };
  // Runner trace capture (buildTrace) calls page.evaluate + page.getCurrentUrl; expose only what
  // the driver really has so a missing primitive stays absent (clean typeof guard, not a fake).
  if (typeof page.evaluate === 'function') pageApi.evaluate = (...a) => page.evaluate(...a);
  if (typeof page.getCurrentUrl === 'function') pageApi.getCurrentUrl = (...a) => page.getCurrentUrl(...a);

  // The ring stays empty until the driver enables the Network domain; scripts call this first.
  const network = { recent: () => page.recentRequests() };
  if (typeof page.enableNetwork === 'function') network.enable = (...a) => page.enableNetwork(...a);

  // Upload/download with fence (script-sdk.md §2.6): every file path passes
  // checkPath —越界 PermissionError (retriable=false), never a silent write.
  const upload = {
    setFiles: async (selector, files) => {
      if (!Array.isArray(files) || !files.length) throw new PermissionError('files must be a non-empty array');
      const safe = files.map((f) => checkPath(f));
      return page.upload(selector, safe);
    },
  };
  const download = {
    wait: (opts) => page.download(opts),
    save: async (target, destPath) => {
      const safe = checkPath(destPath);
      return page.download(Object.assign({}, target, { savePath: safe }));
    },
  };

  return {
    browser: {
      goto: (...a) => page.goto(...a),
      screenshot: async (...a) => {
        const shot = await page.screenshot(...a);
        // SDK contract is a Buffer; page.js returns {data: base64, bytes}.
        return shot && typeof shot.data === 'string' ? Buffer.from(shot.data, 'base64') : shot;
      },
    },
    page: pageApi,
    cookies,
    storage: {
      get: (k) => page.storageGet(k),
      set: (k, v) => page.storageSet(k, v),
    },
    network,
    upload,
    download,
    profileContext: Object.freeze(Object.assign({}, profileContext || {})),
  };
}

module.exports = { createBrowserApi, PermissionError };
