'use strict';
/* ============================================================================
 * RPA visual builder — renderer-only module. No Node requires.
 *
 * Mount: <div id="rpa-builder"></div> + <script src="rpa.js">, or
 *        RpaBuilder.mount(el) / RpaBuilder.unmount().
 * Demo:  open a page with ?demo=1 — loads a sample linear flow
 *        (goto → wait → fill → click → readText → if).
 *
 * ── window.rpaApi contract (bridge provided by preload/main) ───────────────
 * Every method is OPTIONAL. Panel degrades gracefully when absent
 * (bridge-missing banner, Replay/Save disabled, local structural validation).
 *
 *  save(flow): Promise<flow>
 *      flow = { name: string, nodes: RpaNode[] }   // rpa.md §2
 *
 *  load(): Promise<flow>
 *      Called once on mount when present (skipped when ?demo=1).
 *
 *  validate(flow): Promise<{ ok: boolean,
 *                            errors: [{ path?: number[]|string, nodeId?: string,
 *                                       msg: string }] }>
 *      Local structural check is the fallback: unknown type / dangling label /
 *      nesting ≤ 8 / nodes ≤ 5000 / required fields (rpa.md §2.2).
 *
 *  replay(flow): Promise<{ executionId?: string }>
 *      Disabled (tooltip) when absent. Readonly UI while in flight; when an
 *      executionId comes back, log lines stream until user ends the session.
 *      ponytail: no stop()/poll — end is local; add stop when bridge grows one.
 *
 *  subscribeLog(executionId: string, cb: (line) => void): () => void
 *      line = { ts?: number, level?: 'debug'|'info'|'warn'|'error', text: string }
 *
 *  recorder?: { start(opts?: {profileId?, url?}): Promise<{sessionId, url}>,
 *               drain(sessionId): Promise<{nodes, count}>,
 *               stop(sessionId): Promise<{ast: {nodes, meta}}>,
 *               state(sessionId?): Promise<{active, sessions, nodes}> }
 *      OPTIONAL — Record/Stop + live capture list. Recorded nodes are
 *      recorder-shaped (rpa-recorder.js §2.1: { type, selector, selectorType,
 *      quality, … }); the canvas only changes when the user imports. The whole
 *      object is passed through, so `state()` stays reachable for hosts.
 * ========================================================================== */

