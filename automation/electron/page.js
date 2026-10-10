// ponytail: real-page driver over injected session/adapter/rng; zero electron require.
// Unit logic stays in runtime/ (mock-tested); this file is thin CDP composition.
// Precondition (diag-verified): the webContents must have a COMMITTED load
// (about:blank + did-finish-load) before attach — CDP before first commit
// rejects with 'target closed'. The caller owns window creation order.
'use strict';

const { planClick, planTyping } = require('../runtime/human-input');

class SelectorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SelectorError';
  }
}
class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}
class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkError';
  }
}
class DownloadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DownloadError';
  }
}

function withTimeout(p, ms, makeErr) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(makeErr()), ms);
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdpValue(res) {
  if (res && res.result && Object.prototype.hasOwnProperty.call(res.result, 'value')) {
    return res.result.value;
  }
  return undefined;
}

function createPageDriver({ webContents, session, adapter, rng } = {}) {
  if (!webContents) throw new Error('webContents required');
  if (!session) throw new Error('session required');
  if (!adapter) throw new Error('adapter required');
  if (!rng) throw new Error('rng required');
  const wc = webContents;
  const dbg = wc.debugger;

  // Network ring (cap 200) + Page.loadEventFired hook share one message listener.
  const ring = [];
  let loadFired = null;
  let netEnabled = false;
  dbg.on('message', (_e, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      ring.push({ url: params && params.request && params.request.url, ts: Date.now() });
      if (ring.length > 200) ring.shift();
    }
    if (method === 'Page.loadEventFired' && typeof loadFired === 'function') {
      const f = loadFired;
      loadFired = null;
      f();
    }
  });

  async function evalExpr(expression) {
    // browser-session routes Runtime.evaluate to the isolated world + returnByValue.
    const res = await session.sendCommand('Runtime.evaluate', { expression, returnByValue: true });
    return cdpValue(res);
  }

  async function goto(url, { timeoutMs = 15000 } = {}) {
    let settled = false;
    let onOk = null;
    let onBad = null;
    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new TimeoutError('goto timeout: ' + url));
        }
      }, timeoutMs);
      onOk = () => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolve(true);
        }
      };
      onBad = (_e, code, desc) => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          reject(new NetworkError('goto failed: ' + code + ' ' + desc));
        }
      };
      loadFired = onOk; // Page.loadEventFired path
      wc.once('did-finish-load', onOk);
      wc.once('did-fail-load', onBad);
    });
    try {
      await session.sendCommand('Page.navigate', { url });
      await done;
    } finally {
      loadFired = null;
      // targeted removal only — never removeAllListeners (other owners exist).
      if (onOk) wc.removeListener('did-finish-load', onOk);
      if (onBad) wc.removeListener('did-fail-load', onBad);
    }
    return { url: wc.getURL() };
  }

  async function resolve(sel) {
    const v = await evalExpr(
      '(()=>{const el=document.querySelector(' +
        JSON.stringify(sel) +
        ');if(!el)return null;try{el.scrollIntoView({block:"center"})}catch(_){}' +
        'const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()'
    );
    if (!v || typeof v.x !== 'number') throw new SelectorError('no element: ' + sel);
    return v;
  }

  let lastPos = { x: 0, y: 0 };

  async function click(sel) {
    const pt = await resolve(sel);
    const plan = planClick({ at: { x: pt.x, y: pt.y }, from: lastPos, rng });
    lastPos = { x: pt.x, y: pt.y };
    return adapter.clickAt({ moves: plan.moves, holdMs: plan.holdMs });
  }

  async function clearValue(sel) {
    await evalExpr(
      '(()=>{const el=document.querySelector(' +
        JSON.stringify(sel) +
        ');if(!el)return false;el.focus();el.value="";' +
        'el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return true;})()'
    );
  }

  async function fill(sel, text) {
    await click(sel); // focus via real trajectory
    await clearValue(sel);
    // mistakeProb 0: deterministic content, planner still computes timing/jitter.
    return adapter.typeOps(planTyping({ text: String(text), rng, mistakeProb: 0 }));
  }

  async function type(sel, text) {
    await click(sel);
    return adapter.typeOps(planTyping({ text: String(text), rng, mistakeProb: 0 }));
  }

  async function press(key, { text } = {}) {
    // diag-verified: Enter-submit needs the char event — keyDown/keyUp alone
    // does nothing (D1 silent, D2 with char '\r' submits). Single chars carry
    // themselves; Enter carries '\r'; other specials carry no char.
    const charText = text !== undefined ? text : key === 'Enter' ? '\r' : key.length === 1 ? key : null;
    if (session.input && typeof session.input.send === 'function') {
      session.input.send({ type: 'keyDown', keyCode: key });
      if (charText != null) session.input.send({ type: 'char', keyCode: charText });
      session.input.send({ type: 'keyUp', keyCode: key });
      return { key, backend: 'send' };
    }
    await session.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key });
    if (charText != null) await session.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: charText });
    await session.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key });
    return { key, backend: 'dispatch' };
  }

  async function waitForSelector(sel, { timeoutMs = 5000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      try {
        return await resolve(sel);
      } catch (e) {
        if (!(e instanceof SelectorError)) throw e;
      }
      if (Date.now() - t0 > timeoutMs) throw new TimeoutError('waitForSelector timeout: ' + sel);
      await sleep(100);
    }
  }

  async function waitForText(t, { timeoutMs = 5000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const found = await evalExpr('document.body.innerText.includes(' + JSON.stringify(t) + ')');
      if (found === true) return true;
      if (Date.now() - t0 > timeoutMs) throw new TimeoutError('waitForText timeout: ' + t);
      await sleep(100);
    }
  }

  async function waitForURL(sub, { timeoutMs = 5000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      if (String(wc.getURL()).includes(sub)) return true;
      if (Date.now() - t0 > timeoutMs) throw new TimeoutError('waitForURL timeout: ' + sub);
      await sleep(100);
    }
  }

  async function waitForFunction(expr, { timeoutMs = 5000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const v = await evalExpr('Boolean(' + expr + ')');
      if (v === true) return true;
      if (Date.now() - t0 > timeoutMs) throw new TimeoutError('waitForFunction timeout');
      await sleep(100);
    }
  }

  async function getText(sel) {
    const v = await evalExpr(
      '(()=>{const el=document.querySelector(' + JSON.stringify(sel) + ');return el?el.textContent:null;})()'
    );
    if (v == null) throw new SelectorError('no element: ' + sel);
    return v;
  }

  async function getAttribute(sel, name) {
    return evalExpr(
      '(()=>{const el=document.querySelector(' +
        JSON.stringify(sel) +
        ');return el?el.getAttribute(' +
        JSON.stringify(name) +
        '):null;})()'
    );
  }

  // Live input value (property, not the HTML attribute — getAttribute('value')
  // stays at the markup default after typing; this reads what the user sees).
  async function getValue(sel) {
    const v = await evalExpr(
      '(()=>{const el=document.querySelector(' + JSON.stringify(sel) + ');return el?el.value:null;})()'
    );
    if (v == null) throw new SelectorError('no element: ' + sel);
    return v;
  }

  const cookies = {
    get: (filter) => wc.session.cookies.get(filter || {}),
    set: (details) => wc.session.cookies.set(details),
    remove: (url, name) => wc.session.cookies.remove(url, name),
  };

  async function storageSet(key, value) {
    return evalExpr(
      'localStorage.setItem(' + JSON.stringify(key) + ',' + JSON.stringify(String(value)) + ')'
    );
  }

  async function storageGet(key) {
    return evalExpr('localStorage.getItem(' + JSON.stringify(key) + ')');
  }

  async function upload(sel, filePath) {
    const doc = await session.sendCommand('DOM.getDocument', { depth: 0 });
    const rootId = doc && doc.root && doc.root.nodeId;
    if (!rootId) throw new SelectorError('no document root');
    const q = await session.sendCommand('DOM.querySelector', { nodeId: rootId, selector: sel });
    if (!q || !q.nodeId) throw new SelectorError('upload target not found: ' + sel);
    const desc = await session.sendCommand('DOM.describeNode', { nodeId: q.nodeId });
    const backendId = desc && desc.node && desc.node.backendNodeId;
    if (!backendId) throw new SelectorError('no backendNodeId for: ' + sel);
    await session.sendCommand('DOM.setFileInputFiles', { files: [filePath], backendNodeId: backendId });
    return { selector: sel, file: filePath };
  }

  async function download({ trigger, savePath, downloadDir, timeoutMs = 20000 } = {}) {
    if (typeof trigger !== 'function') throw new Error('trigger required');
    if (!savePath) throw new Error('savePath required');
    if (!downloadDir) throw new Error('downloadDir required');
    await session.sendCommand('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    let onDl = null;
    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (onDl) wc.session.removeListener('will-download', onDl);
        reject(new DownloadError('download timeout: ' + savePath));
      }, timeoutMs);
      onDl = (_e, item) => {
        try {
          item.setSavePath(savePath);
        } catch (err) {
          clearTimeout(t);
          reject(new DownloadError('setSavePath failed: ' + (err && err.message)));
          return;
        }
        item.once('done', (_ev, state) => {
          clearTimeout(t);
          if (state === 'completed') resolve({ path: savePath, state });
          else reject(new DownloadError('download state: ' + state));
        });
      };
      wc.session.once('will-download', onDl);
    });
    try {
      await trigger();
      return await done;
    } catch (e) {
      if (onDl) {
        try {
          wc.session.removeListener('will-download', onDl);
        } catch (_) {}
      }
      throw e;
    }
  }

  async function enableNetwork() {
    if (netEnabled) return { enabled: true };
    await session.sendCommand('Network.enable', {});
    netEnabled = true;
    return { enabled: true };
  }

  function recentRequests() {
    return ring.slice();
  }

  async function screenshot() {
    // Mirrors glue api.screenshot: hidden windows need Page.enable + retry-until-frame.
    await session.sendCommand('Page.enable', {});
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await withTimeout(
          session.sendCommand('Page.captureScreenshot', {}),
          10000,
          () => new TimeoutError('screenshot timeout')
        );
        const data = res && res.data;
        if (!data) throw new Error('empty screenshot');
        return { data, bytes: Buffer.from(data, 'base64').length };
      } catch (e) {
        lastErr = e;
        await sleep(500);
      }
    }
    throw lastErr || new Error('no screenshot');
  }

  return {
    goto,
    resolve,
    click,
    fill,
    type,
    press,
    waitForSelector,
    waitForText,
    waitForURL,
    waitForFunction,
    getText,
    getAttribute,
    getValue,
    cookies,
    storageSet,
    storageGet,
    upload,
    download,
    enableNetwork,
    recentRequests,
    screenshot,
    // §16 forensics primitives: exported so the production facade (browser-api.js) can
    // capture DOM/HTML + current URL on failure. evalExpr already existed internally.
    evaluate: evalExpr,
    getCurrentUrl: () => wc.getURL(),
  };
}

module.exports = { createPageDriver, SelectorError, TimeoutError, NetworkError, DownloadError };
