'use strict';

// Accessibility-tree snapshots over webContents.debugger. Pure logic: operates
// only on the passed webContents-like object, no electron require, so plain
// node tests can drive it with fakes.
//
// Ref model: refs are small ints, incrementing within one document. We keep a
// per-tab (documentKey,frameId,backendNodeId)->ref table; when the document
// key changes the WHOLE table is dropped (documentKey = documentURL from
// DOM.getDocument — conservative: same-document SPA hash changes may over-
// invalidate, but a wrong-node click is worse than a REF_STALE).
// A ref that is not in the CURRENT table resolves to null; callers must then
// take a fresh snapshot and return {error:'REF_STALE', snapshot} — never guess.

// 〈page-content〉 wrapper marks the block as UNTRUSTED page data (the engine
// system prompt tells the model it is data, never instructions).
const WRAP_OPEN = (tab) => `\u3008page-content tab=${tab}\u3009`;
const WRAP_CLOSE = '\u3008/page-content\u3009';
const INLINE_LIMIT = 12000; // chars of snapshot text inlined; rest truncated
const DIFF_LIMIT = 80;      // output lines of diff()

const states = new Map(); // tabId -> { docKey, map: Map(key->entry), counter, lastBare }

function stateFor(tabId) {
  let st = states.get(tabId);
  if (!st) { st = { docKey: null, map: new Map(), counter: 0, lastBare: '' }; states.set(tabId, st); }
  return st;
}

function clearTab(tabId) { states.delete(tabId); }

function nodeKey(n) {
  const frame = n.frameId || n.frameid || 'main';
  if (n.backendDOMNodeId !== undefined && n.backendDOMNodeId !== null) {
    return frame + ':' + n.backendDOMNodeId;
  }
  return frame + ':ax:' + n.nodeId; // no DOM backing: ref resolves, box model may fail
}

function isHidden(n) {
  if (n.ignored === true || n.hidden === true) return true;
  const role = (n.role && (n.role.value || n.role.type)) || '';
  return role === 'Ignored'; // roleIgnored: never addressable, never shown
}

function nodeText(n) {
  const role = (n.role && (n.role.value || n.role.type)) || 'Unknown';
  const name = (n.name && n.name.value) || '';
  return name ? `${role} ${name}` : role;
}

// Attach (ours) -> fn(send) -> detach. Attach failure means someone else owns
// the debugger (DevTools open): report, do not steal it.
async function withDebugger(wc, fn) {
  try {
    wc.debugger.attach('1.3');
  } catch (e) {
    return { error: 'DEBUGGER_BUSY——请先关闭 DevTools' };
  }
  try {
    return await fn((method, params) => wc.debugger.sendCommand(method, params));
  } finally {
    try { wc.debugger.detach(); } catch (_) { /* already gone */ }
  }
}

async function takeSnapshot(wc, tabId) {
  const st = stateFor(tabId);
  const out = await withDebugger(wc, async (send) => {
    try { await send('Accessibility.enable'); } catch (_) { /* events unneeded */ }
    let docKey = 'unknown';
    try {
      const doc = await send('DOM.getDocument', { depth: 0 });
      if (doc && doc.root) docKey = String(doc.root.documentURL || 'unknown');
    } catch (_) { /* keep 'unknown' */ }
    if (docKey !== st.docKey) { // new document: every old ref is dead
      st.docKey = docKey;
      st.map = new Map();
      st.counter = 0;
    }
    const tree = await send('Accessibility.getFullAXTree', {});
    const nodes = (tree && tree.nodes) || [];
    const lines = [];
    for (const n of nodes) {
      if (!n || isHidden(n)) continue;
      const key = nodeKey(n);
      let entry = st.map.get(key);
      if (!entry) {
        entry = {
          ref: ++st.counter,
          frameId: n.frameId || 'main',
          backendNodeId: (n.backendDOMNodeId !== undefined && n.backendDOMNodeId !== null)
            ? n.backendDOMNodeId : null,
          axNodeId: n.nodeId,
        };
        st.map.set(key, entry);
      }
      lines.push(`${entry.ref}: ${nodeText(n)}`);
    }
    return { lines };
  });
  if (out && out.error) return out;
  const bare = out.lines.join('\n');
  st.lastBare = bare;
  const inline = bare.length > INLINE_LIMIT
    ? bare.slice(0, INLINE_LIMIT) + '\n...[truncated]'
    : bare;
  return {
    text: `${WRAP_OPEN(tabId)}\n${inline}\n${WRAP_CLOSE}`,
    bare,
    refs: st.counter,
    truncated: bare.length > INLINE_LIMIT,
  };
}

function resolveRef(tabId, ref) {
  const st = states.get(tabId);
  if (!st) return null;
  const n = Number(ref);
  if (!Number.isFinite(n)) return null;
  for (const entry of st.map.values()) {
    if (entry.ref === n) return entry;
  }
  return null;
}

function lastBare(tabId) {
  const st = states.get(tabId);
  return st ? st.lastBare : '';
}

// Line diff, capped at DIFF_LIMIT output lines. Prefix/suffix trim keeps it
// honest for append/change tails without an LCS dependency.
function diff(oldText, newText) {
  const a = String(oldText || '').split('\n');
  const b = String(newText || '').split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre &&
         a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const del = a.slice(pre, a.length - suf);
  const add = b.slice(pre, b.length - suf);
  if (!del.length && !add.length) return '(no visible change)';
  const out = [...del.map((l) => `- ${l}`), ...add.map((l) => `+ ${l}`)];
  return out.length > DIFF_LIMIT
    ? out.slice(0, DIFF_LIMIT).join('\n') + '\n...[diff truncated]'
    : out.join('\n');
}

module.exports = {
  takeSnapshot, resolveRef, lastBare, diff, clearTab, withDebugger,
  INLINE_LIMIT, DIFF_LIMIT,
};
