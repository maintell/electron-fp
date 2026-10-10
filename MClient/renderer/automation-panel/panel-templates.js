'use strict';
/* ============================================================================
 * Templates Panel fragment — standalone companion to panel.js (no framework).
 *
 * Mount: <div id="automation-templates"></div> + <script src="panel-templates.js">,
 *        TemplatesPanel.mount(el, api) / TemplatesPanel.unmount().
 * Demo:  open a host page with ?demo=1 (installs mock template data).
 *
 * ── api contract (bridge provided by preload/main) ──────────────────────────
 *  api.templates.list()    : Promise<templateMeta[]>  (envelope or raw array)
 *  api.templates.install() : Promise<{ installed, skipped }>
 *  templateMeta = { key, name, description, category, permissions,
 *                   parameters, code }
 * ========================================================================== */

(function () {
  var state = { mounted: false, root: null, api: null, items: [], filter: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function unwrap(p) {
    return Promise.resolve(p).then(function (r) {
      if (r && typeof r === 'object' && typeof r.ok === 'boolean') {
        if (!r.ok) throw new Error((r.error && r.error.message) || 'templates call failed');
        return r.data;
      }
      return r;
    });
  }

  function banner(msg) {
    var b = state.root && state.root.querySelector('#at-banner');
    if (!b) return;
    if (!msg) { b.hidden = true; b.textContent = ''; return; }
    b.hidden = false;
    b.textContent = msg;
  }

  function cardHtml(m) {
    var params = (m.parameters || []).map(function (p) {
      return '<li><code class="ap-tpl-code">' + esc(p.name) + '</code>' +
        ' <span class="ap-tpl-dim">' + esc(p.type || '') + (p.required ? ', required' : '') +
        (p.default !== undefined ? ', default=' + esc(JSON.stringify(p.default)) : '') + '</span></li>';
    }).join('');
    return '<article class="ap-card ap-tpl-card" data-key="' + esc(m.key) + '">' +
      '<header class="ap-card-head"><strong>' + esc(m.name) + '</strong>' +
      ' <span class="ap-tpl-dim">' + esc(m.category || '') + '</span></header>' +
      '<p class="ap-tpl-dim">' + esc(m.description || '') + '</p>' +
      (params ? '<ul class="ap-tpl-params">' + params + '</ul>' : '') +
      '<div class="ap-card-actions">' +
      '<button type="button" class="ap-btn" data-act="install">Install</button> ' +
      '<button type="button" class="ap-btn" data-act="preview">Preview</button>' +
      '</div>' +
      '<details class="ap-preview" hidden><summary>Code</summary>' +
      '<pre class="ap-tpl-codeblock">' + esc(m.code || '') + '</pre></details>' +
      '</article>';
  }

  function render() {
    var host = state.root.querySelector('#at-cards');
    if (!host) return;
    var q = (state.filter || '').toLowerCase();
    var items = state.items.filter(function (m) {
      if (!q) return true;
      return (m.name + ' ' + m.description + ' ' + m.category + ' ' + m.key).toLowerCase().indexOf(q) !== -1;
    });
    host.innerHTML = items.length
      ? items.map(cardHtml).join('')
      : '<p class="ap-tpl-dim">No templates found.</p>';
  }

  function refresh() {
    if (!state.api) { banner('Templates bridge not available — Install/List disabled.'); return; }
    banner(null);
    return unwrap(state.api.templates.list()).then(function (items) {
      state.items = items || [];
      render();
    }).catch(function (e) {
      banner('Failed to load templates: ' + (e && e.message || e));
    });
  }

  function onClick(ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!btn || !state.root.contains(btn)) return;
    var card = btn.closest('.ap-card');
    if (!card) return;
    var key = card.getAttribute('data-key');
    if (btn.getAttribute('data-act') === 'preview') {
      var det = card.querySelector('.ap-preview');
      if (det) { det.hidden = !det.hidden; det.open = !det.hidden; }
      return;
    }
    if (!state.api) { banner('Templates bridge not available — Install/List disabled.'); return; }
    btn.disabled = true;
    unwrap(state.api.templates.install()).then(function (r) {
      var n = Array.isArray(r && r.installed) ? r.installed.length : (r && r.skipped);
      banner(null);
      btn.textContent = 'Installed' + (n !== undefined ? ' (' + n + ')' : '');
    }).catch(function (e) {
      banner('Install failed' + (key ? ' (' + key + ')' : '') + ': ' + (e && e.message || e));
      btn.disabled = false;
    });
  }

  function onSearch(ev) {
    state.filter = ev.target.value || '';
    render();
  }

  function installDemoData() {
    // ponytail: two mock templates cover card+preview+install states; full catalog comes from the service.
    state.demoItems = [
      { key: 'open-website', name: 'Open Website', description: 'Navigate to a URL and log the page title.', category: 'navigation', permissions: { browser: true }, parameters: [{ name: 'url', type: 'string', required: true }], code: 'await browser.goto(params.url);' },
      { key: 'screenshot', name: 'Screenshot', description: 'Open a URL and save a screenshot.', category: 'utility', permissions: { browser: true }, parameters: [{ name: 'url', type: 'string', required: true }], code: 'await browser.goto(params.url);' },
    ];
    window.templatesApi = window.templatesApi || {
      templates: {
        list: function () { return Promise.resolve(state.demoItems.slice()); },
        install: function () { return Promise.resolve({ installed: state.demoItems.map(function (m) { return m.key; }), skipped: 0 }); },
      },
    };
  }

  function mount(container, api) {
    if (state.mounted) unmount();
    var root = state.root = document.createElement('div');
    root.className = 'ap-panel ap-templates';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Automation script templates');
    root.innerHTML =
      '<div id="at-bridge" class="ap-bridge-banner" hidden>Templates bridge not available — Install/List disabled.</div>' +
      '<div id="at-banner" class="ap-banner" role="alert" hidden></div>' +
      '<div class="ap-toolbar"><input id="at-search" class="ap-name" type="search" placeholder="Filter templates…" aria-label="Filter templates">' +
      ' <button id="at-refresh" class="ap-btn" type="button">Refresh</button></div>' +
      '<div id="at-cards" class="ap-cards"></div>';
    (container || document.body).appendChild(root);
    state.mounted = true;

    // ponytail: fragment-owned classes only (ap-tpl-*); shared ap-* classes reuse panel.css.
    if (!document.getElementById('ap-tpl-style')) {
      var st = document.createElement('style');
      st.id = 'ap-tpl-style';
      st.textContent = '.ap-tpl-dim{color:#9aa0a6}.ap-tpl-code{font-family:Consolas,ui-monospace,monospace}' +
        '.ap-tpl-card{border:1px solid #333;border-radius:4px;padding:10px 12px;margin:8px;background:#252526}' +
        '.ap-tpl-params{margin:6px 0;padding-left:18px}.ap-tpl-codeblock{background:#1e1e1e;border:1px solid #333;border-radius:4px;padding:8px;overflow:auto;max-height:220px}' +
        '.ap-cards{display:grid;gap:4px;padding:8px;overflow:auto}';
      document.head.appendChild(st);
    }

    // ponytail: explicit api arg wins; else window.templatesApi; ?demo=1 fabricates both.
    var wantsDemo = /[?&]demo=1/.test(location.search);
    if (!api && !window.templatesApi && wantsDemo) installDemoData();
    state.api = api || window.templatesApi || null;
    var bridgeEl = root.querySelector('#at-bridge');
    if (bridgeEl) bridgeEl.hidden = !!state.api;

    root.querySelector('#at-search').addEventListener('input', onSearch);
    root.querySelector('#at-refresh').addEventListener('click', refresh);
    root.addEventListener('click', onClick);

    if (!state.api) {
      banner('Templates bridge not available — Install/List disabled.');
      state.items = wantsDemo ? [] : [];
      render();
    } else {
      refresh();
    }
    return state.api;
  }

  function unmount() {
    if (state.root) state.root.remove();
    state.mounted = false; state.root = null; state.api = null;
    state.items = []; state.filter = '';
  }

  window.TemplatesPanel = { mount, unmount };
})();
