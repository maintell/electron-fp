'use strict';
/* ============================================================================
 * Automation Script Panel (Phase 3) — renderer-only module. No Node requires.
 *
 * Mount: <div id="automation-panel"></div> + <script src="panel.js">, or
 *        AutomationPanel.mount(el) / AutomationPanel.unmount().
 * Demo:  open panel.html?demo=1 (installs a mock bridge when none exists).
 *
 * ── window.automationApi contract (bridge provided by preload/main) ────────
 * All methods return Promises. Panel degrades gracefully when absent.
 *
 *  getScripts(): Promise<Script[]>
 *      Script = { id: string, name: string, version: number,
 *                 status: 'draft'|'published'|'archived',
 *                 folder?: 'main'|'utils',          // client-side grouping only
 *                 code: string,
 *                 params?: ScriptParameter[],
 *                 updatedAt?: number }
 *
 *  saveScript(draft): Promise<Script>
 *      draft = { id?: string|null, name: string, code: string,
 *                folder?: string, params?: ScriptParameter[] }
 *      No id => create new; returns the persisted Script (version bumps).
 *
 *  runScript(scriptId: string, params: Record<string, unknown>)
 *      : Promise<{ executionId: string }>
 *
 *  stopScript(executionId: string): Promise<void>
 *
 *  pauseScript?(executionId: string): Promise<void>     // OPTIONAL — Pause
 *      button is disabled with a tooltip when the bridge omits it.
 *
 *  getExecutions(scriptId?: string): Promise<Execution[]>
 *      Execution (ExecutionRecord, script-sdk §6.2) =
 *        { id, scriptVersion, profileId, startTime, endTime, duration,
 *          status: 'CREATED'|'QUEUED'|'RUNNING'|'SUCCEEDED'|'FAILED'
 *                |'CANCELLED'|'RETRYING',
 *          error: { type, code, message, retriable }|null,
 *          stack: string|null, currentUrl: string|null, currentStep: number }
 *
 *  getLogs(executionId: string, opts?: { afterSeq?: number, limit?: number })
 *      : Promise<LogLine[]>
 *
 *  subscribeLog(executionId: string, cb: (line: LogLine) => void): () => void
 *      Live push of log lines; returns an unsubscribe function.
 *
 *  templates?: { list(): Promise<templateMeta[]>,
 *                install(): Promise<{ installed: string[], skipped: number }> }
 *      OPTIONAL — panel-templates.js fragment mounts into #ap-templates when
 *      the host page provides it. templateMeta = { key, name, description,
 *      category, permissions, parameters, code }.
 *
 *  tasks?: { list(opts?): Promise<TaskItem[]>, get(id): Promise<TaskItem>,
 *            cancel(id): Promise<TaskItem>, pause(id, opts?): Promise<TaskItem>,
 *            resume(id): Promise<TaskItem>, retry(id, opts?): Promise<TaskItem>,
 *            enqueue(spec): Promise<TaskItem> }
 *      OPTIONAL — Tasks view. list opts = { status?, scriptId?, limit?, offset? }.
 *      TaskItem = { id, scriptId, version?, params?, profileContext,
 *                   status: task.md §3 (12 states), attempts, maxAttempts,
 *                   nextRunAt, lastError: {name,message,retriable}|null,
 *                   createdAt, updatedAt, priority, result? }
 *      Illegal transitions reject (CONFLICT) — surfaced in the error strip.
 *
 *  schedules?: { list(opts?): Promise<Schedule[]>, add(spec): Promise<Schedule>,
 *                pause(id): Promise<Schedule>, resume(id): Promise<Schedule>,
 *                trigger(id): Promise<Schedule>, remove(id): Promise<void> }
 *      OPTIONAL — Schedules view. list opts = { enabled?, limit?, offset? }.
 *      Schedule (scheduler.md §2) = { id, name?, scriptId, type:
 *      'once'|'interval'|'cron', atMs?/everyMs?/cron?, profileContexts: [],
 *      enabled, state: 'active'|'paused'|'done', lastFiredAt?, nextRunAt?,
 *      maxAttempts?, priority?, createdAt, updatedAt }
 *
 *  getExecution?(id): Promise<Execution>   // OPTIONAL — full record for the
 *      detail pane (artifacts[] only come from here; the list shape strips them)
 *
 *  Execution.artifacts?: Artifact[]        // failure-only (SUCCESS never)
 *      Artifact = { ts, kind: 'screenshot'|…, bytes?, error?, path?, dataUrl? }
 *
 *  LogLine = { seq: number, ts: number,   // epoch ms
 *              level: 'debug'|'info'|'warn'|'error', text: string }
 *
 *  ScriptParameter (script-sdk §2.6) =
 *    { name: string,
 *      type: 'string'|'number'|'boolean'|'select'|'multi-select'
 *          |'secret'|'file'|'textarea'|'json',
 *      required?: boolean, default?: unknown, options?: string[],
 *      secret?: boolean }
 * ========================================================================== */

