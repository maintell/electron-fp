'use strict';

// MVP 8 tools: OpenAI function schemas + execution against a tab.
// Pure w.r.t. electron: everything goes through ctx + tab.view.webContents,
// so plain node tests can inject fakes. Two hard rules:
//   1. Every entry first asserts tab.groupId === activeGroupId, else SCOPE_DENIED.
//   2. webContents is driven DIRECTLY on the (possibly background) tab's view;
//      execution never activates/switches the visible tab.

const snap = require('./snapshot');

const WRITE_TOOLS = new Set(['act', 'navigate', 'record', 'runScript']); // default needsApproval=true
const WAIT_POLL_MS = 250;
const WAIT_HARD_CAP_MS = 15000;
const READ_LIMIT = 12000;

function fn(name, description, properties, required) {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required: required || [] } },
  };
}

const TOOL_SCHEMAS = [
  fn('tabs', 'List, show, open or close tabs INSIDE the current group only.',
    { action: { type: 'string', enum: ['list', 'active', 'new', 'close'] }, tabId: { type: 'string' } }, ['action']),
  fn('navigate', 'Navigate the current tab (url/page/back/forward/reload). Returns a fresh snapshot.',
    { kind: { type: 'string', enum: ['url', 'page', 'back', 'forward', 'reload'] }, url: { type: 'string' }, ref: { type: 'number' } }, ['kind']),
  fn('snapshot', 'Take a fresh accessibility snapshot of the current tab.',
    {}, []),
  fn('act', 'Click/type/fill/press/scroll an element by snapshot ref. Returns snapshot+diff. No coordinates.',
    { kind: { type: 'string', enum: ['click', 'type', 'fill', 'press', 'scroll'] }, ref: { type: 'number' }, text: { type: 'string' }, key: { type: 'string' }, deltaY: { type: 'number' } }, ['kind', 'ref']),
  fn('read', 'Read visible text of the page, optionally scoped by a CSS selector.',
    { selector: { type: 'string' } }, []),
  fn('screenshot', 'Capture the visible tab as a PNG dataURL.',
    {}, []),
  fn('wait', 'Wait for text/selector to appear, or a fixed delay. 250ms poll, 15s hard cap.',
    { kind: { type: 'string', enum: ['text', 'selector', 'ms'] }, value: { type: 'string' }, ms: { type: 'number' } }, ['kind']),
  // --- automation bridge (script-sdk.md §8: agent output lands as SDK calls in the
  // same Runtime — these two tools are that landing path, not a second runtime) ---
  fn('record', 'Record one automation step from an observed agent action. Appends to the run-local trajectory buffer; flushed by runScript. No browser effect.',
    { step: { type: 'string', enum: ['goto', 'click', 'fill', 'type', 'press', 'waitForSelector', 'waitForText', 'readText', 'screenshot'] }, selector: { type: 'string' }, url: { type: 'string' }, value: { type: 'string' }, text: { type: 'string' }, key: { type: 'string' } }, ['step']),
  fn('runScript', 'Execute the recorded trajectory as an automation script through the shared Runtime (script-runner sandbox + audit). Only enabled when the host wires an automation runner.',
    { name: { type: 'string' } }, []),
];

function scopeError(ctx) {
  if (!ctx.tab || ctx.tab.groupId !== ctx.activeGroupId) return { error: 'SCOPE_DENIED' };
  return null;
}

function staleResult(tabId, fresh) {
  return fresh && fresh.error
    ? { error: 'REF_STALE', detail: 'snapshot also failed: ' + fresh.error }
    : { error: 'REF_STALE', snapshot: fresh.text };
}

async function freshSnapshot(ctx) {
  return snap.takeSnapshot(ctx.tab.view.webContents, ctx.tab.id);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boxCenter(wc, entry) {
  if (entry.backendNodeId === null || entry.backendNodeId === undefined) {
    return { error: 'ACT_NO_BOXMODEL: element has no DOM box (ref valid, not clickable)' };
  }
  const box = await wc.debugger.sendCommand('DOM.getBoxModel', { backendNodeId: entry.backendNodeId });
  const q = box && box.model && box.model.content;
  if (!q || q.length < 8) return { error: 'ACT_NO_BOXMODEL: box model unavailable' };
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

async function doClick(wc, pt) {
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
}

const KEYCODES = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
};

async function doAct(wc, kind, entry, args) {
  const pt = await boxCenter(wc, entry);
  if (pt.error) return pt;
  const send = (m, p) => wc.debugger.sendCommand(m, p);
  if (kind === 'click') {
    await doClick(wc, pt);
    return { ok: true, clicked: entry.ref };
  }
  if (kind === 'type') {
    if (typeof args.text !== 'string') return { error: 'ACT_NO_TEXT: type needs {text}' };
    await doClick(wc, pt);
    await send('Input.insertText', { text: args.text });
    return { ok: true, typed: args.text.length };
  }
  if (kind === 'fill') {
    if (typeof args.text !== 'string') return { error: 'ACT_NO_TEXT: fill needs {text}' };
    await doClick(wc, pt);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 }); // Ctrl+A
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
    await send('Input.insertText', { text: args.text });
    return { ok: true, filled: args.text.length };
  }
  if (kind === 'press') {
    const key = args.key;
    if (typeof key !== 'string' || !key) return { error: 'ACT_NO_KEY: press needs {key}' };
    const code = key.length === 1 ? 'Key' + key.toUpperCase() : key;
    const vkc = key.length === 1 ? key.toUpperCase().charCodeAt(0) : KEYCODES[key];
    if (vkc === undefined) return { error: 'ACT_KEY_UNSUPPORTED: ' + key };
    const base = { key, code, windowsVirtualKeyCode: vkc };
    if (key.length === 1) base.text = key;
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    return { ok: true, pressed: key };
  }
  if (kind === 'scroll') {
    const dy = typeof args.deltaY === 'number' ? args.deltaY : 300;
    await send('Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: dy });
    return { ok: true, scrolled: dy };
  }
  return { error: 'ACT_KIND_UNSUPPORTED: ' + kind + ' (want click/type/fill/press/scroll)' };
}

