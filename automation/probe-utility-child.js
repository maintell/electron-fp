'use strict';
// R6 child driver (OQ-16): runs INSIDE an Electron utilityProcess. It has no BrowserWindow
// and no webContents handle — it can only ask the main process to broker CDP calls on the
// real debugger. This is the whole point of the experiment: can the driving logic live in a
// utilityProcess and still make the real window navigate/evaluate, round-tripping results?
//
// Wire: child --postMessage({t:'cdp',...})--> main --webContents.debugger--> window
//       child <--postMessage({t:'reply',...})-- main
// Message shape (Electron docs): child receives process.parentPort 'message' event as
// {data, ports}; main receives child.on('message', data) with the payload directly.

const parentPort = process.parentPort;

let seq = 0;
const pending = new Map();

function cdp(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ t: 'cdp', id, method, params: params || {} });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

parentPort.on('message', (e) => {
  const msg = e && e.data !== undefined ? e.data : e;
  if (!msg || msg.t !== 'reply') return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(msg.error || 'cdp error'));
});

parentPort.on('message', async (e) => {
  const msg = e && e.data !== undefined ? e.data : e;
  if (!msg || msg.t !== 'go') return;
  try {
    // a. navigate the real window from the utility process (brokered)
    await cdp('Page.navigate', { url: msg.url });
    // b. poll evaluate until the new document's title is live
    let title = null;
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      const r = await cdp('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      title = r && r.result && r.result.value;
      if (title === msg.title) break;
    }
    // c. arithmetic round-trip
    const m = await cdp('Runtime.evaluate', { expression: msg.mathExpr, returnByValue: true });
    const math = m && m.result && m.result.value;
    parentPort.postMessage({ t: 'done', title, math });
  } catch (err) {
    parentPort.postMessage({ t: 'done', error: String((err && err.message) || err) });
  }
});

parentPort.postMessage({ t: 'ready', pid: process.pid });