(function () {
  /* ── editor facade (textarea base + optional Monaco) ─────────────────── */

  function posOf(ta) {
    const upTo = ta.value.slice(0, ta.selectionStart);
    return { line: upTo.split('\n').length, col: upTo.length - upTo.lastIndexOf('\n') };
  }

  function createTextareaEditor(host) {
    const ta = document.createElement('textarea');
    ta.className = 'ap-code';
    ta.spellcheck = false;
    ta.setAttribute('aria-label', 'Script source editor');
    ta.placeholder = '// select or create a script';
    host.appendChild(ta);

    const change = [], cursor = [];
    const emit = (arr) => arr.forEach((f) => f());
    ta.addEventListener('input', () => emit(change));
    ['keyup', 'click', 'select'].forEach((ev) => ta.addEventListener(ev, () => emit(cursor)));

    return {
      kind: 'textarea',
      el: ta,
      getValue: () => ta.value,
      setValue: (v) => { ta.value = v == null ? '' : String(v); emit(change); emit(cursor); },
      focus: () => ta.focus(),
      setReadonly: (ro) => { ta.readOnly = !!ro; },
      getPosition: () => posOf(ta),
      onDidChange: (fn) => change.push(fn),
      onCursor: (fn) => cursor.push(fn),
      // Tab key: insert two spaces, keep caret inside the inserted run
      handleTab: () => {
        const s = ta.selectionStart, e = ta.selectionEnd, ins = '  ';
        ta.value = ta.value.slice(0, s) + ins + ta.value.slice(e);
        ta.selectionStart = ta.selectionEnd = s + ins.length;
        emit(change); emit(cursor);
      },
      dispose: () => ta.remove(),
    };
  }

  /* window.__mountMonaco — hook for future offline Monaco bundling.
     Load monaco, set window.monaco + window.monacoAvailable = true, then the
     panel (or any host) calls this. Returns the same facade shape as the
     textarea fallback, or null when Monaco is unavailable. */
  window.__mountMonaco = function (container, opts) {
    if (!window.monacoAvailable || !window.monaco || !window.monaco.editor) return null;
    const change = [], cursor = [];
    const ed = window.monaco.editor.create(container, Object.assign({
      value: '', language: 'javascript', theme: 'vs-dark',
      automaticLayout: true, fontSize: 12, minimap: { enabled: false },
    }, opts || {}));
    ed.onDidChangeModelContent(() => change.forEach((f) => f()));
    ed.onDidChangeCursorPosition(() => cursor.forEach((f) => f()));
    return {
      kind: 'monaco',
      el: container,
      getValue: () => ed.getValue(),
      setValue: (v) => ed.setValue(v == null ? '' : String(v)),
      focus: () => ed.focus(),
      setReadonly: (ro) => ed.updateOptions({ readOnly: !!ro }),
      getPosition: () => { const p = ed.getPosition(); return { line: p.lineNumber, col: p.column }; },
      onDidChange: (fn) => change.push(fn),
      onCursor: (fn) => cursor.push(fn),
      handleTab: () => ed.trigger('ap', 'indent', null), // noop-ish; Tab handled by monaco
      dispose: () => ed.dispose(),
    };
  };

  /* ── shell ───────────────────────────────────────────────────────────── */

  const SHELL = `
    <div class="ap-views" role="tablist" aria-label="Automation views">
      <button class="ap-view-tab" role="tab" id="ap-vt-scripts" data-view="scripts"
              aria-controls="ap-view-scripts" aria-selected="true" type="button">Scripts</button>
      <button class="ap-view-tab" role="tab" id="ap-vt-tasks" data-view="tasks" tabindex="-1"
              aria-controls="ap-view-tasks" aria-selected="false" type="button">Tasks</button>
      <button class="ap-view-tab" role="tab" id="ap-vt-schedules" data-view="schedules" tabindex="-1"
              aria-controls="ap-view-schedules" aria-selected="false" type="button">Schedules</button>
      <button class="ap-view-tab" role="tab" id="ap-vt-api" data-view="api" tabindex="-1"
              aria-controls="ap-view-api" aria-selected="false" type="button">API</button>
    </div>
    <div id="ap-bridge" class="ap-bridge-banner" hidden>Automation bridge not available — editing works locally; Run/Save disabled.</div>
    <div id="ap-banner" class="ap-banner" role="alert" hidden>
      <button class="ap-banner-close" type="button" aria-label="Dismiss error">×</button>
      <span id="ap-banner-text"></span>
    </div>
    <section id="ap-view-scripts" class="ap-view" role="tabpanel" aria-labelledby="ap-vt-scripts">
    <div class="ap-toolbar">
      <input id="ap-name" class="ap-name" type="text" placeholder="Script name"
             aria-label="Script name" spellcheck="false">
      <span id="ap-version" class="ap-version" title="Saved version">—</span>
      <span class="ap-toolbar-spacer"></span>
      <button id="ap-run" class="ap-btn ap-btn-run" title="Run (Ctrl+Enter)" type="button">▶ Run</button>
      <button id="ap-stop" class="ap-btn ap-btn-danger" title="Stop execution" type="button" disabled>■ Stop</button>
      <button id="ap-pause" class="ap-btn ap-btn-pause" title="Pause execution" type="button">⏸ Pause</button>
      <button id="ap-save" class="ap-btn ap-btn-primary" title="Save (Ctrl+S)" type="button">Save</button>
      <span id="ap-pill" class="ap-pill" role="status" aria-live="polite">
        <span class="ap-pill-dot"></span><span class="ap-spin" aria-hidden="true"></span>
        <span id="ap-pill-text">Ready</span>
      </span>
    </div>
    <div class="ap-main">
      <nav class="ap-files" aria-label="Script files">
        <div class="ap-files-title">Files</div>
        <div id="ap-tree" class="ap-tree"></div>
        <button id="ap-new" class="ap-tree-new" type="button">+ New</button>
      </nav>
      <section class="ap-editor-wrap" aria-label="Editor">
        <div id="ap-editor" class="ap-editor"></div>
        <div id="ap-empty" class="ap-empty" hidden>
          <div class="ap-empty-hint">No script selected.<br>Create one to start editing.</div>
          <button id="ap-empty-new" class="ap-btn ap-btn-primary" type="button">＋ 新建 Script</button>
        </div>
      </section>
      <aside class="ap-dock" aria-label="Tool dock">
        <div class="ap-dock-tabs" role="tablist">
          <button class="ap-dock-tab" role="tab" data-pane="console" aria-selected="true" type="button">Console</button>
          <button class="ap-dock-tab" role="tab" data-pane="params" aria-selected="false" type="button">Params</button>
          <button class="ap-dock-tab" role="tab" data-pane="execs" aria-selected="false" type="button">Executions<span id="ap-exec-badge" class="ap-dock-badge" hidden>0</span></button>
          <button class="ap-dock-tab" role="tab" data-pane="detail" aria-selected="false" type="button" disabled
                  title="先选择一条 execution">Detail</button>
        </div>
        <div class="ap-dock-body">
          <div id="ap-pane-console" class="ap-dock-pane is-active" role="tabpanel">
            <div class="ap-pane-head">
              <span>Log</span>
              <button id="ap-console-clear" class="ap-icon-btn" type="button" title="Clear console" aria-label="Clear console">⌫</button>
            </div>
            <div id="ap-console" class="ap-console" aria-live="polite"></div>
          </div>
          <div id="ap-pane-params" class="ap-dock-pane" role="tabpanel">
            <div class="ap-pane-head"><span>Run parameters</span></div>
            <div id="ap-params" class="ap-params"></div>
          </div>
          <div id="ap-pane-execs" class="ap-dock-pane" role="tabpanel">
            <div class="ap-pane-head"><span>Executions</span></div>
            <div id="ap-execs" class="ap-execs"></div>
          </div>
          <div id="ap-pane-detail" class="ap-dock-pane" role="tabpanel">
            <div class="ap-pane-head">
              <span>Execution detail</span>
              <span id="ap-detail-sel" class="ap-detail-sel"></span>
            </div>
            <div id="ap-detail" class="ap-detail"></div>
          </div>
        </div>
      </aside>
    </div>
    </section>
    <section id="ap-view-tasks" class="ap-view ap-page" role="tabpanel" aria-labelledby="ap-vt-tasks" hidden>
      <div class="ap-page-head">
        <span class="ap-page-title">Tasks</span>
        <span id="ap-tasks-count" class="ap-page-count"></span>
        <span class="ap-page-spacer"></span>
        <button id="ap-tasks-refresh" class="ap-btn ap-btn-sm" type="button">↻ Refresh</button>
      </div>
      <div id="ap-tasks-note" class="ap-page-note" hidden></div>
      <div id="ap-tasks-empty" class="ap-pane-empty" hidden></div>
      <div id="ap-tasks" class="ap-rows" role="list" aria-label="Task queue"></div>
    </section>
    <section id="ap-view-schedules" class="ap-view ap-page" role="tabpanel" aria-labelledby="ap-vt-schedules" hidden>
      <div class="ap-page-head">
        <span class="ap-page-title">Schedules</span>
        <span id="ap-sched-count" class="ap-page-count"></span>
        <span class="ap-page-spacer"></span>
        <button id="ap-sched-refresh" class="ap-btn ap-btn-sm" type="button">↻ Refresh</button>
      </div>
      <div id="ap-sched-note" class="ap-page-note" hidden></div>
      <form id="ap-sched-form" class="ap-form" autocomplete="off">
        <div class="ap-form-row">
          <label for="ap-sf-type">type</label>
          <select id="ap-sf-type" class="ap-input">
            <option value="once">once</option>
            <option value="interval">interval</option>
            <option value="cron">cron</option>
          </select>
        </div>
        <div class="ap-form-row">
          <label for="ap-sf-script">scriptId</label>
          <input id="ap-sf-script" class="ap-input" type="text" list="ap-sf-scripts"
                 placeholder="demo-1" required>
          <datalist id="ap-sf-scripts"></datalist>
        </div>
        <div class="ap-form-row">
          <label for="ap-sf-when" id="ap-sf-when-label">atMs（本地时间）</label>
          <input id="ap-sf-when" class="ap-input" type="datetime-local">
        </div>
        <div class="ap-form-row">
          <label for="ap-sf-ctx">profiles</label>
          <input id="ap-sf-ctx" class="ap-input" type="text" placeholder="p1, p2（逗号分隔）" required>
        </div>
        <div class="ap-form-row">
          <label for="ap-sf-name">name</label>
          <input id="ap-sf-name" class="ap-input" type="text" placeholder="可选唯一名">
        </div>
        <div class="ap-form-foot">
          <span id="ap-sf-err" class="ap-form-err" role="alert" hidden></span>
          <button id="ap-sched-add" class="ap-btn ap-btn-primary ap-btn-sm" type="submit">＋ Add schedule</button>
        </div>
      </form>
      <div id="ap-sched-empty" class="ap-pane-empty" hidden></div>
      <div id="ap-scheds" class="ap-rows" role="list" aria-label="Schedules"></div>
    </section>
    <section id="ap-view-api" class="ap-view ap-page" role="tabpanel" aria-labelledby="ap-vt-api" hidden>
      <div class="ap-page-head">
        <span class="ap-page-title">Automation API</span>
        <span class="ap-page-count">静态参考 · 不发请求</span>
        <span class="ap-page-spacer"></span>
      </div>
      <div id="ap-api" class="ap-api"></div>
    </section>
    <footer class="ap-statusbar">
      <span id="ap-cur">Ln 1, Col 1</span>
      <span id="ap-ro" class="ap-ro-badge" hidden>READONLY</span>
      <span id="ap-dirty" class="ap-dirty-ind" title="Unsaved changes">●</span>
      <span class="ap-status-spacer"></span>
      <span id="ap-dur" class="ap-dur">Last run —</span>
    </footer>`;

  /* ── state ────────────────────────────────────────────────────────────── */

  const state = {
    mounted: false, root: null, refs: null, editor: null,
    bridge: null, demo: false,
    scripts: [], script: null,          // selected Script (or local draft)
    dirty: false, params: {},            // param values by name
    running: false, runExecId: null, unsub: null, poll: null,
    executions: [], logs: [], maxSeq: 0,
    lastDuration: null, status: 'ready', // ready|running|ok|failed
    dock: 'console',
    // §27 views (header tab row; Scripts is the pre-existing editor+dock)
    view: 'scripts',                     // scripts|tasks|schedules|api
    tasks: [], tasksSig: '', tasksPoll: null,
    schedules: [], schedSig: '', schedPoll: null,
    pendingRemove: null, removeTimer: null,
    detail: { exec: null, logs: [], maxSeq: 0, poll: null },   // execution detail pane
    apiRendered: false,
  };

  const $ = (id) => state.root.querySelector('#' + id);

  /* ── helpers ──────────────────────────────────────────────────────────── */

  const BADGE = {
    CREATED: 'ap-b-neutral', QUEUED: 'ap-b-neutral', RUNNING: 'ap-b-run',
    SUCCEEDED: 'ap-b-ok', FAILED: 'ap-b-fail', CANCELLED: 'ap-b-cancel',
    RETRYING: 'ap-b-warn',
  };
  const isTerminal = (s) => s === 'SUCCEEDED' || s === 'FAILED' || s === 'CANCELLED' || s === 'TIMEOUT' || s === 'CRASHED'; // service vocabulary passes through (facade only maps SUCCESS)
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function fmtTs(ts) {
    const d = new Date(ts);
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }
  function fmtDur(ms) {
    if (ms == null) return '—';
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }
  function fmtFull(ts) {
    if (ts == null) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  // "in 12s" / "3m ago" — absolute time stays in title=""
  function fmtRel(ts) {
    if (ts == null) return '—';
    const d = ts - Date.now();
    const a = Math.abs(d);
    const u = a < 60000 ? Math.round(a / 1000) + 's'
      : a < 3600000 ? Math.round(a / 60000) + 'm'
        : a < 864e5 ? Math.round(a / 3600000) + 'h' : Math.round(a / 864e5) + 'd';
    return d >= 0 ? 'in ' + u : u + ' ago';
  }
  function shortId(id) { return String(id || '').slice(0, 8); }

  function setBanner(msg, kind) {
    const el = $('ap-banner');
    if (!msg) { el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle('ap-banner-warn', kind === 'warn');
    $('ap-banner-text').textContent = msg;
  }

  function setStatus(s) {
    state.status = s;
    const pill = $('ap-pill'), txt = $('ap-pill-text');
    pill.className = 'ap-pill' + (
      s === 'running' ? ' is-running' : s === 'failed' ? ' is-failed' : s === 'ok' ? ' is-ok' : ''
    );
    txt.textContent = s === 'running' ? 'Running' : s === 'failed' ? 'Failed' : s === 'ok' ? 'Passed' : 'Ready';
  }

  function markDirty(v) {
    state.dirty = v;
    $('ap-dirty').classList.toggle('is-dirty', v);
    renderFiles(); // dirty dot on tree item
  }

  function renderVersion() {
    $('ap-version').textContent = state.script
      ? (state.script.id ? 'v' + (state.script.version || 1) : 'draft')
      : '—';
  }

  function renderStatusbar() {
    $('ap-ro').hidden = !(state.running || (state.script && state.script.status === 'archived'));
    $('ap-dur').textContent = 'Last run ' + (state.lastDuration != null ? fmtDur(state.lastDuration) : '—');
    $('ap-dirty').classList.toggle('is-dirty', state.dirty);
  }

  function applyDisabled() {
    const noBridge = !state.bridge;
    const r = state.refs;
    r.run.disabled = noBridge || state.running || !state.script;
    r.stop.disabled = !state.running;
    r.save.disabled = noBridge || state.running;
    r.pause.disabled = !state.bridge || !state.running || !state.bridge.pauseScript;
    r.pause.title = (state.bridge && !state.bridge.pauseScript)
      ? 'Pause not supported by bridge' : 'Pause execution';
    r.name.readOnly = state.running;
    r.new.disabled = state.running;
    if (state.editor) state.editor.setReadonly(state.running || (state.script && state.script.status === 'archived'));
    state.root.classList.toggle('is-running', state.running);
    state.root.querySelectorAll('.ap-params input,.ap-params select,.ap-params textarea')
      .forEach((el) => { el.disabled = state.running || !state.script; });
    renderStatusbar();
  }

  /* ── files tree ───────────────────────────────────────────────────────── */

  function renderFiles() {
    const tree = $('ap-tree');
    const folders = {};
    state.scripts.forEach((s) => { (folders[s.folder || 'main'] = folders[s.folder || 'main'] || []).push(s); });
    // local unsaved draft joins the tree under its folder
    if (state.script && !state.script.id) {
      (folders[state.script.folder || 'main'] = folders[state.script.folder || 'main'] || []).unshift(state.script);
    }
    tree.innerHTML = Object.keys(folders).map((f) => `
      <div class="ap-tree-group">
        <div class="ap-tree-group-head">${esc(f)}</div>
        ${folders[f].map((s) => `
          <button class="ap-tree-item${state.script && s.id === state.script.id && state.dirty ? ' is-dirty' : ''}"
                  data-id="${esc(s.id || '')}" data-name="${esc(s.name)}"
                  aria-current="${!!(state.script && ((s.id && s.id === state.script.id) || (!s.id && s.name === state.script.name)))}"
                  type="button" title="${esc(s.name)}">
            <span class="ap-tree-name">${esc(s.name)}</span>
            <span class="ap-tree-dirty" aria-hidden="true">●</span>
          </button>`).join('')}
      </div>`).join('');
  }

  /* ── editor ───────────────────────────────────────────────────────────── */

  /* Lazy vendor Monaco (offline-first): if window.monaco is absent, probe the
     optional local vendor bundle once (automation-panel/vendor/monaco/min/vs/loader.js).
     No CDN, no network — an absent vendor fails fast to the textarea facade.
     To enable: vendor monaco-editor/min there; the AMD callback sets
     window.monaco + window.monacoAvailable for the __mountMonaco hook above. */
  let monacoProbe = null;
  function ensureMonaco() {
    if (window.monacoAvailable && window.monaco && window.monaco.editor) return Promise.resolve(true);
    if (monacoProbe) return monacoProbe;
    monacoProbe = new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        if (ok) window.monacoAvailable = true;
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), 3000);
      try {
        const s = document.createElement('script');
        s.src = 'vendor/monaco/min/vs/loader.js';
        s.onload = () => {
          try {
            const req = window.require;
            if (typeof req === 'function' && typeof req.config === 'function') {
              req.config({ paths: { vs: 'vendor/monaco/min/vs' } });
              req(['vs/editor/editor.main'],
                () => { clearTimeout(timer); done(!!(window.monaco && window.monaco.editor)); },
                () => { clearTimeout(timer); done(false); });
            } else {
              clearTimeout(timer);
              done(!!(window.monaco && window.monaco.editor));
            }
          } catch (_) { clearTimeout(timer); done(false); }
        };
        s.onerror = () => { clearTimeout(timer); done(false); };
        document.head.appendChild(s);
      } catch (_) { clearTimeout(timer); done(false); }
    });
    return monacoProbe;
  }

  function mountEditor() {
    const host = $('ap-editor');
    // Vendor-absent (today): probe fails fast, textarea mounts immediately.
    ensureMonaco().then(() => {
      if (!state.root) return; // unmounted while probing
      state.editor = (window.monacoAvailable ? window.__mountMonaco(host, { language: 'javascript' }) : null)
        || createTextareaEditor(host);
      state.editor.onDidChange(() => { markDirty(true); });
      state.editor.onCursor(() => {
        const p = state.editor.getPosition();
        $('ap-cur').textContent = `Ln ${p.line}, Col ${p.col}`;
      });
      if (state.script) state.editor.setValue(state.script.code || '');
    });
    state.editor = null; // async mount; loadScriptIntoEditor guards
  }

  function loadScriptIntoEditor() {
    const s = state.script;
    $('ap-empty').hidden = !!s;
    $('ap-name').value = s ? s.name : '';
    if (state.editor) state.editor.setValue(s ? (s.code || '') : '');
    state.params = {};
    if (s && s.params) {
      s.params.forEach((p) => {
        state.params[p.name] = p.default != null ? p.default
          : (p.type === 'boolean' ? false : p.type === 'multi-select' ? [] : '');
      });
    }
    markDirty(false);
    renderVersion();
    renderParams();
    renderStatusbar();
  }

  /* ── dock: console / params / executions ─────────────────────────────── */

  function switchDock(name) {
    if (name === 'detail' && !state.selExecId) return;   // tab is disabled anyway
    state.dock = name;
    state.root.querySelectorAll('.ap-dock-tab').forEach((t) => {
      t.setAttribute('aria-selected', String(t.dataset.pane === name));
    });
    ['console', 'params', 'execs', 'detail'].forEach((p) => {
      $('ap-pane-' + p).classList.toggle('is-active', p === name);
    });
    if (name === 'execs') loadExecutions();
    if (name === 'detail') renderDetail();
  }

  function appendLog(line) {
    if (line.seq != null) {
      if (line.seq <= state.maxSeq) return; // dedupe live vs catch-up
      state.maxSeq = line.seq;
    }
    state.logs.push(line);
    renderConsole(true);
  }

  function renderConsole(atBottom) {
    const box = $('ap-console');
    if (!state.logs.length) {
      box.innerHTML = '<div class="ap-pane-empty">No log output yet.</div>';
      return;
    }
    const stick = atBottom || (box.scrollHeight - box.scrollTop - box.clientHeight) < 40;
    box.innerHTML = state.logs.map((l) => `
      <div class="ap-log ap-log-${esc(l.level || 'info')}">
        <span class="ap-log-ts">${fmtTs(l.ts || Date.now())}</span>
        <span class="ap-log-level">${esc(l.level || 'info')}</span>
        <span class="ap-log-text">${esc(l.text)}</span>
      </div>`).join('');
    if (stick) box.scrollTop = box.scrollHeight;
  }

  function renderParams() {
    const box = $('ap-params');
    const list = (state.script && state.script.params) || [];
    if (!list.length) {
      box.innerHTML = '<div class="ap-pane-empty">This script has no parameters.</div>';
      return;
    }
    box.innerHTML = list.map((p) => {
      const id = 'ap-p-' + p.name;
      const req = p.required ? ' <span class="ap-param-req" title="required">*</span>' : '';
      const dis = state.running ? ' disabled' : '';
      let ctl;
      switch (p.type) {
        case 'number':
          ctl = `<input id="${id}" type="number" data-name="${esc(p.name)}" data-ptype="number"${dis}>`; break;
        case 'boolean':
          return `<div class="ap-param"><label for="${id}">${esc(p.name)}${req}</label>
            <span class="ap-param-check"><input id="${id}" type="checkbox" data-name="${esc(p.name)}" data-ptype="boolean"${dis}>
            enabled</span></div>`;
        case 'select':
          ctl = `<select id="${id}" data-name="${esc(p.name)}" data-ptype="select"${dis}>
            ${(p.options || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`; break;
        case 'multi-select':
          ctl = `<select id="${id}" multiple data-name="${esc(p.name)}" data-ptype="multi-select"${dis}>
            ${(p.options || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`; break;
        case 'secret':
          ctl = `<input id="${id}" type="password" autocomplete="new-password" data-name="${esc(p.name)}" data-ptype="secret" placeholder="••••••••"${dis}>`; break;
        case 'textarea':
        case 'json':
          ctl = `<textarea id="${id}" data-name="${esc(p.name)}" data-ptype="${p.type}"${dis}></textarea>`; break;
        case 'file':
        case 'string':
        default:
          ctl = `<input id="${id}" type="text" data-name="${esc(p.name)}" data-ptype="string"${dis}>`;
      }
      return `<div class="ap-param"><label for="${id}" title="${esc(p.name)}">${esc(p.name)}${req}</label>${ctl}</div>`;
    }).join('');
    // fill defaults / current values
    list.forEach((p) => {
      const el = box.querySelector('#ap-p-' + CSS.escape(p.name));
      if (!el) return;
      const v = state.params[p.name];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.multiple) Array.from(el.options).forEach((o) => { o.selected = Array.isArray(v) && v.includes(o.value); });
      else el.value = v == null ? '' : v;
      el.addEventListener('change', () => {
        if (el.type === 'checkbox') state.params[p.name] = el.checked;
        else if (el.multiple) state.params[p.name] = Array.from(el.selectedOptions).map((o) => o.value);
        else if (p.type === 'number') state.params[p.name] = el.value === '' ? '' : Number(el.value);
        else state.params[p.name] = el.value;
        markDirty(true);
      });
    });
  }

  function collectParams() {
    const out = {};
    const list = (state.script && state.script.params) || [];
    for (const p of list) {
      const v = state.params[p.name];
      if (p.required && (v == null || v === '' || (Array.isArray(v) && !v.length))) {
        setBanner(`Missing required param: ${p.name}`, 'warn');
        switchDock('params');
        return null;
      }
      if (p.type === 'secret') out[p.name] = v == null ? '' : String(v); // never rendered into logs by us
      else out[p.name] = v;
    }
    return out;
  }

  function renderExecs() {
    const box = $('ap-execs');
    const badge = $('ap-exec-badge');
    badge.hidden = !state.executions.length;
    badge.textContent = String(state.executions.length);
    if (!state.executions.length) {
      box.innerHTML = '<div class="ap-pane-empty">No executions yet.<br>Run this script to see history.</div>';
      return;
    }
    box.innerHTML = state.executions.map((e) => `
      <button class="ap-exec" data-id="${esc(e.id)}" type="button"
              aria-current="${e.id === state.runExecId || e.id === state.selExecId}">
        <span class="ap-exec-line">
          <span class="ap-badge ${BADGE[e.status] || 'ap-b-neutral'}">${esc(e.status)}</span>
          <span class="ap-exec-time">${fmtTs(e.startTime)}</span>
          <span class="ap-exec-dur">${e.duration != null ? fmtDur(e.duration) : (e.status === 'RUNNING' ? '…' : '')}</span>
        </span>
        ${e.error ? `<span class="ap-exec-err">${esc(e.error.message || e.error.code || e.error.type)}</span>` : ''}
      </button>`).join('');
  }

  /* ── §27 views: header switcher + Tasks / Schedules / API ─────────────── */

  const VIEWS = ['scripts', 'tasks', 'schedules', 'api'];
  const TASK_POLL_MS = 2000;

  // status→badge for the task vocabulary (task.md §3; SUCCESS ≠ execution SUCCEEDED)
  const TASK_BADGE = {
    CREATED: 'ap-b-neutral', QUEUED: 'ap-b-neutral', STARTING: 'ap-b-run',
    RUNNING: 'ap-b-run', PAUSED: 'ap-b-warn', STOPPING: 'ap-b-warn',
    RETRYING: 'ap-b-warn', SUCCESS: 'ap-b-ok', FAILED: 'ap-b-fail',
    TIMEOUT: 'ap-b-fail', CRASHED: 'ap-b-fail', CANCELLED: 'ap-b-cancel',
  };
  // Enablement follows task-queue.js TRANSITIONS (the enforced table) — the
  // doc's §3.1 differs in two places (pause: code allows only RUNNING→PAUSED,
  // and terminal rows all have a →QUEUED edge). Rejections still surface as
  // CONFLICT in the error strip, so a stale rule can't corrupt state.
  const TASK_ACTS = {
    cancel: (s) => ['CREATED', 'QUEUED', 'STARTING', 'RUNNING', 'PAUSED', 'STOPPING', 'RETRYING'].indexOf(s) >= 0,
    pause: (s) => s === 'RUNNING',
    resume: (s) => s === 'PAUSED',
    retry: (s) => ['FAILED', 'TIMEOUT', 'CRASHED', 'CANCELLED', 'RETRYING'].indexOf(s) >= 0,
  };
  const TASK_ACT_LABEL = { cancel: 'Cancel', pause: 'Pause', resume: 'Resume', retry: 'Retry' };
  const TASK_ACT_TITLE = {
    cancel: 'Cancel 不可用：硬终态不可取消（task.md §3）',
    pause: 'Pause 仅 RUNNING 合法（queue: RUNNING→PAUSED）',
    resume: 'Resume 仅 PAUSED 合法',
    retry: 'Retry 仅失败/超时/崩溃/取消可用',
  };

  const SCHED_BADGE = { active: 'ap-b-ok', paused: 'ap-b-warn', done: 'ap-b-neutral' };
  // triggerNow fires "regardless of state/enabled" (scheduler.js) but re-firing a
  // done once-schedule is meaningless → enabled while state !== 'done'.
  const SCHED_ACTS = {
    pause: (s) => s.state === 'active',
    resume: (s) => s.state === 'paused',
    trigger: (s) => s.state !== 'done',
    remove: () => true,
  };

  function switchView(name) {
    if (VIEWS.indexOf(name) < 0) name = 'scripts';
    state.view = name;
    VIEWS.forEach((v) => {
      const el = $('ap-view-' + v);
      if (el) el.hidden = v !== name;
    });
    state.root.querySelectorAll('.ap-view-tab').forEach((t) => {
      const on = t.dataset.view === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    // polls run only while their view is visible
    stopTasksPoll(); stopSchedPoll(); stopDetailPoll();
    if (name === 'tasks') {
      renderTasks(true); renderTasksState();
      if (tasksCapability().ok) { loadTasks(); startTasksPoll(); }
    } else if (name === 'schedules') {
      renderScheds(true); renderSchedsState();
      if (schedsCapability().ok) { loadSchedules(); startSchedPoll(); }
    } else if (name === 'api') {
      renderApiView();
    } else {
      syncDetailPoll();
    }
  }

  function showActionError(prefix, err) {
    const msg = (err && err.message) || String(err);
    setBanner(prefix + ' — ' + msg, /\bCONFLICT\b/.test(msg) ? 'warn' : undefined);
  }

  /* ── Tasks view ───────────────────────────────────────────────────────── */

  function tasksCapability() {
    if (!state.bridge) {
      return { ok: false, why: 'Automation bridge 未连接 — Tasks 需要 window.automationApi.tasks（preload + 主进程接线）。' };
    }
    if (!state.bridge.tasks || typeof state.bridge.tasks.list !== 'function') {
      return { ok: false, why: 'Bridge 未暴露 tasks.* — 本视图无数据源（通道 automation:tasks:list 已在 ipc-bridge 白名单）。' };
    }
    return { ok: true };
  }

  function taskRowHtml(t) {
    const id = String(t.id || '');
    const prof = (t.profileContext && t.profileContext.id) || t.profileId || '—';
    const err = t.lastError ? (t.lastError.message || t.lastError.name || '') : '';
    const acts = ['cancel', 'pause', 'resume', 'retry'].map((a) => {
      const on = TASK_ACTS[a](t.status);
      return `<button class="ap-btn ap-btn-sm" type="button" data-task-act="${a}" data-id="${esc(id)}"
        aria-label="${TASK_ACT_LABEL[a]} task ${esc(shortId(id))}"${on ? '' : ' disabled'}
        title="${on ? TASK_ACT_LABEL[a] + ' task' : TASK_ACT_TITLE[a]}">${TASK_ACT_LABEL[a]}</button>`;
    }).join('');
    return `<div class="ap-row" role="listitem" tabindex="0"
      aria-label="Task ${esc(shortId(id))}，状态 ${esc(t.status)}，脚本 ${esc(t.scriptId || '')}">
      <div class="ap-row-line">
        <code class="ap-row-id" title="${esc(id)}">${esc(shortId(id))}</code>
        <span class="ap-badge ${TASK_BADGE[t.status] || 'ap-b-neutral'}">${esc(t.status)}</span>
        <span class="ap-chip">${esc(t.scriptId || '—')}</span>
        <span class="ap-chip">${esc(prof)}</span>
      </div>
      <div class="ap-row-meta">
        <span>attempts ${t.attempts != null ? t.attempts : 0}/${t.maxAttempts != null ? t.maxAttempts : '?'}</span>
        <span title="${esc(fmtFull(t.nextRunAt))}">next ${esc(fmtRel(t.nextRunAt))}</span>
        <span title="${esc(fmtFull(t.createdAt))}">created ${esc(fmtRel(t.createdAt))}</span>
      </div>
      ${err ? `<div class="ap-row-err">${esc(err)}</div>` : ''}
      <div class="ap-row-actions">${acts}</div>
    </div>`;
  }

  function renderTasks(force) {
    const box = $('ap-tasks');
    if (!box) return;
    // poll re-render only when data moved — keeps focus and avoids flicker
    const sig = JSON.stringify(state.tasks.map((t) => [
      t.id, t.status, t.attempts, t.nextRunAt,
      t.lastError && t.lastError.message, t.scriptId,
      t.profileContext && t.profileContext.id,
    ]));
    if (!force && sig === state.tasksSig) return;
    state.tasksSig = sig;
    box.innerHTML = state.tasks.map(taskRowHtml).join('');
    $('ap-tasks-count').textContent = state.tasks.length ? state.tasks.length + ' 条' : '';
  }

  function renderTasksState() {
    const cap = tasksCapability();
    const note = $('ap-tasks-note'), empty = $('ap-tasks-empty'), btn = $('ap-tasks-refresh');
    note.hidden = cap.ok;
    if (!cap.ok) note.textContent = cap.why;
    if (btn) { btn.disabled = !cap.ok; btn.title = cap.ok ? '立即刷新' : cap.why; }
    const show = cap.ok && !state.tasks.length;
    empty.hidden = !show;
    if (show) empty.textContent = '暂无任务。调度器到期或 POST /api/tasks（手动入队）后出现。';
  }

  async function loadTasks() {
    const cap = tasksCapability();
    if (!cap.ok) { renderTasksState(); return; }
    try {
      state.tasks = (await state.bridge.tasks.list({ limit: 100 })) || [];
    } catch (err) {
      showActionError('tasks.list 失败', err);
      state.tasks = [];
    }
    renderTasks(); renderTasksState();
  }

  async function doTaskAct(act, id) {
    const t = state.bridge && state.bridge.tasks;
    if (!t || typeof t[act] !== 'function') { setBanner('Bridge 未暴露 tasks.' + act, 'warn'); return; }
    setBanner(null);
    try {
      // pause: {interrupt:true} makes RUNNING→PAUSED meaningful (worker aborts,
      // item converges CANCELLED — acceptance #7); no worker = status-only.
      if (act === 'pause') await t.pause(id, { interrupt: true });
      else await t[act](id);
      await loadTasks();
    } catch (err) {
      showActionError('tasks.' + act + ' 被拒绝', err);
      await loadTasks();          // resync: the queue may have moved anyway
    }
  }

  function startTasksPoll() {
    stopTasksPoll();
    state.tasksPoll = setInterval(() => {
      if (state.view === 'tasks') loadTasks();
    }, TASK_POLL_MS);
  }
  function stopTasksPoll() { if (state.tasksPoll) { clearInterval(state.tasksPoll); state.tasksPoll = null; } }

  /* ── Schedules view ───────────────────────────────────────────────────── */

  function schedsCapability() {
    if (!state.bridge) {
      return { ok: false, why: 'Automation bridge 未连接 — Schedules 需要 window.automationApi.schedules。' };
    }
    if (!state.bridge.schedules || typeof state.bridge.schedules.list !== 'function') {
      return { ok: false, why: 'Bridge 未暴露 schedules.* — 本视图无数据源（通道 automation:schedules:* 已在 ipc-bridge 白名单）。' };
    }
    return { ok: true };
  }

  function schedRowHtml(s) {
    const id = String(s.id || '');
    const pend = state.pendingRemove === id;
    const ctx = Array.isArray(s.profileContexts) ? s.profileContexts : [];
    const when = s.type === 'once'
      ? 'at ' + fmtRel(s.atMs)
      : s.type === 'interval' ? 'every ' + (s.everyMs != null ? s.everyMs + 'ms' : '—')
        : 'cron ' + (s.cron || '—');
    const mk = (act, label, cls) => {
      const on = SCHED_ACTS[act](s);
      return `<button class="ap-btn ap-btn-sm${cls || ''}" type="button" data-sched-act="${act}"
        data-id="${esc(id)}" aria-label="${label} schedule ${esc(shortId(id))}"${on ? '' : ' disabled'}
        title="${on ? label + ' schedule' : label + ' 不可用（当前 state=' + esc(s.state) + '）'}">${label}</button>`;
    };
    const rm = pend
      ? `<button class="ap-btn ap-btn-sm ap-btn-danger" type="button" data-sched-act="remove" data-id="${esc(id)}"
           aria-label="Confirm remove schedule ${esc(shortId(id))}" title="再次点击确认删除">Confirm</button>
         <button class="ap-btn ap-btn-sm" type="button" data-sched-act="keep" data-id="${esc(id)}"
           aria-label="Keep schedule ${esc(shortId(id))}">Keep</button>`
      : mk('remove', 'Remove');
    return `<div class="ap-row" role="listitem" tabindex="0"
      aria-label="Schedule ${esc(s.name || shortId(id))}，类型 ${esc(s.type)}，状态 ${esc(s.state)}">
      <div class="ap-row-line">
        <code class="ap-row-id" title="${esc(id)}">${esc(shortId(id))}</code>
        <span class="ap-badge ${SCHED_BADGE[s.state] || 'ap-b-neutral'}">${esc(s.state)}</span>
        <span class="ap-chip">${esc(s.type)}</span>
        <span class="ap-chip">${esc(s.scriptId || '—')}</span>
        <span class="ap-chip">${ctx.length} profile${ctx.length === 1 ? '' : 's'}</span>
        ${s.name ? `<span class="ap-row-name">${esc(s.name)}</span>` : ''}
      </div>
      <div class="ap-row-meta">
        <span>${esc(when)}</span>
        <span title="${esc(fmtFull(s.nextRunAt))}">next ${esc(fmtRel(s.nextRunAt))}</span>
        <span title="${esc(fmtFull(s.lastFiredAt))}">fired ${esc(fmtRel(s.lastFiredAt))}</span>
      </div>
      <div class="ap-row-actions">${mk('pause', 'Pause')}${mk('resume', 'Resume')}${mk('trigger', 'Trigger')}${rm}</div>
    </div>`;
  }

  function renderScheds(force) {
    const box = $('ap-scheds');
    if (!box) return;
    const sig = JSON.stringify(state.schedules.map((s) => [
      s.id, s.state, s.nextRunAt, s.lastFiredAt, s.enabled, s.type, s.scriptId, s.name,
      Array.isArray(s.profileContexts) ? s.profileContexts.length : 0,
    ])) + '|' + (state.pendingRemove || '');
    if (!force && sig === state.schedSig) return;
    state.schedSig = sig;
    box.innerHTML = state.schedules.map(schedRowHtml).join('');
    $('ap-sched-count').textContent = state.schedules.length ? state.schedules.length + ' 条' : '';
    const dl = $('ap-sf-scripts');
    if (dl && state.scripts.length) {
      dl.innerHTML = state.scripts.map((s) => `<option value="${esc(s.id)}"></option>`).join('');
    }
  }

  function renderSchedsState() {
    const cap = schedsCapability();
    const note = $('ap-sched-note'), empty = $('ap-sched-empty'), btn = $('ap-sched-refresh');
    note.hidden = cap.ok;
    if (!cap.ok) note.textContent = cap.why;
    if (btn) { btn.disabled = !cap.ok; btn.title = cap.ok ? '立即刷新' : cap.why; }
    const addBtn = $('ap-sched-add');
    if (addBtn) { addBtn.disabled = !cap.ok; addBtn.title = cap.ok ? '创建 schedule' : cap.why; }
    ['ap-sf-type', 'ap-sf-script', 'ap-sf-when', 'ap-sf-ctx', 'ap-sf-name'].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = !cap.ok;
    });
    const show = cap.ok && !state.schedules.length;
    empty.hidden = !show;
    if (show) empty.textContent = '暂无 schedule。用上方表单创建（type=once/interval/cron）。';
  }

  async function loadSchedules() {
    const cap = schedsCapability();
    if (!cap.ok) { renderSchedsState(); return; }
    try {
      state.schedules = (await state.bridge.schedules.list({})) || [];
    } catch (err) {
      showActionError('schedules.list 失败', err);
      state.schedules = [];
    }
    renderScheds(); renderSchedsState();
  }

  async function doSchedAct(act, id) {
    const sch = state.bridge && state.bridge.schedules;
    if (!sch || typeof sch[act] !== 'function') { setBanner('Bridge 未暴露 schedules.' + act, 'warn'); return; }
    if (act === 'remove') {
      if (state.pendingRemove !== id) {              // two-step inline confirm (no native confirm)
        state.pendingRemove = id;
        clearTimeout(state.removeTimer);
        state.removeTimer = setTimeout(() => { state.pendingRemove = null; state.schedSig = ''; renderScheds(true); }, 5000);
        state.schedSig = '';
        renderScheds(true);
        return;
      }
      state.pendingRemove = null;
      clearTimeout(state.removeTimer);
    }
    setBanner(null);
    try {
      await sch[act](id);
      state.schedSig = '';
      await loadSchedules();
    } catch (err) {
      showActionError('schedules.' + act + ' 被拒绝', err);
      state.schedSig = '';
      await loadSchedules();
    }
  }

  // once → local datetime (converted to epoch ms), interval → ms, cron → 5 fields
  function syncWhenField() {
    const type = $('ap-sf-type').value;
    const label = $('ap-sf-when-label'), input = $('ap-sf-when');
    if (!label || !input) return;
    const cfg = {
      once: ['atMs（本地时间）', 'datetime-local', ''],
      interval: ['everyMs（毫秒 ≥1000）', 'number', '60000'],
      cron: ['cron（分 时 日 月 周）', 'text', '*/5 * * * *'],
    }[type] || ['atMs', 'text', ''];
    label.textContent = cfg[0];
    input.type = cfg[1];
    input.value = '';
    input.placeholder = cfg[2];
  }

  function schedFormErr(msg) {
    const el = $('ap-sf-err');
    if (!el) return;
    el.hidden = !msg;
    el.textContent = msg || '';
  }

  async function doAddSchedule(ev) {
    ev.preventDefault();
    schedFormErr(null);
    const sch = state.bridge && state.bridge.schedules;
    if (!sch || typeof sch.add !== 'function') { schedFormErr(schedsCapability().why); return; }
    const type = $('ap-sf-type').value;
    const scriptId = $('ap-sf-script').value.trim();
    const contexts = $('ap-sf-ctx').value.split(',').map((x) => x.trim()).filter(Boolean);
    const name = $('ap-sf-name').value.trim();
    const when = $('ap-sf-when').value;
    if (!scriptId) { schedFormErr('scriptId 必填'); return; }
    if (!contexts.length) { schedFormErr('profileContexts 至少 1 个 id（逗号分隔）'); return; }
    const spec = { type, scriptId, profileContexts: contexts };
    if (name) spec.name = name;
    if (type === 'once') {
      const ms = when ? Date.parse(when) : NaN;
      if (!Number.isFinite(ms)) { schedFormErr('atMs 需要一个合法时间'); return; }
      spec.atMs = ms;
    } else if (type === 'interval') {
      const ms = Number(when);
      if (!Number.isFinite(ms) || ms < 1000) { schedFormErr('everyMs 须为 ≥1000 的毫秒数'); return; }
      spec.everyMs = ms;
    } else {
      if (!when.trim()) { schedFormErr('cron 表达式必填（5 字段）'); return; }
      spec.cron = when.trim();
    }
    try {
      await sch.add(spec);
      $('ap-sched-form').reset();
      syncWhenField();
      state.schedSig = '';
      await loadSchedules();
      setBanner(null);
    } catch (err) {
      schedFormErr(((err && err.message) || String(err)) + '');   // backend VALIDATION stays inline
    }
  }

  function startSchedPoll() {
    stopSchedPoll();
    state.schedPoll = setInterval(() => {
      if (state.view === 'schedules' && !state.pendingRemove) loadSchedules();
    }, TASK_POLL_MS);
  }
  function stopSchedPoll() { if (state.schedPoll) { clearInterval(state.schedPoll); state.schedPoll = null; } }

  /* ── API view (static reference — renders once, issues no requests) ────── */

  const API_GROUPS = [
    ['status', [['GET', '/api/automation/status', 'components（store/queueDepth/running/schedules）+ uptimeSec']]],
    ['scripts', [
      ['GET', '/api/scripts', '列表（strip versions[].code，只留 version/createdAt）'],
      ['POST', '/api/scripts', '创建（name/permissions/parameters/可选 code）'],
      ['GET', '/api/scripts/:id', '详情（含最新 code 与 versions）'],
      ['PUT', '/api/scripts/:id', '更新 meta 字段（不动 versions）'],
      ['DELETE', '/api/scripts/:id', '软删除（deletedAt）'],
      ['POST', '/api/scripts/:id/run', '同步执行 body { version?, params?, profileContext? }'],
      ['POST', '/api/scripts/:id/versions', '追加不可变版本 { code, version? }'],
      ['GET', '/api/scripts/:id/export', '导出 fp-script v1 包'],
      ['POST', '/api/scripts/import', '导入 fp-script（fresh uuid，永不覆盖）'],
    ]],
    ['executions', [
      ['GET', '/api/executions', '列表 query: scriptId / status / limit / offset'],
      ['GET', '/api/executions/:id', '单条记录'],
      ['GET', '/api/executions/:id/logs', '日志数组（脱敏，secret 恒 ***）'],
      ['POST', '/api/executions/:id/cancel', '取消（不可取消 → 409 CONFLICT）'],
    ]],
    ['tasks', [
      ['GET', '/api/tasks', '列表 query: status / scriptId / limit / offset'],
      ['POST', '/api/tasks', '入队 { scriptId, version?, params?, profileContext, maxAttempts?, priority? }'],
      ['GET', '/api/tasks/:id', '单条 task item'],
      ['POST', '/api/tasks/:id/cancel', '→ CANCELLED（非法迁移 → 409）'],
      ['POST', '/api/tasks/:id/pause', '→ PAUSED（仅暂停记账；{interrupt:true} 可中断）'],
      ['POST', '/api/tasks/:id/resume', '→ 回 RUNNING/QUEUED 路径'],
      ['POST', '/api/tasks/:id/retry', 'retryNow：跳过剩余 backoff → QUEUED'],
    ]],
    ['schedules', [
      ['GET', '/api/schedules', '列表 query: enabled / limit / offset'],
      ['POST', '/api/schedules', '创建（type=once/interval/cron、scriptId、profileContexts）'],
      ['DELETE', '/api/schedules/:id', '删除'],
      ['POST', '/api/schedules/:id/pause', 'state=paused'],
      ['POST', '/api/schedules/:id/resume', 'state=active + 重算 nextRunAt'],
      ['POST', '/api/schedules/:id/trigger', 'triggerNow：不改 state 立即扇出一次'],
    ]],
    ['profiles', [
      ['GET', '/api/profiles', '列表（proxy.password 恒 ***）'],
      ['POST', '/api/profiles', '创建 → 派生 partition persist:auto-{id}'],
      ['GET/PUT/DELETE', '/api/profiles/:id', '读/改/软删（running 中改指纹三元组 → 409）'],
      ['GET', '/api/profiles/:id/status', '{ id, status, endpoint }'],
      ['POST', '/api/profiles/:id/start', 'launcher.start → running + endpoint'],
      ['POST', '/api/profiles/:id/stop', '→ stopped'],
      ['GET', '/api/profiles/:id/cdp', 'live cdpUrl（Playwright connectOverCDP；未 start → 404）'],
    ]],
    ['templates', [
      ['GET', '/api/templates', '内置模板目录（含 code，11 个）'],
      ['POST', '/api/templates/install', '幂等安装 → { installed, skipped }'],
    ]],
  ];

  const API_WS = {
    read: ['status', 'executions:list', 'executions:get', 'executions:logs',
      'tasks:list', 'tasks:get', 'schedules:list', 'profiles:list', 'profiles:get',
      'profiles:status', 'profiles:cdp'],
    write: ['tasks:pause', 'tasks:resume', 'tasks:retry', 'tasks:cancel', 'run:stop'],
  };

  const API_RECORDER = [
    ['automation:recorder:start', 'recorder.start({ profileId?, url? }) → { sessionId, url }'],
    ['automation:recorder:drain', 'recorder.drain(sessionId) → { nodes, count }'],
    ['automation:recorder:stop', 'recorder.stop(sessionId) → { ast: { nodes, meta } }'],
    ['automation:recorder:state', 'recorder.state(sessionId?) → { active, sessions, nodes }'],
  ];

  const API_METHOD_CLS = { GET: 'is-get', POST: 'is-post', PUT: 'is-put', DELETE: 'is-del' };

  function renderApiView() {
    const box = $('ap-api');
    if (!box || state.apiRendered) return;
    state.apiRendered = true;
    const groupHtml = API_GROUPS.map(([name, rows]) => `
      <div class="ap-api-group">
        <h3 class="ap-api-title">${esc(name)}</h3>
        ${rows.map(([m, p, note]) => `
          <div class="ap-api-row">
            <code class="ap-api-m ${API_METHOD_CLS[m] || ''}">${esc(m)}</code>
            <code class="ap-api-p">${esc(p)}</code>
            <span class="ap-api-note">${esc(note)}</span>
          </div>`).join('')}
      </div>`).join('');
    box.innerHTML = `
      <div class="ap-api-group">
        <h3 class="ap-api-title">鉴权 / 宿主</h3>
        <div class="ap-api-row"><span class="ap-api-note">绑定 loopback（127.0.0.1）＋
          <code class="ap-api-p">Authorization: Bearer &lt;token&gt;</code>（可选 read-only viewer token）；
          宿主需启动 <code class="ap-api-p">node automation/bin/serve.js</code>
          或内嵌 IPC 桥 <code class="ap-api-p">attachAutomation({ ipcMain, service })</code>。</span></div>
        <div class="ap-api-row"><span class="ap-api-note">错误信封
          <code class="ap-api-p">{ ok:false, error:{ code, message } }</code>：
          VALIDATION 400 · NOT_FOUND 404 · CONFLICT 409 · LIMIT/RATE_LIMITED 429 · NOT_IMPLEMENTED 501。</span></div>
      </div>
      <div class="ap-api-group">
        <h3 class="ap-api-title">WebSocket</h3>
        <div class="ap-api-row"><code class="ap-api-p">ws://127.0.0.1:&lt;port&gt;/api/ws?token=&lt;token&gt;</code>
          <span class="ap-api-note">JSON-RPC 风格 { id, method, params }</span></div>
        <div class="ap-api-row"><code class="ap-api-m is-get">read</code>
          <span class="ap-api-note">${API_WS.read.map(esc).join(' · ')}</span></div>
        <div class="ap-api-row"><code class="ap-api-m is-post">write</code>
          <span class="ap-api-note">${API_WS.write.map(esc).join(' · ')}</span></div>
      </div>
      <div class="ap-api-group">
        <h3 class="ap-api-title">CDP（外部 Playwright）</h3>
        <div class="ap-api-row"><code class="ap-api-p">ws://127.0.0.1:&lt;cdpPort&gt;/api/cdp/&lt;profileId&gt;?token=&lt;token&gt;</code>
          <span class="ap-api-note">connectOverCDP 用；仅 running profile</span></div>
        <div class="ap-api-row"><code class="ap-api-m is-get">GET</code>
          <code class="ap-api-p">/json/version</code><span class="ap-api-note">发现端点（同一 cdp 监听端口）</span></div>
        <div class="ap-api-row"><code class="ap-api-m is-get">GET</code>
          <code class="ap-api-p">/api/profiles/:id/cdp</code><span class="ap-api-note">→ { endpoint: { cdpUrl, wsEndpoint? } }</span></div>
      </div>
      <div class="ap-api-group">
        <h3 class="ap-api-title">IPC 录制通道（preload: automationApi.recorder）</h3>
        ${API_RECORDER.map(([ch, note]) => `
          <div class="ap-api-row"><code class="ap-api-p">${esc(ch)}</code>
          <span class="ap-api-note">${esc(note)}</span></div>`).join('')}
      </div>
      ${groupHtml}`;
  }

  /* ── Execution detail (dock pane) ─────────────────────────────────────── */

  const ARTIFACT_DATA_PREFIX = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i;
  const ARTIFACT_B64 = /^[A-Za-z0-9+/=\s]{64,}$/;

  // Only raster data URLs are accepted for <img>; svg+xml is deliberately
  // excluded (metadata chip instead) — artifacts are page-derived content.
  function artifactSrc(a) {
    const cand = typeof a === 'string' ? a
      : a && typeof a === 'object'
        ? (a.dataUrl || a.dataURL || a.base64 || a.data || a.png || a.image)
        : null;
    if (typeof cand !== 'string') return null;
    if (ARTIFACT_DATA_PREFIX.test(cand)) return cand;
    return ARTIFACT_B64.test(cand) ? 'data:image/png;base64,' + cand.replace(/\s+/g, '') : null;
  }

  function artifactHtml(a, i) {
    const kind = (a && a.kind) || 'artifact';
    const src = artifactSrc(a);
    const meta = [
      a && a.bytes != null ? a.bytes + ' B' : null,
      a && a.ts ? fmtTs(a.ts) : null,
      a && a.path ? String(a.path) : null,
      a && a.error ? 'error: ' + String(a.error) : null,
    ].filter(Boolean).join(' · ');
    if (src) {
      return `<figure class="ap-artifact">
        <img class="ap-artifact-img" src="${esc(src)}" alt="${esc(kind)} #${i + 1}" loading="lazy">
        <figcaption class="ap-artifact-meta">${esc(kind)}${meta ? ' · ' + esc(meta) : ''}</figcaption>
      </figure>`;
    }
    return `<div class="ap-artifact ap-artifact-meta-only">
      <span class="ap-chip">${esc(kind)}</span>${meta ? ' ' + esc(meta) : ''}</div>`;
  }

  function tlRowHtml(l) {
    const lv = (l && l.level) || 'info';
    const ts = l && l.ts ? fmtTs(l.ts) : '';
    return `<div class="ap-tl-item ap-tl-${esc(lv)}" title="${esc(ts)} ${esc(lv)}">
      <span class="ap-tl-dot" aria-hidden="true"></span>
      <span class="ap-tl-ts">${esc(ts)}</span>
      <span class="ap-tl-lv">${esc(lv)}</span>
      <span class="ap-tl-text">${esc(l && l.text)}</span>
    </div>`;
  }

  function renderDetail() {
    const box = $('ap-detail');
    if (!box) return;
    const tab = state.root.querySelector('.ap-dock-tab[data-pane="detail"]');
    const e = state.detail.exec;
    const has = !!(e || state.selExecId);
    if (tab) {
      tab.disabled = !has;
      tab.title = has ? 'Execution detail' : '先选择一条 execution';
    }
    const sel = $('ap-detail-sel');
    if (sel) sel.textContent = has ? '#' + shortId((e && e.id) || state.selExecId) : '';
    if (!has) {
      box.innerHTML = '<div class="ap-pane-empty">点击 Executions 里的记录查看详情。</div>';
      return;
    }
    const rec = e || { id: state.selExecId };
    const logs = state.detail.logs || [];
    const arts = Array.isArray(rec.artifacts) ? rec.artifacts : [];
    const err = rec.error || null;
    const stack = (err && err.stack) || rec.stack || null;
    const fields = [
      ['Status', `<span class="ap-badge ${BADGE[rec.status] || 'ap-b-neutral'}">${esc(rec.status || '—')}</span>`],
      ['Script', esc(rec.scriptId || '—') + (rec.scriptVersion != null ? ' · v' + esc(rec.scriptVersion) : '')],
      ['Profile', esc(rec.profileId || '—')],
      ['Start', esc(fmtFull(rec.startTime))],
      ['End', esc(rec.endTime ? fmtFull(rec.endTime) : '—')],
      ['Duration', esc(fmtDur(rec.duration))],
      ['Step', rec.currentStep != null ? esc(rec.currentStep) : '—'],
      ['URL', rec.currentUrl ? esc(rec.currentUrl) : '—'],
    ];
    box.innerHTML = `
      <dl class="ap-detail-fields">
        ${fields.map(([k, v]) => `<div class="ap-detail-field"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}
      </dl>
      ${err ? `<div class="ap-detail-err">
        <div class="ap-detail-err-head">${esc(err.type || err.name || 'error')}${err.code ? ' · ' + esc(err.code) : ''}${err.retriable ? ' · retriable' : ''}</div>
        <div class="ap-detail-err-msg">${esc(err.message || '')}</div>
        ${stack ? `<pre class="ap-detail-stack">${esc(stack)}</pre>` : ''}
      </div>` : ''}
      <div class="ap-detail-sec">
        <div class="ap-detail-sec-head">Artifacts
          <span class="ap-detail-sec-note">${arts.length ? arts.length + ' 件' : ''}</span></div>
        ${arts.length ? arts.map(artifactHtml).join('')
          : (rec.status === 'RUNNING'
            ? '<div class="ap-pane-empty ap-artifact-none">运行中——失败截图在 FAILED/TIMEOUT 时归档。</div>'
            : '<div class="ap-pane-empty ap-artifact-none">无失败截图（SUCCESS 不采集；FAILED/TIMEOUT 才归档）</div>')}
      </div>
      <div class="ap-detail-sec">
        <div class="ap-detail-sec-head">Timeline
          <span class="ap-detail-sec-note">${logs.length ? logs.length + ' 行日志' : ''}</span></div>
        ${logs.length
          ? `<div class="ap-timeline">${logs.slice(-40).map(tlRowHtml).join('')}</div>`
          : '<div class="ap-pane-empty">暂无日志。</div>'}
      </div>`;
  }

  async function refreshDetailExec() {
    const id = state.selExecId;
    if (!id || !state.bridge) return;
    try {
      const rec = state.bridge.getExecution
        ? await state.bridge.getExecution(id)
        : (await state.bridge.getExecutions(state.script && state.script.id) || [])
          .find((x) => x.id === id);
      if (rec) state.detail.exec = rec;
    } catch (_) { /* detail keeps the list record it already has */ }
  }

  function stopDetailPoll() { if (state.detail.poll) { clearInterval(state.detail.poll); state.detail.poll = null; } }

  function syncDetailPoll() {
    stopDetailPoll();
    const e = state.detail.exec;
    if (state.view !== 'scripts' || !state.bridge || !e || isTerminal(e.status)) return;
    state.detail.poll = setInterval(pollDetail, 1500);
  }

  async function pollDetail() {
    const id = state.selExecId;
    if (state.view !== 'scripts' || !state.bridge || !id) return stopDetailPoll();
    try {
      const extra = (await state.bridge.getLogs(id, { afterSeq: state.detail.maxSeq, limit: 200 })) || [];
      if (extra.length) {
        state.detail.logs = state.detail.logs.concat(extra);
        const last = extra[extra.length - 1];
        state.detail.maxSeq = last && last.seq != null ? last.seq : state.detail.maxSeq + extra.length;
      }
      await refreshDetailExec();
      renderDetail();
      const e = state.detail.exec;
      if (e && isTerminal(e.status)) { stopDetailPoll(); renderExecs(); loadExecutions(); }
    } catch (_) { /* transient — keep polling while RUNNING */ }
  }

  /* ── bridge calls ─────────────────────────────────────────────────────── */

  async function refreshScripts(keepSelection) {
    if (!state.bridge) { state.scripts = []; renderFiles(); return; }
    try {
      state.scripts = (await state.bridge.getScripts()) || [];
    } catch (err) {
      setBanner('getScripts failed: ' + (err && err.message || err));
      state.scripts = [];
    }
    if (keepSelection && state.script) {
      const fresh = state.scripts.find((s) => s.id === state.script.id);
      if (fresh && !state.dirty) { state.script = fresh; loadScriptIntoEditor(); }
    }
    renderFiles();
    if (!state.script && state.scripts.length) selectScript(state.scripts[0].id);
    if (!state.scripts.length && !state.script) { $('ap-empty').hidden = false; }
  }

  function selectScript(id) {
    if (state.running) return;
    const s = state.scripts.find((x) => x.id === id);
    if (!s) return;
    state.script = s;
    state.executions = [];
    state.logs = []; state.maxSeq = 0;
    state.selExecId = null;
    setBanner(null);
    setStatus('ready');
    loadScriptIntoEditor();
    renderFiles();
    renderConsole();
    renderExecs();
    applyDisabled();
    loadExecutions();
  }

  async function loadExecutions() {
    if (!state.bridge || !state.script) { renderExecs(); return; }
    try {
      state.executions = (await state.bridge.getExecutions(state.script.id)) || [];
    } catch (err) {
      state.executions = [];
      setBanner('getExecutions failed: ' + (err && err.message || err));
    }
    const lastDone = state.executions.find((e) => isTerminal(e.status) && e.duration != null);
    if (lastDone && state.lastDuration == null) state.lastDuration = lastDone.duration;
    renderExecs();
    renderStatusbar();
  }

  async function viewExecution(id) {
    state.selExecId = id;
    state.detail.exec = state.executions.find((e) => e.id === id) || { id };
    state.detail.logs = [];
    state.detail.maxSeq = 0;
    renderExecs();
    switchDock('detail');
    renderDetail();
    if (!state.bridge) return;
    try {
      const lines = (await state.bridge.getLogs(id, { afterSeq: 0, limit: 500 })) || [];
      // Console keeps its existing behavior: it shows this execution's logs too
      state.logs = []; state.maxSeq = 0;
      lines.forEach(appendLog);
      renderConsole(true);
      // Detail owns a separate copy so live-run streaming never mixes in
      state.detail.logs = lines.slice();
      const last = lines[lines.length - 1];
      state.detail.maxSeq = last && last.seq != null ? last.seq : lines.length;
    } catch (err) {
      setBanner('getLogs failed: ' + (err && err.message || err));
    }
    await refreshDetailExec();     // full record incl. artifacts (getExecution when present)
    renderDetail();
    syncDetailPoll();              // auto-refresh logs while the record is RUNNING
  }

  async function doSave() {
    if (!state.bridge || !state.script || state.running) return;
    if (!state.editor) { setBanner('Editor still mounting — retry in a moment'); return; }
    setBanner(null);
    try {
      const saved = await state.bridge.saveScript({
        id: state.script.id || null,
        name: state.refs.name.value.trim() || state.script.name,
        code: state.editor.getValue(),
        folder: state.script.folder || 'main',
        params: state.script.params || [],
      });
      const i = state.scripts.findIndex((s) => s.id === saved.id);
      if (i >= 0) state.scripts[i] = saved; else state.scripts.push(saved);
      state.script = saved;
      markDirty(false);
      renderVersion();
      renderFiles();
    } catch (err) {
      setBanner('Save failed: ' + (err && err.message || err));
    }
  }

  function stopPoll() { if (state.poll) { clearInterval(state.poll); state.poll = null; } }

  async function pollExecution(id) {
    stopPoll();
    state.poll = setInterval(async () => {
      if (!state.bridge) return stopPoll();
      try {
        const list = (await state.bridge.getExecutions(state.script && state.script.id)) || [];
        const ex = list.find((e) => e.id === id);
        if (!ex) return;
        state.executions = list;
        renderExecs();
        if (isTerminal(ex.status)) {
          stopPoll();
          if (state.unsub) { state.unsub(); state.unsub = null; }
          // one catch-up read for lines that raced the status flip
          try {
            const extra = (await state.bridge.getLogs(id, { afterSeq: state.maxSeq, limit: 200 })) || [];
            extra.forEach(appendLog);
          } catch (_) { /* bridge gone; view already has what arrived */ }
          state.running = false;
          state.lastDuration = ex.duration;
          if (ex.status === 'SUCCEEDED') { setStatus('ok'); setBanner(null); }
          else if (ex.status === 'FAILED') {
            setStatus('failed');
            const m = ex.error ? (ex.error.message || ex.error.code || ex.error.type) : 'Execution failed';
            setBanner(m + (ex.currentUrl ? ` — last URL: ${ex.currentUrl}` : ''));
          } else { setStatus('ready'); setBanner('Execution ' + ex.status.toLowerCase(), 'warn'); }
          applyDisabled();
          loadExecutions();
        }
      } catch (_) { /* transient IPC error — keep polling */ }
    }, 1000);
    // ponytail: status still polls getExecutions @1s (terminal catch-up included);
    // live lines prefer push via onAutomationEvent when the bridge provides it
  }

  async function doRun() {
    if (!state.bridge || state.running) return;
    if (state.dirty || !state.script.id) await doSave();          // run the saved revision
    if (!state.script.id) return;                                  // save failed
    const values = collectParams();
    if (values == null) return;
    setBanner(null);
    try {
      const { executionId } = await state.bridge.runScript(state.script.id, values);
      state.runExecId = executionId;
      state.selExecId = executionId;
      state.logs = []; state.maxSeq = 0;
      renderConsole();
      state.running = true;
      setStatus('running');
      applyDisabled();
      switchDock('console');
      // push preferred: 'automation:event' live lines via onAutomationEvent
      // (preload bridge, filtered by executionId); pollExecution below stays
      // as status/terminal fallback. ?demo=1 already pushes via subscribeLog
      // timers, so no extra demo stub here (ponytail: skip).
      if (window.automationApi && typeof window.automationApi.onAutomationEvent === 'function') {
        state.unsub = window.automationApi.onAutomationEvent((ev) => {
          if (!ev || ev.executionId !== executionId) return;
          appendLog(ev.line || ev);
        });
      } else if (state.bridge.subscribeLog) {
        state.unsub = state.bridge.subscribeLog(executionId, appendLog);
      }
      pollExecution(executionId);
    } catch (err) {
      state.running = false;
      setStatus('failed');
      setBanner('Run failed: ' + (err && err.message || err));
      applyDisabled();
    }
  }

  async function doStop() {
    if (!state.bridge || !state.running || !state.runExecId) return;
    try { await state.bridge.stopScript(state.runExecId); }
    catch (err) { setBanner('Stop failed: ' + (err && err.message || err)); }
    // terminal state arrives via pollExecution
  }

  async function doPause() {
    if (!state.bridge || !state.bridge.pauseScript || !state.runExecId) return;
    try { await state.bridge.pauseScript(state.runExecId); appendLog({ ts: Date.now(), level: 'info', text: 'pause requested' }); }
    catch (err) { setBanner('Pause failed: ' + (err && err.message || err)); }
  }

  function doNew() {
    if (state.running) return;
    const base = 'untitled';
    let n = 1;
    const names = new Set(state.scripts.map((s) => s.name));
    while (names.has(base + '-' + n)) n++;
    state.script = { id: null, name: base + '-' + n, version: 0, status: 'draft', folder: 'main', code: '// new script\nasync function main() {\n  \n}\n', params: [] };
    state.executions = []; state.logs = []; state.maxSeq = 0;
    setBanner(null);
    setStatus('ready');
    loadScriptIntoEditor();
    renderFiles();
    renderConsole();
    renderExecs();
    applyDisabled();
    state.editor && state.editor.focus();
  }

  /* ── wiring ───────────────────────────────────────────────────────────── */

  function wire() {
    const r = state.refs = {
      run: $('ap-run'), stop: $('ap-stop'), pause: $('ap-pause'), save: $('ap-save'),
      name: $('ap-name'), tree: $('ap-tree'), new: $('ap-new'),
    };
    r.run.addEventListener('click', doRun);
    r.stop.addEventListener('click', doStop);
    r.pause.addEventListener('click', doPause);
    r.save.addEventListener('click', doSave);
    r.new.addEventListener('click', doNew);
    $('ap-empty-new').addEventListener('click', doNew);
    r.name.addEventListener('input', () => {
      if (state.script) { state.script.name = r.name.value; markDirty(true); renderFiles(); }
    });
    $('ap-banner').querySelector('.ap-banner-close')
      .addEventListener('click', () => setBanner(null));
    $('ap-console-clear').addEventListener('click', () => { state.logs = []; state.maxSeq = 0; renderConsole(); });

    r.tree.addEventListener('click', (e) => {
      const item = e.target.closest('.ap-tree-item');
      if (item && item.dataset.id) selectScript(item.dataset.id);
      else if (item) { // draft entry has no id — reselect by name
        const draft = state.script && !state.script.id && state.script.name === item.dataset.name;
        if (draft) { loadScriptIntoEditor(); renderFiles(); }
      }
    });

    state.root.querySelectorAll('.ap-dock-tab').forEach((t) => {
      t.addEventListener('click', () => switchDock(t.dataset.pane));
    });

    // view switcher (tablist: click + Left/Right/Home/End)
    const vtabs = state.root.querySelectorAll('.ap-view-tab');
    vtabs.forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
    const vtabRow = state.root.querySelector('.ap-views');
    if (vtabRow) {
      vtabRow.addEventListener('keydown', (e) => {
        const list = Array.prototype.slice.call(vtabs);
        const i = list.findIndex((t) => t.dataset.view === state.view);
        let j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % list.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + list.length) % list.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = list.length - 1;
        if (j == null) return;
        e.preventDefault();
        switchView(list[j].dataset.view);
        list[j].focus();
      });
    }

    // Tasks: refresh + per-row transitions (CONFLICT lands in the error strip)
    $('ap-tasks-refresh').addEventListener('click', () => { setBanner(null); loadTasks(); });
    $('ap-tasks').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-task-act]');
      if (btn) doTaskAct(btn.dataset.taskAct, btn.dataset.id);
    });

    // Schedules: refresh, row actions (remove = two-step inline confirm), add form
    $('ap-sched-refresh').addEventListener('click', () => { setBanner(null); loadSchedules(); });
    $('ap-scheds').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sched-act]');
      if (!btn) return;
      const act = btn.dataset.schedAct;
      if (act === 'keep') {
        state.pendingRemove = null;
        clearTimeout(state.removeTimer);
        state.schedSig = '';
        renderScheds(true);
        return;
      }
      doSchedAct(act, btn.dataset.id);
    });
    $('ap-sf-type').addEventListener('change', syncWhenField);
    $('ap-sched-form').addEventListener('submit', doAddSchedule);

    $('ap-execs').addEventListener('click', (e) => {
      const row = e.target.closest('.ap-exec');
      if (row) viewExecution(row.dataset.id);
    });

    // keyboard: Ctrl+S save, Ctrl+Enter run; Tab inserts spaces in the editor
    state.root.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const inScripts = state.view === 'scripts';   // shortcuts belong to the editor view
      if (mod && (e.key === 's' || e.key === 'S')) {
        if (!inScripts) return;
        e.preventDefault(); doSave(); return;
      }
      if (mod && e.key === 'Enter') {
        if (!inScripts) return;
        e.preventDefault(); doRun(); return;
      }
      if (e.key === 'Tab' && state.editor && state.editor.kind === 'textarea'
          && e.target === state.editor.el && !state.editor.el.readOnly) {
        e.preventDefault();
        state.editor.handleTab();
      }
    }, true);
  }

  /* ── demo fixtures (?demo=1) ──────────────────────────────────────────── */

  function installDemoApi() {
    const scripts = [
      {
        id: 'demo-1', name: 'login-check', version: 3, status: 'published', folder: 'main',
        updatedAt: Date.now() - 864e5,
        code: '// login-check (demo)\nconst url = params.url;\nawait browser.goto(url, { waitUntil: "domcontentloaded" });\nconst title = await browser.getTitle();\nconsole.log("title =", title);\nif (params.fail) throw new Error("demo failure at step 3");\nawait page.waitForVisible("body");\nconsole.log("done");\n',
        params: [
          { name: 'url', type: 'string', required: true, default: 'https://example.com' },
          { name: 'timeout', type: 'number', default: 30000 },
          { name: 'mobile', type: 'boolean', default: false },
          { name: 'region', type: 'select', options: ['apac', 'emea', 'amer'], default: 'apac' },
          { name: 'token', type: 'secret', secret: true },
        ],
      },
      {
        id: 'demo-2', name: 'scrape-list', version: 1, status: 'draft', folder: 'main',
        updatedAt: Date.now() - 36e5,
        code: '// scrape-list (demo)\nawait browser.goto(params.url);\nconst items = await page.evaluate(() => document.querySelectorAll("li").length);\nconsole.log("items:", items);\n',
        params: [{ name: 'url', type: 'string', required: true, default: 'https://example.com' }],
      },
      {
        id: 'demo-3', name: 'retry-helper', version: 7, status: 'published', folder: 'utils',
        updatedAt: Date.now() - 72e5,
        code: '// retry-helper (demo utility)\nasync function retry(fn, times = 3) {\n  let err;\n  for (let i = 0; i < times; i++) {\n    try { return await fn(); } catch (e) { err = e; }\n  }\n  throw err;\n}\n',
        params: [],
      },
    ];
    const now = Date.now();
    // 1×1 transparent png — demo artifact that exercises the <img> path
    const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const executions = [
      { id: 'ex-3', scriptVersion: 'v3', profileId: 'p1', startTime: now - 6e4, endTime: now - 582e2, duration: 1820, status: 'SUCCEEDED', error: null, stack: null, currentUrl: null, currentStep: 9, artifacts: [] },
      { id: 'ex-2', scriptVersion: 'v3', profileId: 'p1', startTime: now - 3e5, endTime: now - 298e3, duration: 2100, status: 'FAILED', error: { type: 'TimeoutError', code: 'ETIMEDOUT', name: 'TimeoutError', message: 'waitForVisible timed out after 30000ms', retriable: true, stack: 'TimeoutError: waitForVisible timed out after 30000ms\n    at page.waitForVisible (script.js:12:5)\n    at main (script.js:4:3)' }, stack: 'at page.waitForSelector …', currentUrl: 'https://example.com/login', currentStep: 4,
        artifacts: [
          { ts: now - 298e3, kind: 'screenshot', bytes: 9929, dataUrl: PNG_1PX },
          { ts: now - 297e3, kind: 'trace', path: 'logs/ex-2.trace.zip' },
        ] },
      { id: 'ex-1', scriptVersion: 'v2', profileId: 'p1', startTime: now - 9e5, endTime: now - 898e3, duration: 1950, status: 'CANCELLED', error: null, stack: null, currentUrl: null, currentStep: 2, artifacts: [] },
    ];
    const logs = {
      'ex-3': [
        { seq: 1, ts: now - 6e4, level: 'info', text: 'execution ex-3 started (profile p1)' },
        { seq: 2, ts: now - 599e2, level: 'info', text: 'goto https://example.com' },
        { seq: 3, ts: now - 585e2, level: 'debug', text: 'waitUntil=load 412ms' },
        { seq: 4, ts: now - 582e2, level: 'info', text: 'SUCCEEDED in 1.8s' },
      ],
      'ex-2': [
        { seq: 1, ts: now - 3e5, level: 'info', text: 'execution ex-2 started' },
        { seq: 2, ts: now - 299e3, level: 'warn', text: 'retry 1/3: selector body not visible' },
        { seq: 3, ts: now - 298e3, level: 'error', text: 'TimeoutError: waitForVisible timed out after 30000ms' },
      ],
      'ex-1': [{ seq: 1, ts: now - 9e5, level: 'info', text: 'cancelled by user' }],
    };
    const subs = new Map(); // executionId -> Set<cb>
    const timers = new Map();
    const scriptExecs = { 'demo-1': ['ex-3', 'ex-2', 'ex-1'], 'demo-2': [], 'demo-3': [] };

    // ── demo fixtures for the §27 views (deterministic, offline) ──────────
    const tasks = [
      { id: 'task-aa11bb22cc33dd44', scriptId: 'demo-1', profileContext: { id: 'p1' }, status: 'QUEUED', attempts: 0, maxAttempts: 3, nextRunAt: now + 8e3, lastError: null, createdAt: now - 5e3, updatedAt: now - 5e3, priority: 0 },
      { id: 'task-ee55ff66aa77bb88', scriptId: 'demo-2', profileContext: { id: 'p2' }, status: 'RUNNING', attempts: 1, maxAttempts: 3, nextRunAt: null, lastError: null, createdAt: now - 4e4, updatedAt: now - 3e4, priority: 0 },
      { id: 'task-1122334455667788', scriptId: 'demo-1', profileContext: { id: 'p3' }, status: 'PAUSED', attempts: 0, maxAttempts: 3, nextRunAt: now + 6e4, lastError: null, createdAt: now - 9e4, updatedAt: now - 8e4, priority: 0 },
      { id: 'task-99aabbccddeeff00', scriptId: 'demo-1', profileContext: { id: 'p1' }, status: 'FAILED', attempts: 3, maxAttempts: 3, nextRunAt: null, lastError: { name: 'TimeoutError', message: 'waitForVisible timed out after 30000ms', retriable: true }, createdAt: now - 6e5, updatedAt: now - 5e5, priority: 0 },
      { id: 'task-00ffeeddccbbaa99', scriptId: 'demo-2', profileContext: { id: 'p2' }, status: 'TIMEOUT', attempts: 2, maxAttempts: 3, nextRunAt: now + 2e4, lastError: { name: 'TimeoutError', message: 'task timed out', retriable: true }, createdAt: now - 7e5, updatedAt: now - 6e5, priority: 0 },
      { id: 'task-55aa55aa55aa55aa', scriptId: 'demo-3', profileContext: { id: 'p1' }, status: 'SUCCESS', attempts: 0, maxAttempts: 3, nextRunAt: null, lastError: null, createdAt: now - 9e5, updatedAt: now - 8e5, priority: 0 },
    ];
    const TASK_TO = { cancel: 'CANCELLED', pause: 'PAUSED', resume: 'RUNNING', retry: 'QUEUED' };
    const TASK_LEGAL = {
      cancel: ['CREATED', 'QUEUED', 'STARTING', 'RUNNING', 'PAUSED', 'STOPPING', 'RETRYING'],
      pause: ['RUNNING'],
      resume: ['PAUSED'],
      retry: ['FAILED', 'TIMEOUT', 'CRASHED', 'CANCELLED', 'RETRYING'],
    };
    function demoTaskAct(id, act) {
      const t = tasks.find((x) => x.id === id);
      if (!t) return Promise.reject(new Error('NOT_FOUND task not found: ' + id));
      if (TASK_LEGAL[act].indexOf(t.status) < 0) {
        // mirrors the real queue's rejection (CONFLICT → error strip)
        return Promise.reject(new Error('CONFLICT illegal transition: ' + t.status + '->' + TASK_TO[act]));
      }
      t.status = TASK_TO[act];
      t.updatedAt = Date.now();
      if (act === 'retry') { t.nextRunAt = Date.now() + 1e3; t.attempts = 0; }
      return Promise.resolve(Object.assign({}, t));
    }

    const schedules = [
      { id: 'sch-1111aaaa', name: 'every-5m', scriptId: 'demo-1', type: 'interval', everyMs: 3e5, profileContexts: ['p1', 'p2'], enabled: true, state: 'active', nextRunAt: now + 12e4, lastFiredAt: now - 18e4, createdAt: now - 36e5, updatedAt: now - 18e4 },
      { id: 'sch-2222bbbb', name: 'nightly-cron', scriptId: 'demo-2', type: 'cron', cron: '0 3 * * *', profileContexts: ['p1'], enabled: true, state: 'paused', nextRunAt: now + 12 * 36e5, lastFiredAt: now - 12 * 36e5, createdAt: now - 864e5, updatedAt: now - 36e5 },
      { id: 'sch-3333cccc', name: 'once-done', scriptId: 'demo-3', type: 'once', atMs: now - 5e3, profileContexts: ['p2'], enabled: true, state: 'done', nextRunAt: null, lastFiredAt: now - 5e3, createdAt: now - 6e4, updatedAt: now - 5e3 },
    ];
    function demoSched(id) {
      const s = schedules.find((x) => x.id === id);
      if (!s) throw new Error('NOT_FOUND unknown schedule: ' + id);
      return s;
    }

    function push(execId, line) {
      (subs.get(execId) || []).forEach((cb) => { try { cb(line); } catch (_) {} });
    }

    window.automationApi = {
      getScripts: () => Promise.resolve(scripts.map((s) => Object.assign({}, s))),
      saveScript: (d) => new Promise((resolve) => {
        const existing = d.id && scripts.find((s) => s.id === d.id);
        if (existing) {
          Object.assign(existing, { name: d.name, code: d.code, version: existing.version + 1, updatedAt: Date.now() });
          resolve(Object.assign({}, existing));
        } else {
          const s = { id: 'demo-' + (scripts.length + 1), name: d.name, code: d.code, version: 1, status: 'draft', folder: d.folder || 'main', params: d.params || [], updatedAt: Date.now() };
          scripts.push(s);
          scriptExecs[s.id] = [];
          resolve(Object.assign({}, s));
        }
      }),
      runScript: (scriptId, values) => new Promise((resolve) => {
        const execId = 'ex-live-' + Date.now();
        (scriptExecs[scriptId] = scriptExecs[scriptId] || []).unshift(execId);
        executions.unshift({
          id: execId, scriptVersion: 'v?', profileId: 'demo', startTime: Date.now(),
          endTime: null, duration: null, status: 'RUNNING', error: null, stack: null, currentUrl: null, currentStep: 0,
        });
        logs[execId] = [];
        let seq = 0;
        const fail = /throw|fail/.test((scripts.find((s) => s.id === scriptId) || {}).code || '');
        const steps = [
          'execution ' + execId + ' started params=' + JSON.stringify(Object.keys(values || {})),
          'goto https://example.com',
          'waitUntil=domcontentloaded',
          fail ? 'step 3: throwing…' : 'page ready',
          fail ? null : 'SUCCEEDED',
        ];
        let i = 0;
        const tick = () => {
          if (i >= steps.length) return;
          const text = steps[i++];
          if (text == null) {
            const ex = executions.find((e) => e.id === execId);
            ex.status = 'FAILED'; ex.endTime = Date.now(); ex.duration = ex.endTime - ex.startTime;
            ex.error = { type: 'Error', code: 'EDEMO', message: 'demo failure at step 3', retriable: false };
            push(execId, { seq: ++seq, ts: Date.now(), level: 'error', text: ex.error.message });
            timers.delete(execId);
            return;
          }
          push(execId, { seq: ++seq, ts: Date.now(), level: 'info', text });
          if (i >= steps.length) {
            const ex = executions.find((e) => e.id === execId);
            ex.status = 'SUCCEEDED'; ex.endTime = Date.now(); ex.duration = ex.endTime - ex.startTime;
            timers.delete(execId);
            return;
          }
          timers.set(execId, setTimeout(tick, 700));
        };
        timers.set(execId, setTimeout(tick, 400));
        resolve({ executionId: execId });
      }),
      stopScript: (execId) => {
        clearTimeout(timers.get(execId)); timers.delete(execId);
        const ex = executions.find((e) => e.id === execId);
        if (ex && ex.status === 'RUNNING') {
          ex.status = 'CANCELLED'; ex.endTime = Date.now(); ex.duration = ex.endTime - ex.startTime;
          push(execId, { seq: 99, ts: Date.now(), level: 'warn', text: 'stopped by operator' });
        }
        return Promise.resolve();
      },
      pauseScript: (execId) => {
        push(execId, { seq: 98, ts: Date.now(), level: 'warn', text: 'pause acknowledged (demo)' });
        return Promise.resolve();
      },
      getExecutions: (scriptId) => Promise.resolve(
        (scriptExecs[scriptId] || []).map((id) => executions.find((e) => e.id === id)).filter(Boolean)
      ),
      getExecution: (id) => Promise.resolve(
        Object.assign({}, executions.find((e) => e.id === id) || null) || null
      ),
      getLogs: (execId) => Promise.resolve((logs[execId] || []).slice()),
      subscribeLog: (execId, cb) => {
        if (!subs.has(execId)) subs.set(execId, new Set());
        subs.get(execId).add(cb);
        return () => subs.get(execId).delete(cb);
      },
      // §27 views: tasks / schedules (deterministic fixtures; 409 path on illegal transition)
      tasks: {
        list: (opts) => {
          const o = opts || {};
          return Promise.resolve(tasks.filter((t) => (
            (o.status === undefined || t.status === o.status) &&
            (o.scriptId === undefined || t.scriptId === o.scriptId)
          )).map((t) => Object.assign({}, t)));
        },
        get: (id) => Promise.resolve(Object.assign({}, tasks.find((t) => t.id === id) || null) || null),
        cancel: (id) => demoTaskAct(id, 'cancel'),
        pause: (id) => demoTaskAct(id, 'pause'),
        resume: (id) => demoTaskAct(id, 'resume'),
        retry: (id) => demoTaskAct(id, 'retry'),
        enqueue: (spec) => {
          const t = {
            id: 'task-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4),
            scriptId: spec && spec.scriptId, profileContext: (spec && spec.profileContext) || { id: 'panel' },
            status: 'QUEUED', attempts: 0, maxAttempts: (spec && spec.maxAttempts) || 3,
            nextRunAt: Date.now(), lastError: null, createdAt: Date.now(), updatedAt: Date.now(), priority: 0,
          };
          tasks.unshift(t);
          return Promise.resolve(Object.assign({}, t));
        },
      },
      schedules: {
        list: () => Promise.resolve(schedules.map((s) => Object.assign({}, s))),
        add: (spec) => {
          const s = Object.assign({
            id: 'sch-' + Math.random().toString(36).slice(2, 10), enabled: true, state: 'active',
            lastFiredAt: null, nextRunAt: Date.now() + (spec.everyMs || 6e4), createdAt: Date.now(), updatedAt: Date.now(),
          }, spec);
          if (!s.profileContexts || !s.profileContexts.length) {
            return Promise.reject(new Error('VALIDATION profileContexts required (1+)'));
          }
          schedules.push(s);
          return Promise.resolve(Object.assign({}, s));
        },
        pause: (id) => { const s = demoSched(id); s.state = 'paused'; s.updatedAt = Date.now(); return Promise.resolve(Object.assign({}, s)); },
        resume: (id) => { const s = demoSched(id); s.state = 'active'; s.updatedAt = Date.now(); return Promise.resolve(Object.assign({}, s)); },
        trigger: (id) => {
          try {
            const s = demoSched(id);
            s.lastFiredAt = Date.now();
            if (s.type === 'once') { s.state = 'done'; s.nextRunAt = null; }
            return Promise.resolve(Object.assign({}, s));
          } catch (e) { return Promise.reject(e); }
        },
        remove: (id) => {
          const i = schedules.findIndex((x) => x.id === id);
          if (i < 0) return Promise.reject(new Error('NOT_FOUND unknown schedule: ' + id));
          schedules.splice(i, 1);
          return Promise.resolve({ removed: true });
        },
      },
    };
    state.demo = true;
  }

  /* ── mount / unmount ──────────────────────────────────────────────────── */

  /* ── templates fragment (panel-templates.js, optional page companion) ─── */

  // Mounts only when the bridge can serve templates.* — otherwise the region
  // stays empty (fragment would just show its own "bridge not available" bar).
  // ?demo=1: the fragment installs its own mock (panel's mock has no templates).
  function mountTemplates() {
    const el = document.getElementById('ap-templates');
    if (!el || !window.TemplatesPanel) return;
    const tpl = state.bridge && state.bridge.templates;
    if (tpl && typeof tpl.list === 'function') window.TemplatesPanel.mount(el, { templates: tpl });
    else if (state.demo) window.TemplatesPanel.mount(el);
  }

  // Mount-time liveness check for a preload-only host: the packaged copy ships
  // the facade without the automation runtime, so every invoke rejects with
  // "No handler registered for 'automation:...'". Degrade to the absent-bridge
  // state instead of rendering raw errors; genuine rejections keep today's path
  // so backend errors stay visible.
  async function probeBridge() {
    const br = state.bridge;
    if (!br || typeof br.getScripts !== 'function') return true;   // no probe possible
    try {
      await br.getScripts();
      return true;
    } catch (err) {
      if (!/No handler registered/i.test((err && err.message) || String(err))) return true;
      if (!state.root) return false;                               // unmounted while probing
      state.bridge = null;
      $('ap-bridge').hidden = false;
      $('ap-empty').hidden = false;
      applyDisabled();
      return false;
    }
  }

  // Additive bridge wiring for the RPA fragment: rpa.js reads
  // window.rpaApi.recorder, preload exposes the recorder on window.automationApi.
  // Attach it only when the host already supplied rpaApi — never create rpaApi
  // (that would claim a bridge that isn't there). Frozen contextBridge objects
  // reject the assignment; rpa.js reads automationApi.recorder directly then.
  function wireRpaRecorder() {
    const rec = window.automationApi && window.automationApi.recorder;
    if (rec && window.rpaApi && !window.rpaApi.recorder) window.rpaApi.recorder = rec;
  }

  function mount(container) {
    if (state.mounted) unmount();
    const root = state.root = document.createElement('div');
    root.className = 'ap-panel';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Automation script panel');
    root.innerHTML = SHELL;
    (container || document.body).appendChild(root);
    state.mounted = true;
    wire();

    const wantsDemo = /[?&]demo=1/.test(location.search);
    if (!window.automationApi && wantsDemo) installDemoApi();
    state.bridge = window.automationApi || null;
    $('ap-bridge').hidden = !!state.bridge;

    mountEditor();
    setStatus('ready');
    renderFiles();
    renderConsole();
    renderExecs();
    renderParams();
    applyDisabled();
    // §27 views: fresh view state per mount (Scripts is the default tab)
    state.view = 'scripts';
    state.apiRendered = false;
    state.tasks = []; state.tasksSig = '';
    state.schedules = []; state.schedSig = '';
    state.pendingRemove = null;
    state.detail = { exec: null, logs: [], maxSeq: 0, poll: null };
    switchView('scripts');
    syncWhenField();
    renderTasksState();
    renderSchedsState();
    renderDetail();
    if (!state.bridge) {
      $('ap-empty').hidden = false;
      mountTemplates();
      wireRpaRecorder();
    } else {
      probeBridge().then((live) => {
        if (!live || !state.root) return;   // degraded or unmounted while probing
        refreshScripts(false);
        mountTemplates();
        wireRpaRecorder();
      });
    }
  }

  function unmount() {
    stopPoll();
    stopTasksPoll();
    stopSchedPoll();
    stopDetailPoll();
    clearTimeout(state.removeTimer);
    state.removeTimer = null; state.pendingRemove = null;
    if (state.unsub) state.unsub();
    if (window.TemplatesPanel) window.TemplatesPanel.unmount();
    if (state.editor) state.editor.dispose();
    if (state.root) state.root.remove();
    state.mounted = false; state.root = null; state.editor = null;
    state.script = null; state.running = false; state.unsub = null;
  }

  window.AutomationPanel = { mount, unmount };

  // Auto-mount when the host page provides <div id="automation-panel">
  function boot() {
    const el = document.getElementById('automation-panel');
    if (el && !state.mounted) mount(el);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