async function settleThenSnapshot(ctx, ms) {
  await sleep(ms);
  return freshSnapshot(ctx);
}

async function runTool(name, args, ctx) {
  // automation bridge tools bypass the tab-scope gate: they touch no tab, only
  // the run-local buffer / host runner. Scope is enforced when the trajectory
  // executes (profileContext of the run's own group), not at record time.
  if (name === 'record' || name === 'runScript') {
    const a = args && typeof args === 'object' ? args : {};
    if (name === 'record') {
      const steps = ['goto', 'click', 'fill', 'type', 'press', 'waitForSelector', 'waitForText', 'readText', 'screenshot'];
      if (!steps.includes(a.step)) return { error: 'RECORD_STEP_UNSUPPORTED: ' + a.step + ' (want ' + steps.join('/') + ')' };
      if (!ctx.trajectory || typeof ctx.trajectory.push !== 'function') {
        return { error: 'RECORD_NO_BUFFER: host did not wire a trajectory buffer' };
      }
      // Map the agent's waitFor* verbs onto the RPA AST's single `wait` node
      // ({type:'wait', for:...}) — validateAst rejects bare waitFor* types.
      let node;
      if (a.step === 'waitForSelector') {
        if (a.selector === undefined || a.selector === '') return { error: 'RECORD_WAIT_MISSING_SELECTOR: waitForSelector needs a selector' };
        node = { type: 'wait', for: 'selector', selector: String(a.selector) };
      } else if (a.step === 'waitForText') {
        if (a.selector === undefined || a.selector === '' || a.text === undefined) return { error: 'RECORD_WAIT_MISSING_FIELDS: waitForText needs selector and text' };
        node = { type: 'wait', for: 'text', selector: String(a.selector), text: String(a.text) };
      } else {
        node = { type: a.step };
      }
      if (a.selector !== undefined && node.selector === undefined) node.selector = String(a.selector);
      if (a.url !== undefined) node.url = String(a.url);
      if (a.value !== undefined) node.value = String(a.value);
      if (a.text !== undefined && node.text === undefined) node.text = String(a.text);
      if (a.key !== undefined) node.key = String(a.key);
      if (ctx.trajectory.length >= 500) return { error: 'RECORD_BUFFER_FULL: flush with runScript first' };
      ctx.trajectory.push(node);
      return { ok: true, recorded: a.step, buffered: ctx.trajectory.length };
    }
    // runScript
    if (!ctx.trajectory || !ctx.trajectory.length) return { error: 'RUNSCRIPT_EMPTY: record at least one step first' };
    if (!ctx.automation || typeof ctx.automation.runTrajectory !== 'function') {
      return { error: 'RUNSCRIPT_NOT_WIRED: host has no automation runner (bridge unwired)' };
    }
    const steps = ctx.trajectory.slice();
    let out;
    try {
      out = await ctx.automation.runTrajectory(steps, { name: typeof a.name === 'string' ? a.name : undefined });
    } catch (e) {
      return { error: 'RUNSCRIPT_FAILED: ' + ((e && e.message) || e) };
    }
    ctx.trajectory.length = 0; // flush only on dispatch (success or recorded failure)
    return { ok: true, steps: steps.length, status: out && out.status, executionId: out && out.executionId, result: out && out.result, error: out && out.error };
  }
  const deny = scopeError(ctx);
  if (deny) return deny;
  const a = args && typeof args === 'object' ? args : {};
  const wc = ctx.tab.view.webContents;
  const tabId = ctx.tab.id;

  if (name === 'tabs') {
    if (a.action === 'list') return { tabs: ctx.listTabs(ctx.tab.groupId) };
    if (a.action === 'active') return { tabId };
    if (a.action === 'new') return { tabId: ctx.createTab(ctx.tab.groupId) };
    if (a.action === 'close') {
      const target = ctx.getTab(a.tabId);
      if (!target || target.groupId !== ctx.tab.groupId) return { error: 'SCOPE_DENIED' };
      return { closed: a.tabId, ok: ctx.closeTab(a.tabId) };
    }
    return { error: 'TABS_ACTION_UNSUPPORTED: ' + a.action };
  }

  if (name === 'snapshot') {
    return freshSnapshot(ctx);
  }

  if (name === 'read') {
    const sel = typeof a.selector === 'string' && a.selector ? JSON.stringify(a.selector) : null;
    const code = sel
      ? `(function(){var el=document.querySelector(${sel});return (el&&el.innerText)||'';})()`
      : `(function(){return ((document&&document.body&&document.body.innerText)||'');})()`;
    let text = String(await wc.executeJavaScript(code, true));
    if (text.length > READ_LIMIT) text = text.slice(0, READ_LIMIT) + '\n...[truncated]';
    return { text };
  }

  if (name === 'screenshot') {
    const img = await wc.capturePage();
    return { dataUrl: img.toDataURL() };
  }

  if (name === 'wait') {
    const deadline = Date.now() + WAIT_HARD_CAP_MS;
    if (a.kind === 'ms') {
      const ms = Math.min(Math.max(0, Number(a.ms) || 0), WAIT_HARD_CAP_MS);
      await sleep(ms);
      return { waited: ms };
    }
    const code = a.kind === 'text'
      ? `(function(){return ((document&&document.body&&document.body.innerText)||'').indexOf(${JSON.stringify(String(a.value || ''))})>=0;})()`
      : a.kind === 'selector'
        ? `(function(){return !!document.querySelector(${JSON.stringify(String(a.value || ''))});})()`
        : null;
    if (!code) return { error: 'WAIT_KIND_UNSUPPORTED: ' + a.kind };
    for (;;) {
      let hit = false;
      try { hit = await wc.executeJavaScript(code, true); } catch (_) { hit = false; }
      if (hit) return { found: true, kind: a.kind };
      if (Date.now() >= deadline) return { found: false, kind: a.kind };
      await sleep(WAIT_POLL_MS);
    }
  }

  if (name === 'navigate') {
    if (a.kind === 'url') {
      if (typeof a.url !== 'string' || !a.url) return { error: 'NAV_NO_URL' };
      let url = a.url.trim();
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
      await wc.loadURL(url);
      const shot = await settleThenSnapshot(ctx, 500);
      return { ok: true, url, snapshot: shot.text || shot };
    }
    if (a.kind === 'page') {
      const entry = snap.resolveRef(tabId, a.ref);
      if (!entry) return staleResult(tabId, await freshSnapshot(ctx));
      const res = await snap.withDebugger(wc, async (send) => {
        const wcProxy = { debugger: { sendCommand: send } };
        return doAct(wcProxy, 'click', entry, {});
      });
      if (res && res.error) return res;
      const after = await settleThenSnapshot(ctx, 800);
      return { ok: true, ref: a.ref, snapshot: after.text || after };
    }
    if (a.kind === 'back' || a.kind === 'forward' || a.kind === 'reload') {
      try {
        if (a.kind === 'back') await wc.goBack();
        else if (a.kind === 'forward') await wc.goForward();
        else await wc.reload();
      } catch (e) { return { error: 'NAV_FAILED: ' + e.message }; }
      const shot = await settleThenSnapshot(ctx, 500);
      return { ok: true, kind: a.kind, snapshot: shot.text || shot };
    }
    return { error: 'NAV_KIND_UNSUPPORTED: ' + a.kind };
  }

  if (name === 'act') {
    if (a.x !== undefined || a.y !== undefined) {
      return { error: 'COORDINATES_UNSUPPORTED: pass a snapshot ref, not x/y' };
    }
    if (!['click', 'type', 'fill', 'press', 'scroll'].includes(a.kind)) {
      return { error: 'ACT_KIND_UNSUPPORTED: ' + a.kind + ' (want click/type/fill/press/scroll)' };
    }
    let entry = snap.resolveRef(tabId, a.ref);
    let before = snap.lastBare(tabId);
    if (!entry) return staleResult(tabId, await freshSnapshot(ctx));
    // Act through the debugger (Input.* + DOM.*); never touches visibility.
    const res = await snap.withDebugger(wc, async (send) => {
      const wcProxy = { debugger: { sendCommand: send } };
      return doAct(wcProxy, a.kind, entry, a);
    });
    if (res && res.error) return res; // DEBUGGER_BUSY / ACT_* carry own codes
    const afterShot = await freshSnapshot(ctx);
    const afterBare = afterShot.bare !== undefined ? afterShot.bare : before;
    return { ...res, snapshot: afterShot.text || afterShot, diff: snap.diff(before, afterBare) };
  }

  return { error: 'UNKNOWN_TOOL: ' + name };
}

module.exports = { TOOL_SCHEMAS, WRITE_TOOLS, runTool, doAct };