(function () {

  /* ── node catalog (rpa.md §2.1) ───────────────────────────────────────── */

  const MAX_DEPTH = 8;
  const MAX_NODES = 5000;
  const OPS = ['==', '!=', '>', '<', '>=', '<=', 'contains'];
  const WAIT_KINDS = ['selector', 'visible', 'hidden', 'text', 'url',
    'navigation', 'networkIdle', 'response', 'request', 'delay'];

  // S = field schema: { k, label, req?, type: 'select'|'textarea'|'number'|'list'|'bool', options? }
  const TYPES = {
    goto:         { label: '打开网址', glyph: '→', group: '导航', sum: 'url',
                    S: [{ k: 'url', label: 'URL', req: true }] },
    scroll:       { label: '滚动', glyph: '↕', group: '导航', sum: 'selector',
                    S: [{ k: 'selector', label: 'Selector（空=文档）' },
                        { k: 'dy', label: '滚动像素', type: 'number' },
                        { k: 'toEnd', label: '滚到底', type: 'bool' }] },
    click:        { label: '点击', glyph: '⦿', group: '交互', sum: 'selector',
                    S: [{ k: 'selector', label: 'Selector', req: true }] },
    clickText:    { label: '文本点击', glyph: '¶', group: '交互', sum: 'text',
                    S: [{ k: 'text', label: '可见文本', req: true },
                        { k: 'selector', label: '作用域 Selector' }] },
    clickRole:    { label: '角色点击', glyph: '⚑', group: '交互', sum: 'role',
                    S: [{ k: 'role', label: 'role', req: true },
                        { k: 'name', label: 'accessible name' }] },
    fill:         { label: '填写', glyph: '✎', group: '交互', sum: 'selector',
                    S: [{ k: 'selector', label: 'Selector', req: true },
                        { k: 'value', label: '值' }] },
    type:         { label: '逐键输入', glyph: '⌨', group: '交互', sum: 'text',
                    S: [{ k: 'selector', label: 'Selector', req: true },
                        { k: 'text', label: '文本', req: true },
                        { k: 'delay', label: '间隔 ms', type: 'number' }] },
    press:        { label: '按键', glyph: '⏎', group: '交互', sum: 'key',
                    S: [{ k: 'selector', label: 'Selector', req: true },
                        { k: 'key', label: '键（Enter/Tab…）', req: true }] },
    select:       { label: '下拉选择', glyph: '☰', group: '交互', sum: 'selector',
                    S: [{ k: 'selector', label: 'Selector', req: true },
                        { k: 'value', label: '值', req: true }] },
    upload:       { label: '上传文件', glyph: '⇧', group: '交互', sum: 'files',
                    S: [{ k: 'selector', label: 'Selector', req: true },
                        { k: 'files', label: '路径（; 分隔，围栏内）', req: true, type: 'list' }] },
    readText:     { label: '读文本', glyph: 'T', group: '数据', sum: 'var',
                    S: [{ k: 'selector', label: 'Selector', req: true },
                        { k: 'var', label: '存入变量', req: true }] },
    readAttr:     { label: '读属性', glyph: '#', group: '数据', sum: 'attr',
                    S: [{ k: 'selector', label: 'Selector', req: true },
                        { k: 'attr', label: '属性名', req: true },
                        { k: 'var', label: '存入变量', req: true }] },
    setVar:       { label: '设变量', glyph: '=', group: '数据', sum: 'name',
                    S: [{ k: 'name', label: '变量名', req: true },
                        { k: 'value', label: '值' }] },
    downloadWait: { label: '等下载', glyph: '⇩', group: '数据', sum: 'pattern',
                    S: [{ k: 'pattern', label: '文件名 pattern', req: true },
                        { k: 'var', label: '存入变量（可选）' }] },
    wait:         { label: '等待', glyph: '⧗', group: '系统', sum: 'kind',
                    S: [{ k: 'kind', label: '等待条件（智能等待）', req: true,
                          type: 'select', options: WAIT_KINDS },
                        { k: 'selector', label: 'Selector（selector/visible/hidden）' },
                        { k: 'text', label: '文本（text）' },
                        { k: 'url', label: 'URL（url/response/request）' },
                        { k: 'timeout', label: '超时 ms', type: 'number' }] },
    screenshot:   { label: '截图', glyph: '▣', group: '系统', sum: '',
                    S: [{ k: 'fullPage', label: '整页', type: 'bool' },
                        { k: 'var', label: '存入变量（可选）' }] },
    execJs:       { label: '执行 JS', glyph: '{}', group: '系统', sum: 'code',
                    S: [{ k: 'code', label: '表达式（page.evaluate 受限）', req: true,
                          type: 'textarea' }] },
    log:          { label: '日志', glyph: '›', group: '系统', sum: 'message',
                    S: [{ k: 'message', label: '内容', req: true },
                        { k: 'level', label: '级别', type: 'select',
                          options: ['info', 'warn', 'error', 'debug'] }] },
    if:           { label: '条件分支', glyph: '?', group: '控制流', sum: 'cond',
                    S: [], branches: [{ key: 'then', label: 'then', cls: 'rap-branch-then' },
                                      { key: 'else', label: 'else', cls: 'rap-branch-else' }] },
    loop:         { label: '循环', glyph: '↻', group: '控制流', sum: 'loop',
                    S: [{ k: 'mode', label: '模式', req: true, type: 'select',
                          options: ['count', 'while'] }],
                    branches: [{ key: 'body', label: 'body', cls: 'rap-branch-body' }] },
    gotoLabel:    { label: '跳转', glyph: '↷', group: '控制流', sum: 'label',
                    S: [{ k: 'label', label: '目标 label', req: true }] },
    label:        { label: '标签', glyph: '§', group: '控制流', sum: 'name',
                    S: [{ k: 'name', label: '标签名（唯一）', req: true }] },
    try:          { label: '异常捕获', glyph: '⚠', group: '控制流', sum: 'catchVar',
                    S: [{ k: 'catchVar', label: '错误存入变量' }],
                    branches: [{ key: 'body', label: 'body', cls: 'rap-branch-body' }] },
    throw:        { label: '抛错', glyph: '✗', group: '控制流', sum: 'message',
                    S: [{ k: 'message', label: '消息', req: true }] },
  };

  const GROUP_ORDER = ['导航', '交互', '数据', '控制流', '系统'];

  /* ── state ────────────────────────────────────────────────────────────── */

  const state = {
    mounted: false, root: null,
    flow: { name: '', nodes: [] },
    selected: null,          // path string, e.g. "0,then,1"
    arm: null,               // branch path string armed for insert ("" = root)
    dirty: false,
    errors: [],              // [{ path: string, msg }]
    bridge: null,
    jsonMode: false,
    replaying: false, exId: null, unsub: null,
    seq: 0,
    // recorder (§4): capture is independent of the canvas until import
    recording: false, recId: null, recNodes: [], recStartTs: 0,
    recPoll: null, recTimer: null, recImported: false, pendingImport: null,
  };

  const $ = (id) => state.root.querySelector('#' + id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const uid = () => 'n' + (++state.seq) + '_' + Math.random().toString(36).slice(2, 7);

  /* ── path helpers ─────────────────────────────────────────────────────── */
  // list path: [] root, or [idx, branch, idx, branch, …] (even length)
  // node path: list path + final index (odd length)

  function getList(listParts) {
    let list = state.flow.nodes;
    for (let i = 0; i < listParts.length; i += 2) {
      const node = list[listParts[i]];
      if (!node) return null;
      list = node[listParts[i + 1]];
      if (!Array.isArray(list)) return null;
    }
    return list;
  }

  function parsePath(str) {
    if (!str) return [];
    return str.split(',').map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  }

  function listPathOf(nodePath) { return nodePath.slice(0, -1); }

  function getNode(pathStr) {
    const p = parsePath(pathStr);
    const list = getList(listPathOf(p));
    return list ? list[p[p.length - 1]] : null;
  }

  function getRef(pathStr) {           // { list, index, node }
    const p = parsePath(pathStr);
    const list = getList(listPathOf(p));
    if (!list) return null;
    const index = p[p.length - 1];
    return { list, index, node: list[index] };
  }

  function pathKey(parts) { return parts.join(','); }

  /* ── model ops ────────────────────────────────────────────────────────── */

  function makeNode(type) {
    const meta = TYPES[type];
    const n = { id: uid(), type };
    if (meta) {
      for (const f of meta.S) {
        if (f.type === 'select') n[f.k] = f.options[0];
        else if (f.type === 'number') n[f.k] = '';
        else if (f.type === 'list') n[f.k] = [];
        else if (f.type === 'bool') n[f.k] = false;
        else n[f.k] = '';
      }
      if (type === 'if') { n.cond = { left: '', op: '==', right: '' }; n.then = []; n.else = []; }
      if (type === 'loop') { n.mode = 'count'; n.count = '1'; n.cond = { left: '', op: '==', right: '' }; n.body = []; }
      if (type === 'try') n.body = [];
      if (type === 'wait') n.kind = 'selector';
      if (type === 'log') n.level = 'info';
    }
    return n;
  }

  function cloneWithIds(node) {
    const c = JSON.parse(JSON.stringify(node));
    (function walk(n) {
      n.id = uid();
      for (const k of ['then', 'else', 'body']) {
        if (Array.isArray(n[k])) n[k].forEach(walk);
      }
    })(c);
    return c;
  }

  function countNodes(list) {
    let c = 0;
    for (const n of list || []) {
      c += 1;
      for (const k of ['then', 'else', 'body']) {
        if (Array.isArray(n[k])) c += countNodes(n[k]);
      }
    }
    return c;
  }

  function depthOf(list) {
    let d = 0;
    for (const n of list || []) {
      let sub = 0;
      for (const k of ['then', 'else', 'body']) {
        if (Array.isArray(n[k])) sub = Math.max(sub, depthOf(n[k]));
      }
      d = Math.max(d, 1 + sub);
    }
    return d;
  }

  function reindexErrPath(nodePath) { return pathKey(nodePath); }

  function findAll(list, pred, baseParts, out) {
    out = out || [];
    list = list || [];
    baseParts = baseParts || []; // ponytail: callers pass 2 args; absent baseParts crashed every validate
    for (let i = 0; i < list.length; i++) {
      const parts = baseParts.concat([i]);
      pred(list[i], parts, out);
      for (const k of ['then', 'else', 'body']) {
        if (Array.isArray(list[i][k])) findAll(list[i][k], pred, parts.concat([k]), out);
      }
    }
    return out;
  }

  /* ── local structural validation (rpa.md §2.2 fallback) ───────────────── */

  function localValidate(flow) {
    const errs = [];
    const push = (parts, msg) => errs.push({ path: pathKey(parts), msg });

    if (!flow || !Array.isArray(flow.nodes)) {
      return [{ path: '', msg: '流程必须为 { name, nodes[] }' }];
    }
    const total = countNodes(flow.nodes);
    if (total > MAX_NODES) {
      push([], `节点数 ${total} 超过上限 ${MAX_NODES}`);
      return errs;
    }

    const labels = new Map();          // name -> pathKey
    findAll(flow.nodes, (n, parts) => {
      const at = reindexErrPath(parts);
      if (!TYPES[n.type]) { errs.push({ path: at, msg: `未知节点类型: ${n.type}` }); return; }
      const meta = TYPES[n.type];
      for (const f of meta.S) {
        if (f.req && isEmptyField(n[f.k])) {
          errs.push({ path: at, msg: `${meta.label}: 缺少 ${f.label}` });
        }
      }
      if (n.type === 'if') {
        const c = n.cond || {};
        if (!c.left || !c.op || !c.right) {
          errs.push({ path: at, msg: '条件分支: cond 需要 left/op/right（结构化，无 eval）' });
        } else if (OPS.indexOf(c.op) < 0) {
          errs.push({ path: at, msg: `条件分支: 非法操作符 ${c.op}` });
        }
      }
      if (n.type === 'loop') {
        if (n.mode === 'count') {
          const c = Number(n.count);
          if (!Number.isInteger(c) || c < 1 || c > 10000) {
            errs.push({ path: at, msg: '循环: count 须为 1–10000 整数' });
          }
        } else if (n.mode === 'while') {
          const c = n.cond || {};
          if (!c.left || !c.op || !c.right || OPS.indexOf(c.op) < 0) {
            errs.push({ path: at, msg: '循环: while 需要合法 cond' });
          }
        } else {
          errs.push({ path: at, msg: `循环: 非法 mode ${n.mode}` });
        }
      }
      if (n.type === 'label') {
        if (labels.has(n.name)) {
          errs.push({ path: at, msg: `重复 label: ${n.name}` });
        } else labels.set(n.name, at);
      }
      if (n.type === 'gotoLabel') {
        if (!n.label) errs.push({ path: at, msg: '跳转: 缺少目标 label' });
        // dangling check runs after full walk (labels may come later)
        (gotoPending = gotoPending || []).push({ at, label: n.label });
      }
      // nesting depth: count container ancestors of this node
      const containers = parts.filter((x) => typeof x === 'string').length;
      if (containers > MAX_DEPTH - 1) {
        errs.push({ path: at, msg: `嵌套深度超过上限 ${MAX_DEPTH}` });
      }
    });

    // dangling labels (forward allowed, but target must exist)
    for (const g of gotoPending || []) {
      if (g.label && !labels.has(g.label)) {
        errs.push({ path: g.at, msg: `悬空 label: ${g.label}` });
      }
    }
    gotoPending = null;
    return errs;
  }
  let gotoPending = null;

  function isEmptyField(v) {
    if (v == null) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (Array.isArray(v)) return v.length === 0;
    return false;
  }

  async function runValidate() {
    let errs;
    if (state.bridge && state.bridge.validate) {
      try {
        const res = await state.bridge.validate(state.flow);
        errs = normalizeBridgeErrors(res);
      } catch (e) {
        errs = [{ path: '', msg: 'bridge validate 失败，已用本地校验: ' + (e && e.message || e) }];
        errs = errs.concat(localValidate(state.flow));
      }
    } else {
      errs = localValidate(state.flow);
    }
    state.errors = errs;
    renderErrors();
    renderStatePill();
    renderCanvas();
    return errs.length === 0;
  }

  function normalizeBridgeErrors(res) {
    if (!res) return [];
    if (Array.isArray(res)) res = { ok: false, errors: res };
    const raw = res.errors || [];
    return raw.map((e) => {
      let p = e.path;
      if (Array.isArray(p)) p = pathKey(p);
      else if (typeof p !== 'string') p = '';
      if (!p && e.nodeId) {
        const hit = findAll(state.flow.nodes, (n, parts, out) => {
          if (n.id === e.nodeId) out.push(pathKey(parts));
        });
        p = hit[0] || '';
      }
      return { path: p || '', msg: e.msg || e.message || 'invalid' };
    });
  }

  /* ── summary text on cards ────────────────────────────────────────────── */

  function summaryOf(n) {
    const meta = TYPES[n.type];
    if (!meta) return '';
    if (n.type === 'if') {
      const c = n.cond || {};
      return [c.left, c.op, c.right].join(' ').trim() || '…';
    }
    if (n.type === 'loop') {
      return n.mode === 'count' ? `count ×${n.count || '?'}` :
        'while ' + [n.cond && n.cond.left, n.cond && n.cond.op, n.cond && n.cond.right].join(' ');
    }
    if (n.type === 'screenshot') return n.fullPage ? 'fullPage' : '';
    if (n.type === 'upload') return (n.files || []).join('; ');
    if (meta.sum) return String(n[meta.sum] == null ? '' : n[meta.sum]);
    return '';
  }

  /* ── render: state pill / errors / statusbar ──────────────────────────── */

  function renderStatePill() {
    const el = $('rap-state');
    if (!el) return;
    const dot = el.querySelector('.rap-state-dot');
    const txt = el.querySelector('.rap-state-text');
    el.classList.remove('is-valid', 'is-invalid');
    if (state.replaying) {
      txt.textContent = 'Replay';
      el.classList.add('is-valid');
    } else if (state.errors.length) {
      el.classList.add('is-invalid');
      txt.textContent = `无效 · ${state.errors.length}`;
    } else {
      el.classList.add('is-valid');
      txt.textContent = '有效';
    }
    if (dot) dot.setAttribute('aria-hidden', 'true');
  }

  function renderErrors() {
    const box = $('rap-errors');
    if (!box) return;
    if (!state.errors.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<div class="rap-errors-title">校验错误（点击跳转节点）</div>' +
      state.errors.map((e, i) =>
        `<button type="button" class="rap-err-item" data-err="${i}" data-path="${esc(e.path)}">` +
        `${esc(e.msg)}${e.path ? ' @ ' + esc(e.path) : ''}</button>`).join('');
  }

  function renderStatus() {
    const n = countNodes(state.flow.nodes);
    const d = depthOf(state.flow.nodes);
    const c = $('rap-count');
    if (c) c.textContent = `${n} 节点 · 深度 ${d}${state.arm != null ? ' · 目标分支已就绪' : ''}`;
    const ro = $('rap-ro');
    if (ro) ro.hidden = !state.replaying;
    const dirty = $('rap-dirty');
    if (dirty) dirty.classList.toggle('is-dirty', state.dirty);
  }

  function markDirty() {
    state.dirty = true;
    renderStatus();
    // async re-validate to keep the pill honest
    scheduleValidate();
  }

  let vTimer = null;
  function scheduleValidate() {
    clearTimeout(vTimer);
    vTimer = setTimeout(() => { runValidate(); }, 250);
  }

  /* ── render: canvas ───────────────────────────────────────────────────── */

  function renderCanvas() {
    const host = $('rap-canvas');
    const jsonTa = $('rap-json');
    if (!host) return;
    host.hidden = state.jsonMode;
    if (jsonTa) jsonTa.hidden = !state.jsonMode;
    if (state.jsonMode) return;

    const errSet = new Set(state.errors.map((e) => e.path));
    const html = state.flow.nodes.length
      ? renderList(state.flow.nodes, [], errSet)
      : `<div class="rap-empty">
           <div class="rap-empty-hint">从左侧添加第一个节点<br>
           <span style="opacity:.7">点击动作卡片追加，或拖入画布</span></div>
         </div>`;
    host.innerHTML = html;

    // refocus selection after re-render
    if (state.selected) {
      const el = host.querySelector(`[data-path="${cssEsc(state.selected)}"]`);
      if (el && document.activeElement && document.activeElement.dataset &&
          document.activeElement.dataset.path === state.selected) {
        el.focus();
      }
    }
  }

  function cssEsc(s) { return String(s).replace(/"/g, '\\"'); }

  function renderList(list, baseParts, errSet) {
    return list.map((n, i) => {
      const parts = baseParts.concat([i]);
      const key = pathKey(parts);
      const meta = TYPES[n.type] || { label: n.type, glyph: '?' };
      const selected = state.selected === key ? ' is-selected' : '';
      const bad = errSet.has(key) ? ' is-error' : '';
      const sum = summaryOf(n);
      let branches = '';
      if (meta.branches) {
        branches = '<div class="rap-branches" style="grid-template-columns:' +
          'repeat(' + meta.branches.length + ',minmax(0,1fr))">' +
          meta.branches.map((b) => {
            const childParts = parts.concat([b.key]);
            const childList = n[b.key] || [];
            const inner = childList.length
              ? renderList(childList, childParts, errSet)
              : '';
            return `<div class="rap-branch ${b.cls}">
              <div class="rap-branch-label">${esc(b.label)}</div>
              <div class="rap-branch-list" data-list="${esc(pathKey(childParts))}">
                ${inner}
                <button type="button" class="rap-empty-slot${state.arm === pathKey(childParts) ? ' is-target' : ''}"
                        data-arm="${esc(pathKey(childParts))}"
                        aria-label="向 ${esc(b.label)} 分支添加节点">＋ 添加到 ${esc(b.label)} 分支</button>
              </div>
            </div>`;
          }).join('') + '</div>';
      }
      return `<div class="rap-node-row">
        <div class="rap-node${selected}${bad}" data-path="${esc(key)}" data-type="${esc(n.type)}"
             role="button" tabindex="0"
             aria-label="节点 ${i + 1}: ${esc(meta.label)}${sum ? '，' + esc(sum) : ''}"
             aria-pressed="${selected ? 'true' : 'false'}">
          <div class="rap-node-head">
            <span class="rap-node-type" aria-hidden="true">${esc(meta.glyph)} ${esc(n.type)}</span>
            <span class="rap-node-title">${esc(meta.label)}</span>
            <span class="rap-node-sum" title="${esc(sum)}">${esc(sum)}</span>
            <span class="rap-node-idx" aria-hidden="true">#${i + 1}</span>
          </div>
          ${branches}
        </div>
      </div>`;
    }).join('');
  }

  /* ── render: inspector ────────────────────────────────────────────────── */

  function renderInspector() {
    const body = $('rap-insp-body');
    const title = $('rap-insp-title');
    if (!body) return;
    const n = state.selected ? getNode(state.selected) : null;

    if (!n) {
      if (title) title.textContent = '属性';
      body.innerHTML = '<div class="rap-insp-empty">选中画布中的节点以编辑属性。<br><br>' +
        '键盘：↑↓ 节点内重排，Delete 删除。</div>';
      return;
    }
    const meta = TYPES[n.type] || { label: n.type, S: [] };
    if (title) title.textContent = meta.label;

    let html = '';
    // structured cond for if / while-loop (rpa.md §6.1 — no eval)
    if (n.type === 'if') html += condHtml(n.cond, 'cond');
    if (n.type === 'loop') {
      html += fieldHtml({ k: 'mode', label: '模式', req: true, type: 'select',
        options: ['count', 'while'] }, n);
      if (n.mode === 'count') html += fieldHtml({ k: 'count', label: '次数（≤10000）', req: true, type: 'number' }, n);
      else html += condHtml(n.cond, 'cond');
    }
    for (const f of meta.S || []) {
      if (n.type === 'loop' && (f.k === 'mode' || f.k === 'count')) continue; // rendered above
      html += fieldHtml(f, n);
    }

    const ro = state.replaying ? ' disabled' : '';
    html += `<div class="rap-insp-actions">
      <button type="button" class="rap-btn" data-act="up"${ro}>↑ 上移</button>
      <button type="button" class="rap-btn" data-act="down"${ro}>↓ 下移</button>
      <button type="button" class="rap-btn" data-act="dup"${ro}>⧉ 复制</button>
      <button type="button" class="rap-btn rap-btn-danger" data-act="del"${ro}>✕ 删除</button>
    </div>`;

    if (meta.branches) {
      html += '<div class="rap-branch-btns">' + meta.branches.map((b) =>
        `<button type="button" class="rap-btn" data-arm="${esc(
          state.selected + ',' + b.key)}"${ro}>添加到 ${esc(b.label)}</button>`).join('') +
        `<span class="rap-branch-hint">${state.arm != null ? '目标分支已就绪：点左侧节点插入' : ''}</span></div>`;
    }

    body.innerHTML = html;
  }

  function fieldHtml(f, n) {
    const v = n[f.k];
    const ro = state.replaying ? ' readonly disabled' : '';
    const id = 'f_' + f.k;
    let ctl;
    const req = f.req ? ' <span class="req">*</span>' : '';
    if (f.type === 'select') {
      ctl = `<select id="${id}" data-f="${esc(f.k)}"${ro}>` +
        (f.options || []).map((o) =>
          `<option value="${esc(o)}"${String(v) === o ? ' selected' : ''}>${esc(o)}</option>`).join('') +
        `</select>`;
    } else if (f.type === 'textarea') {
      ctl = `<textarea id="${id}" data-f="${esc(f.k)}"${ro}>${esc(v)}</textarea>`;
    } else if (f.type === 'bool') {
      ctl = `<select id="${id}" data-f="${esc(f.k)}"${ro}>
        <option value=""${!v ? ' selected' : ''}>否</option>
        <option value="true"${v ? ' selected' : ''}>是</option></select>`;
    } else {
      const val = f.type === 'list' ? (v || []).join('; ') : (v == null ? '' : v);
      const inputmode = f.type === 'number' ? ' inputmode="numeric"' : '';
      ctl = `<input id="${id}" data-f="${esc(f.k)}" type="text"${inputmode} value="${esc(val)}"${ro}>`;
    }
    const missing = f.req && isEmptyField(f.type === 'list' ? v : v) ? ' is-missing' : '';
    return `<div class="rap-field${missing}"><label for="${id}">${esc(f.label)}${req}</label>${ctl}</div>`;
  }

  function condHtml(cond, key) {
    const c = cond || { left: '', op: '==', right: '' };
    const ro = state.replaying ? ' disabled' : '';
    return `<div class="rap-field"><label>条件（结构化 · 无 eval）</label>
      <div class="rap-cond">
        <input type="text" data-c="left" value="${esc(c.left)}" placeholder="left / $var"${ro} aria-label="条件左侧">
        <select data-c="op" aria-label="操作符"${ro}>${OPS.map((o) =>
          `<option${c.op === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>
        <input type="text" data-c="right" value="${esc(c.right)}" placeholder="right / $var"${ro} aria-label="条件右侧">
      </div></div>`;
  }

  /* ── render toolbar enablement ────────────────────────────────────────── */

  function renderChrome() {
    const b = state.bridge || {};
    const replayBtn = $('rap-replay');
    if (replayBtn) {
      replayBtn.disabled = !b.replay || state.replaying || state.recording;
      replayBtn.title = b.replay ? 'Replay 流程' : 'Replay 需要 bridge（window.rpaApi.replay）';
    }
    const recApi = recorderApi();
    const recBtn = $('rap-record');
    if (recBtn) {
      recBtn.disabled = !recApi || !recApi.start || state.recording || state.replaying;
      recBtn.title = (!recApi || !recApi.start)
        ? 'Record 需要 bridge（window.rpaApi.recorder.start）'
        : state.recording ? '录制进行中' : 'Record：捕获浏览器操作（不写入画布）';
    }
    const recStopBtn = $('rap-rec-stop');
    if (recStopBtn) {
      recStopBtn.disabled = !state.recording;
      recStopBtn.title = state.recording ? 'Stop：结束录制并解析 AST' : 'Stop 需要先开始录制';
    }
    const recState = $('rap-rec-state');
    if (recState) recState.hidden = !state.recording;
    const saveBtn = $('rap-save');
    if (saveBtn) {
      saveBtn.disabled = !b.save || state.replaying;
      saveBtn.title = b.save ? 'Save（Ctrl+S）' : 'Save 需要 bridge（window.rpaApi.save）';
    }
    const nameEl = $('rap-name');
    if (nameEl) nameEl.readOnly = state.replaying;
    state.root.classList.toggle('is-replaying', state.replaying);
    const endBtn = $('rap-log-end');
    if (endBtn) endBtn.hidden = !state.exId;
    const logBox = $('rap-log');
    if (logBox) logBox.hidden = !state.replaying;
  }

  function renderAll() {
    const nameEl = $('rap-name');
    if (nameEl && document.activeElement !== nameEl) nameEl.value = state.flow.name || '';
    renderCanvas();
    renderInspector();
    renderErrors();
    renderStatePill();
    renderStatus();
    renderChrome();
  }

  /* ── mutations ────────────────────────────────────────────────────────── */

  function appendNode(type, listKey) {
    if (state.replaying) return;
    const key = listKey != null ? listKey : (state.arm != null ? state.arm : '');
    const list = getList(parsePath(key));
    if (!list) return;
    list.push(makeNode(type));
    state.arm = null;
    state.selected = pathKey(parsePath(key).concat([list.length - 1]));
    markDirty();
    renderAll();
    // scroll new node into view
    const el = state.root.querySelector(`[data-path="${cssEsc(state.selected)}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function moveSelected(delta) {
    const ref = state.selected ? getRef(state.selected) : null;
    if (!ref || state.replaying) return;
    const j = ref.index + delta;
    if (j < 0 || j >= ref.list.length) return;
    const parts = parsePath(state.selected);
    ref.list.splice(j, 0, ref.list.splice(ref.index, 1)[0]);
    parts[parts.length - 1] = j;
    state.selected = pathKey(parts);
    markDirty();
    renderAll();
    const el = state.root.querySelector(`[data-path="${cssEsc(state.selected)}"]`);
    if (el) el.focus();
  }

  function deleteSelected() {
    const ref = state.selected ? getRef(state.selected) : null;
    if (!ref || state.replaying) return;
    ref.list.splice(ref.index, 1);
    state.selected = null;
    markDirty();
    renderAll();
  }

  function dupSelected() {
    const ref = state.selected ? getRef(state.selected) : null;
    if (!ref || state.replaying) return;
    const parts = parsePath(state.selected);
    ref.list.splice(ref.index + 1, 0, cloneWithIds(ref.node));
    parts[parts.length - 1] = ref.index + 1;
    state.selected = pathKey(parts);
    markDirty();
    renderAll();
  }

  function selectNode(key) {
    state.selected = key;
    renderCanvas();
    renderInspector();
  }

  /* ── JSON power-user view (two-way, validate on blur) ─────────────────── */

  function enterJson() {
    const ta = $('rap-json');
    if (!ta) return;
    ta.value = JSON.stringify(state.flow, null, 2);
    ta.classList.remove('is-bad');
    state.jsonMode = true;
    renderCanvas();
    renderChrome();
    const btn = $('rap-json-toggle');
    if (btn) { btn.classList.add('rap-btn-on'); btn.setAttribute('aria-pressed', 'true'); }
    ta.focus();
  }

  function exitJson() {
    const ta = $('rap-json');
    if (ta && !syncJsonFromTa()) return;   // bad JSON → stay in JSON view
    state.jsonMode = false;
    renderAll();
    const btn = $('rap-json-toggle');
    if (btn) { btn.classList.remove('rap-btn-on'); btn.setAttribute('aria-pressed', 'false'); }
  }

  function syncJsonFromTa() {
    const ta = $('rap-json');
    if (!ta || !state.jsonMode) return true;
    try {
      const parsed = JSON.parse(ta.value);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes)) {
        throw new Error('需要 { name, nodes[] }');
      }
      state.flow = { name: String(parsed.name || ''), nodes: parsed.nodes };
      resequenceIds(state.flow.nodes);
      ta.classList.remove('is-bad');
      markDirty();
      return true;
    } catch (e) {
      ta.classList.add('is-bad');
      state.errors = [{ path: '', msg: 'JSON: ' + (e && e.message || e) }];
      renderErrors();
      renderStatePill();
      return false;
    }
  }

  function resequenceIds(list) {
    findAll(list, (n) => { if (!n.id) n.id = uid(); else bumpSeq(n.id); });
  }
  function bumpSeq(id) {
    const m = /^n(\d+)_/.exec(id);
    if (m) state.seq = Math.max(state.seq, Number(m[1]));
  }

  /* ── recorder: live capture, no canvas writes until import (§4) ────────── */

  const REC_POLL_MS = 800;
  let demoRecorder = null;   // ?demo=1 only — keeps window.rpaApi clean

  // Session source: rpaApi.recorder (host) → automationApi.recorder (preload
  // facade, wired by panel.js) → demo mock. Absent everywhere = Record stays
  // disabled with an honest tooltip, same pattern as Replay/Save.
  function recorderApi() {
    return (state.bridge && state.bridge.recorder) ||
      (window.automationApi && window.automationApi.recorder) || demoRecorder;
  }

  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const p = (n) => String(n).padStart(2, '0');
    const m = Math.floor(s / 60);
    return (m >= 60 ? p(Math.floor(m / 60)) + ':' : '') + p(m % 60) + ':' + p(s % 60);
  }

  function recQualityBand(q) { return q >= 70 ? 'q-hi' : q >= 40 ? 'q-mid' : 'q-lo'; }

  function recRowHtml(n, i) {
    const meta = TYPES[n.type] || { label: n.type, glyph: '?' };
    const sel = n.type === 'wait' && n.kind === 'delay' && n.ms != null
      ? 'delay ' + n.ms + 'ms' : summaryOf(n);
    const chip = n.selectorType
      ? `<span class="rap-rec-chip ${recQualityBand(n.quality || 0)}">${esc(n.selectorType)} ${esc(n.quality)}</span>`
      : '';
    return `<div class="rap-rec-row" data-type="${esc(n.type)}">
      <span class="rap-rec-idx">${i + 1}</span>
      <span class="rap-rec-glyph" aria-hidden="true">${esc(meta.glyph)}</span>
      <span class="rap-rec-kind">${esc(meta.label)}</span>
      <span class="rap-rec-sel" title="${esc(sel)}">${esc(sel)}</span>
      ${chip}</div>`;
  }

  // recorder node → builder node: makeNode supplies schema defaults + a fresh id,
  // recorded fields overlay it; two vocabulary renames (scroll y→dy, wait ms→
  // timeout); unknown types dropped (bridge validate would reject them anyway).
  function normalizeRecorded(nodes) {
    const out = [];
    for (const raw of nodes || []) {
      if (!raw || !TYPES[raw.type]) continue;
      const n = Object.assign(makeNode(raw.type), raw);
      if (raw.type === 'scroll') {
        if (raw.dy == null && raw.y != null) n.dy = raw.y;
        delete n.y;
      }
      if (raw.type === 'wait') {
        if (raw.ms != null && (n.timeout == null || n.timeout === '')) n.timeout = String(raw.ms);
        delete n.ms;
      }
      out.push(n);
    }
    return out;
  }

  function announceRec(msg) {
    const live = $('rap-rec-live');
    if (live) live.textContent = msg;
  }

  function renderRecState() {
    const el = $('rap-rec-state');
    if (!el) return;
    el.hidden = !state.recording;
    const t = $('rap-rec-time');
    if (t) t.textContent = state.recording ? fmtElapsed(Date.now() - state.recStartTs) : '00:00';
    const a = $('rap-rec-count-t');
    if (a) a.textContent = state.recNodes.length + ' 节点';
    const b = $('rap-rec-pcount');
    if (b) b.textContent = state.recNodes.length + ' 节点';
  }

  // ponytail: row list grows with capture length (bounded by the recording);
  // add a render cap + windowing only if recordings routinely hit thousands.
  function renderRecList(batch, offset) {
    const box = $('rap-rec-list');
    if (!box) return;
    if (batch) {
      box.insertAdjacentHTML('beforeend',
        batch.map((n, i) => recRowHtml(n, (offset || 0) + i)).join(''));
    } else {
      box.innerHTML = state.recNodes.length
        ? state.recNodes.map((n, i) => recRowHtml(n, i)).join('')
        : '<div class="rap-rec-empty">尚未捕获事件。</div>';
    }
    box.scrollTop = box.scrollHeight;
  }

  function renderRecPanel() {
    const panel = $('rap-rec-panel');
    if (!panel) return;
    panel.hidden = !state.recording && !state.recNodes.length;
    const dot = panel.querySelector('.rap-rec-dot');
    if (dot) dot.hidden = !state.recording;
    const title = $('rap-rec-title');
    if (title) {
      title.textContent = state.recording ? '录制中'
        : state.recImported ? '已导入画布' : '已停止';
      title.classList.toggle('is-idle', !state.recording);
    }
    const imp = $('rap-rec-import');
    if (imp) {
      imp.disabled = state.recording || state.recImported || !state.recNodes.length;
      imp.title = state.recording ? 'Stop 后可导入'
        : state.recImported ? '已导入；Clear 后重新录制'
          : state.recNodes.length ? '把捕获节点写入画布（走既有节点路径）'
            : '无捕获节点';
    }
    const conf = $('rap-rec-confirm');
    if (conf) {
      const pend = state.pendingImport;
      conf.hidden = !pend;
      conf.innerHTML = pend
        ? `<span>画布已有 ${countNodes(state.flow.nodes)} 个节点，导入 ${pend.length} 个：</span>
           <button class="rap-btn" type="button" data-rec-act="replace">Replace</button>
           <button class="rap-btn" type="button" data-rec-act="append">Append</button>
           <button class="rap-btn" type="button" data-rec-act="cancel">Cancel</button>`
        : '';
    }
    renderRecList();
    renderRecState();
  }

  function startRecPolling() {
    stopRecPolling();
    state.recPoll = setInterval(pollRec, REC_POLL_MS);
    state.recTimer = setInterval(renderRecState, 1000);
  }

  function stopRecPolling() {
    if (state.recPoll) { clearInterval(state.recPoll); state.recPoll = null; }
    if (state.recTimer) { clearInterval(state.recTimer); state.recTimer = null; }
  }

  async function pollRec() {
    const rec = recorderApi();
    if (!state.recording || !rec || !rec.drain) return;
    try {
      const res = await rec.drain(state.recId);
      // channel contract = {nodes, count}; the live engine returns a bare array
      const got = Array.isArray(res) ? res : (res && Array.isArray(res.nodes)) ? res.nodes : [];
      if (!got.length) return;
      const seen = state.recNodes.length;
      state.recNodes = state.recNodes.concat(got);
      renderRecList(got, seen);
      renderRecState();
      announceRec('已捕获 ' + state.recNodes.length + ' 个节点');
    } catch (_) { /* transient drain error — keep polling, list keeps last state */ }
  }

  async function doRecord() {
    const rec = recorderApi();
    if (!rec || !rec.start || state.recording || state.replaying) return;
    try {
      const res = await rec.start({});
      const sessionId = res && res.sessionId;
      if (!sessionId) throw new Error('recorder.start 未返回 sessionId');
      state.recording = true;
      state.recId = sessionId;
      state.recNodes = [];
      state.recImported = false;
      state.pendingImport = null;
      state.recStartTs = Date.now();
      startRecPolling();
      renderAll();
      renderRecPanel();
      announceRec('已开始录制');
    } catch (e) {
      state.recording = false; state.recId = null;
      flashError('Record 失败: ' + (e && e.message || e));
    }
  }

  async function doRecStop() {
    if (!state.recording) return;
    const rec = recorderApi();
    stopRecPolling();
    state.recording = false;
    let nodes = [];
    try {
      const res = await rec.stop(state.recId);
      const ast = (res && res.ast) || res;
      if (ast && Array.isArray(ast.nodes)) nodes = normalizeRecorded(ast.nodes);
    } catch (e) {
      flashError('Stop 失败: ' + (e && e.message || e));
    }
    // stop() drained nothing but the poll did — the list is still importable
    if (!nodes.length && state.recNodes.length) nodes = normalizeRecorded(state.recNodes);
    state.recId = null;
    if (nodes.length) {
      state.recNodes = nodes;
      if (state.flow.nodes.length) state.pendingImport = nodes;  // ask (inline)
      else applyImport(nodes, 'replace');                        // empty canvas
    }
    renderAll();
    renderRecPanel();
    announceRec(nodes.length ? '录制已停止，共 ' + nodes.length + ' 个节点' : '录制已停止，未捕获节点');
  }

  // Import always goes through the normal node path: real nodes in state.flow,
  // then renderAll + validate — selection/inspector/JSON view keep working.
  function applyImport(nodes, mode) {
    state.recImported = true;
    state.pendingImport = null;
    const name = state.flow.name;
    if (mode === 'append') state.flow.nodes = state.flow.nodes.concat(nodes);
    else state.flow = { name: name || '录制的流程', nodes };
    state.selected = null;
    state.arm = null;
    markDirty();
    const ta = $('rap-json');
    if (state.jsonMode && ta) ta.value = JSON.stringify(state.flow, null, 2);
    renderAll();
    runValidate();
    renderRecPanel();
    const first = state.root.querySelector('[data-path="0"]');
    if (first && first.scrollIntoView) first.scrollIntoView({ block: 'nearest' });
  }

  function doImportClick() {
    if (state.recording || state.recImported || !state.recNodes.length) return;
    if (state.flow.nodes.length) {
      state.pendingImport = state.recNodes.slice();
      renderRecPanel();
    } else {
      applyImport(state.recNodes.slice(), 'replace');
    }
  }

  function clearRec() {
    state.recNodes = [];
    state.pendingImport = null;
    state.recImported = false;
    renderRecPanel();
  }

  // ?demo=1: mimics recorder.{start,drain,stop,state} — 2 nodes per 800ms poll
  // lands the whole 6-node flow in ~2.4s; Stop → Import exercises the loop.
  function createDemoRecorder() {
    const ALL = [
      { type: 'goto', url: 'https://example.com/login' },
      { type: 'fill', selector: '#username', selectorType: 'id', quality: 90, value: 'demo' },
      { type: 'press', selector: '#username', selectorType: 'id', quality: 90, key: 'Enter' },
      { type: 'click', selector: 'button[type="submit"]', selectorType: 'css', quality: 40 },
      { type: 'scroll', selector: '#list', selectorType: 'css', quality: 40, y: 400, toEnd: false },
      { type: 'wait', kind: 'delay', ms: 1500 },
    ];
    let idx = 0;
    return {
      start: () => {
        idx = 0;
        return Promise.resolve({ sessionId: 'rec-demo', url: ALL[0].url });
      },
      drain: () => {
        const n = ALL.slice(idx, idx + 2);
        idx += n.length;
        return Promise.resolve({ nodes: n, count: n.length });
      },
      stop: () => Promise.resolve({
        ast: { nodes: ALL.slice(0, idx), meta: { recordedAt: Date.now(), url0: ALL[0].url } },
      }),
      state: () => ({ active: idx < ALL.length, sessions: [{ id: 'rec-demo' }], nodes: ALL.slice(0, idx) }),
    };
  }

  /* ── bridge calls ─────────────────────────────────────────────────────── */

  async function doSave() {
    if (!state.bridge || !state.bridge.save || state.replaying) return;
    if (state.jsonMode && !syncJsonFromTa()) return;
    const ok = await runValidate();
    if (!ok) { flashError('校验未通过，先修复错误'); return; }
    try {
      const saved = await state.bridge.save(state.flow);
      if (saved && saved.nodes) state.flow = saved;
      state.dirty = false;
      renderAll();
    } catch (e) {
      flashError('Save 失败: ' + (e && e.message || e));
    }
  }

  async function doReplay() {
    if (!state.bridge || !state.bridge.replay || state.replaying) return;
    if (state.jsonMode && !syncJsonFromTa()) return;
    const ok = await runValidate();
    if (!ok) { flashError('校验未通过，先修复错误'); return; }
    state.replaying = true;
    state.exId = null;
    const logBox = $('rap-log');
    if (logBox) logBox.innerHTML = '';
    renderAll();
    try {
      const res = await state.bridge.replay(state.flow);
      state.exId = (res && res.executionId) || null;
      if (state.bridge.subscribeLog) {
        try {
          state.unsub = state.bridge.subscribeLog(state.exId || state.flow.name || '', appendLog);
        } catch (_) { /* bridge shape differs; log view stays empty */ }
      }
      if (!state.exId) appendLog({ level: 'info', text: 'replay 已提交' });
    } catch (e) {
      appendLog({ level: 'error', text: 'replay 失败: ' + (e && e.message || e) });
      endReplay();
    }
    renderChrome();
    renderInspector();
  }

  function endReplay() {
    if (state.unsub) { try { state.unsub(); } catch (_) {} state.unsub = null; }
    state.replaying = false;
    state.exId = null;
    renderAll();
  }

  function appendLog(line) {
    const box = $('rap-log');
    if (!box) return;
    const lv = (line && line.level) || 'info';
    const text = esc(line && line.text != null ? line.text : String(line));
    const ts = line && line.ts ? new Date(line.ts).toLocaleTimeString() + ' ' : '';
    const div = document.createElement('div');
    div.className = 'lv-' + esc(lv);
    div.textContent = ts + '[' + lv + '] ' + (line && line.text != null ? line.text : String(line));
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    void text;
  }

  function flashError(msg) {
    state.errors = [{ path: '', msg }];
    renderErrors();
    renderStatePill();
  }

  function exportJson() {
    const data = JSON.stringify(state.flow, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.flow.name || 'flow') + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function importJson(file, cb) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const parsed = JSON.parse(String(r.result));
        if (!parsed || !Array.isArray(parsed.nodes)) throw new Error('需要 { name, nodes[] }');
        state.flow = { name: String(parsed.name || file.name.replace(/\.json$/i, '')),
                       nodes: parsed.nodes };
        resequenceIds(state.flow.nodes);
        state.selected = null;
        state.dirty = true;
        renderAll();
        cb(null);
      } catch (e) { cb(e); }
    };
    r.onerror = () => cb(new Error('读取失败'));
    r.readAsText(file);
  }

  /* ── shell / wiring ───────────────────────────────────────────────────── */

  const SHELL = `
    <div class="rap-toolbar">
      <input id="rap-name" class="rap-name" type="text" placeholder="流程名"
             aria-label="流程名" spellcheck="false">
      <span id="rap-state" class="rap-state" role="status" aria-live="polite">
        <span class="rap-state-dot"></span><span class="rap-state-text">—</span>
      </span>
      <span id="rap-dirty" class="rap-dirty" title="未保存更改">●</span>
      <span class="rap-toolbar-spacer"></span>
      <button id="rap-validate" class="rap-btn" type="button" title="结构校验">✓ Validate</button>
      <button id="rap-record" class="rap-btn rap-btn-rec" type="button">● Record</button>
      <button id="rap-rec-stop" class="rap-btn" type="button" disabled>■ Stop</button>
      <span id="rap-rec-state" class="rap-rec-state" hidden>
        <span class="rap-rec-dot" aria-hidden="true"></span>
        <span class="rap-rec-label">REC</span>
        <span id="rap-rec-time" class="rap-rec-time" aria-hidden="true">00:00</span>
        <span id="rap-rec-count-t" class="rap-rec-count" aria-hidden="true">0 节点</span>
      </span>
      <button id="rap-replay" class="rap-btn rap-btn-run" type="button">▶ Replay</button>
      <button id="rap-save" class="rap-btn rap-btn-primary" type="button" title="Save (Ctrl+S)">Save</button>
      <button id="rap-export" class="rap-btn" type="button">Export JSON</button>
      <button id="rap-import" class="rap-btn" type="button">Import JSON</button>
      <button id="rap-json-toggle" class="rap-btn" type="button" aria-pressed="false"
              title="高级用户：直接编辑 JSON">JSON</button>
      <input id="rap-import-file" type="file" accept="application/json,.json" hidden>
      <span id="rap-rec-live" class="rap-sr-only" role="status" aria-live="polite"></span>
    </div>
    <div id="rap-bridge" class="rap-bridge-banner" hidden>
      RPA bridge not available — editing works locally; Replay/Save disabled.
    </div>
    <div id="rap-errors" class="rap-errors" role="alert" hidden></div>
    <div class="rap-main">
      <nav id="rap-palette" class="rap-palette" aria-label="节点面板"></nav>
      <div class="rap-canvas-wrap">
        <div id="rap-canvas" class="rap-canvas" data-list="" aria-label="流程画布"></div>
        <textarea id="rap-json" class="rap-json" hidden spellcheck="false"
                  aria-label="流程 JSON"></textarea>
        <div id="rap-rec-panel" class="rap-rec-panel" role="region"
             aria-label="录制捕获" hidden>
          <div class="rap-rec-head">
            <span class="rap-rec-dot" aria-hidden="true"></span>
            <span id="rap-rec-title" class="rap-rec-title">录制中</span>
            <span id="rap-rec-pcount" class="rap-rec-pcount">0 节点</span>
            <span class="rap-rec-spacer"></span>
            <button id="rap-rec-import" class="rap-btn" type="button">Import to canvas</button>
            <button id="rap-rec-clear" class="rap-btn" type="button">Clear</button>
          </div>
          <div id="rap-rec-confirm" class="rap-rec-confirm" role="group"
               aria-label="导入方式" hidden></div>
          <div id="rap-rec-list" class="rap-rec-list"></div>
        </div>
        <div id="rap-log" class="rap-log" hidden aria-label="回放日志" aria-live="polite">
          <button id="rap-log-end" class="rap-btn" type="button" hidden
                  style="float:right;margin:0 0 4px 8px">结束回放</button>
        </div>
      </div>
      <aside class="rap-inspector" aria-label="节点属性">
        <div class="rap-insp-head">
          <span id="rap-insp-title">属性</span>
          <button id="rap-sheet" class="rap-btn rap-sheet-toggle" type="button"
                  aria-expanded="true" aria-controls="rap-insp-body">▾</button>
        </div>
        <div id="rap-insp-body" class="rap-insp-body"></div>
      </aside>
    </div>
    <footer class="rap-statusbar">
      <span id="rap-ro" class="rap-ro-badge" hidden>READONLY</span>
      <span id="rap-count" class="rap-count">0 节点</span>
      <span class="rap-status-spacer"></span>
      <span>RPA → AST · 同一 Runtime（rpa.md）</span>
    </footer>`;

  function renderPalette() {
    const nav = $('rap-palette');
    if (!nav) return;
    let html = '';
    for (const g of GROUP_ORDER) {
      const items = Object.keys(TYPES).filter((t) => TYPES[t].group === g);
      if (!items.length) continue;
      html += `<div class="rap-pal-group-title" role="presentation">${esc(g)}</div>`;
      for (const t of items) {
        const m = TYPES[t];
        html += `<button type="button" class="rap-pal-item" draggable="true"
                  data-type="${esc(t)}" aria-label="添加节点：${esc(m.label)}（${esc(g)}）">
                  <span class="rap-pal-glyph" aria-hidden="true">${esc(m.glyph)}</span>
                  <span class="rap-pal-label">${esc(m.label)}</span></button>`;
      }
    }
    nav.innerHTML = html;
  }

  function wire() {
    const root = state.root;

    // palette: click-to-append + drag
    $('rap-palette').addEventListener('click', (e) => {
      const btn = e.target.closest('.rap-pal-item');
      if (btn) appendNode(btn.dataset.type);
    });
    $('rap-palette').addEventListener('dragstart', (e) => {
      const btn = e.target.closest('.rap-pal-item');
      if (!btn) return;
      e.dataTransfer.setData('text/rpa-type', btn.dataset.type);
      e.dataTransfer.effectAllowed = 'copy';
    });

    // canvas: select / arm / drop / keyboard
    const canvas = $('rap-canvas');
    canvas.addEventListener('click', (e) => {
      const armEl = e.target.closest('[data-arm]');
      if (armEl) {
        state.arm = armEl.dataset.arm;
        renderCanvas(); renderInspector(); renderStatus();
        return;
      }
      const card = e.target.closest('.rap-node');
      if (card) selectNode(card.dataset.path);
    });
    canvas.addEventListener('dragover', (e) => {
      if (e.target.closest('[data-list]')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
    });
    canvas.addEventListener('drop', (e) => {
      const zone = e.target.closest('[data-list]');
      if (!zone) return;
      e.preventDefault();
      const type = e.dataTransfer.getData('text/rpa-type');
      if (TYPES[type]) appendNode(type, zone.dataset.list);
    });
    canvas.addEventListener('keydown', (e) => {
      const card = e.target.closest('.rap-node');
      if (!card) return;
      if (e.target !== card) return;   // keep typing in nested inputs free
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); selectNode(card.dataset.path);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (state.selected !== card.dataset.path) selectNode(card.dataset.path);
        deleteSelected();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (state.selected !== card.dataset.path) selectNode(card.dataset.path);
        moveSelected(-1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (state.selected !== card.dataset.path) selectNode(card.dataset.path);
        moveSelected(1);
      }
    });

    // inspector: field edits + actions + branch arming
    const insp = $('rap-insp-body');
    insp.addEventListener('input', onInspField);
    insp.addEventListener('change', onInspField);
    insp.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act) {
        const a = act.dataset.act;
        if (a === 'up') moveSelected(-1);
        else if (a === 'down') moveSelected(1);
        else if (a === 'del') deleteSelected();
        else if (a === 'dup') dupSelected();
        return;
      }
      const armEl = e.target.closest('[data-arm]');
      if (armEl) {
        state.arm = armEl.dataset.arm;
        renderCanvas(); renderInspector(); renderStatus();
      }
    });

    function onInspField(e) {
      const t = e.target;
      const n = state.selected ? getNode(state.selected) : null;
      if (!n || state.replaying) return;
      if (t.dataset.c) {                       // cond grammar
        if (!n.cond) n.cond = { left: '', op: '==', right: '' };
        n.cond[t.dataset.c] = t.value;
      } else if (t.dataset.f) {
        const k = t.dataset.f;
        const schema = (TYPES[n.type].S || []).concat(
          n.type === 'loop' ? [{ k: 'mode', type: 'select' }, { k: 'count', type: 'number' }] : [])
          .find((f) => f.k === k) || {};
        if (schema.type === 'list') n[k] = t.value.split(';').map((s) => s.trim()).filter(Boolean);
        else if (schema.type === 'number') n[k] = t.value === '' ? '' : (Number(t.value) || t.value);
        else if (schema.type === 'bool') n[k] = t.value === 'true';
        else n[k] = t.value;
        if (k === 'mode') { renderInspector(); }
      }
      markDirty();
      renderCanvas();                          // refresh summary on card
      // keep focus: re-render inspector only when structure changed (mode)
    }

    // toolbar
    $('rap-validate').addEventListener('click', () => runValidate());
    $('rap-record').addEventListener('click', doRecord);
    $('rap-rec-stop').addEventListener('click', doRecStop);
    $('rap-replay').addEventListener('click', doReplay);
    $('rap-save').addEventListener('click', doSave);
    $('rap-export').addEventListener('click', exportJson);
    $('rap-import').addEventListener('click', () => $('rap-import-file').click());
    $('rap-import-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      importJson(f, (err) => {
        if (err) flashError('Import 失败: ' + err.message);
        else runValidate();
      });
      e.target.value = '';
    });
    $('rap-json-toggle').addEventListener('click', () => {
      if (state.jsonMode) exitJson(); else enterJson();
    });
    $('rap-json').addEventListener('blur', () => { syncJsonFromTa(); });
    $('rap-name').addEventListener('input', (e) => {
      state.flow.name = e.target.value;
      markDirty();
    });
    $('rap-log-end').addEventListener('click', endReplay);

    // recorder panel: import / clear / inline replace-or-append confirm
    $('rap-rec-import').addEventListener('click', doImportClick);
    $('rap-rec-clear').addEventListener('click', clearRec);
    $('rap-rec-confirm').addEventListener('click', (e) => {
      const act = e.target.closest('[data-rec-act]');
      if (!act) return;
      const mode = act.dataset.recAct;
      if (mode === 'cancel') { state.pendingImport = null; renderRecPanel(); return; }
      applyImport((state.pendingImport || state.recNodes).slice(), mode);
    });

    // error list → jump to node
    $('rap-errors').addEventListener('click', (e) => {
      const item = e.target.closest('[data-err]');
      if (!item) return;
      const key = item.dataset.path;
      if (!key) return;
      selectNode(key);
      const el = canvas.querySelector(`[data-path="${cssEsc(key)}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
    });

    // mobile bottom sheet toggle
    $('rap-sheet').addEventListener('click', (e) => {
      const sheet = root.querySelector('.rap-inspector');
      const collapsed = sheet.classList.toggle('is-collapsed');
      e.currentTarget.textContent = collapsed ? '▴' : '▾';
      e.currentTarget.setAttribute('aria-expanded', String(!collapsed));
    });

    // shortcuts
    root.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault(); doSave();
      }
    });
  }

  /* ── demo sample (?demo=1): linear goto→wait→fill→click→readText→if ──── */

  function demoFlow() {
    const mk = (type, fields) => Object.assign(makeNode(type), fields);
    return {
      name: '示例流程',
      nodes: [
        mk('goto', { url: 'https://example.com/login' }),
        mk('wait', { kind: 'visible', selector: '#username', timeout: 10000 }),
        mk('fill', { selector: '#username', value: 'demo' }),
        mk('click', { selector: 'button[type=submit]' }),
        mk('readText', { selector: 'h1', var: 'title' }),
        mk('if', { cond: { left: '$title', op: 'contains', right: '欢迎' } }),
      ],
    };
  }

  /* ── mount / unmount ──────────────────────────────────────────────────── */

  function mount(container) {
    if (state.mounted) unmount();
    const root = state.root = document.createElement('div');
    root.className = 'rap-panel';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'RPA flow builder');
    root.innerHTML = SHELL;
    (container || document.body).appendChild(root);
    state.mounted = true;

    renderPalette();
    wire();

    state.bridge = window.rpaApi || null;
    $('rap-bridge').hidden = !!state.bridge;

    const wantsDemo = /[?&]demo=1/.test(location.search);
    if (wantsDemo && !recorderApi()) demoRecorder = createDemoRecorder();
    if (wantsDemo) {
      state.flow = demoFlow();
      state.dirty = false;
      renderAll();
      runValidate();
    } else if (state.bridge && state.bridge.load) {
      state.flow = { name: '', nodes: [] };
      renderAll();
      state.bridge.load().then((flow) => {
        if (flow && Array.isArray(flow.nodes)) {
          state.flow = { name: String(flow.name || ''), nodes: flow.nodes };
          resequenceIds(state.flow.nodes);
        }
        renderAll();
        runValidate();
      }).catch((e) => {
        renderAll();
        flashError('load 失败: ' + (e && e.message || e));
      });
    } else {
      renderAll();
      runValidate();
    }
  }

  function unmount() {
    if (state.unsub) { try { state.unsub(); } catch (_) {} }
    clearTimeout(vTimer);
    stopRecPolling();
    if (state.recording) {
      const rec = recorderApi();           // best effort: never orphan a session
      if (rec && rec.stop) { try { rec.stop(state.recId); } catch (_) {} }
    }
    state.recording = false; state.recId = null; state.recNodes = [];
    state.pendingImport = null; state.recImported = false; state.recStartTs = 0;
    demoRecorder = null;
    if (state.root) state.root.remove();
    state.mounted = false; state.root = null;
    state.selected = null; state.arm = null;
    state.dirty = false; state.errors = [];
    state.replaying = false; state.exId = null; state.unsub = null;
    state.jsonMode = false;
    state.flow = { name: '', nodes: [] };
  }

  window.RpaBuilder = { mount, unmount };

  function boot() {
    const el = document.getElementById('rpa-builder');
    if (el && !state.mounted) mount(el);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
