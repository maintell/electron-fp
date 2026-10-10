// ponytail: selector generation is pure fn over element descriptor; live capture wires via CDP Input events in P1 Electron glue.
// NO DOM access at import time — generateSelector takes a plain descriptor; isUnique is injectable (rpa.md §4 ceiling).
// publish gate consumes lintBlockingSleeps; recorder itself still emits gap waits (jittered), ban enforced at publish, not capture.
'use strict';

const qualities = {
  'data-testid': 100,
  id: 90,
  role: 80,
  name: 70,
  text: 60,
  css: 40,
  xpath: 20,
  coordinate: 10,
};

const DEBOUNCE_MS = 300; // consecutive input merge window (rpa.md §4.2)
const WAIT_GAP_MS = 2000; // gap between events → insert wait timeout node

function esc(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeText(t) {
  return String(t).trim().replace(/\s+/g, ' ');
}

// stable attribute suffix for css candidates: safe classes + data-test + type; skip dynamic/hash classes (anti-pattern)
function attrSuffix(attrs) {
  if (!attrs) return '';
  let out = '';
  if (typeof attrs.class === 'string') {
    for (const c of attrs.class.split(/\s+/)) {
      if (c && /^[A-Za-z_-][\w-]*$/.test(c)) out += '.' + c;
    }
  }
  if (attrs['data-test']) out += '[data-test="' + esc(attrs['data-test']) + '"]';
  if (attrs.type) out += '[type="' + esc(attrs.type) + '"]';
  return out;
}

function segPart(seg, withAttr, useNth) {
  let part = seg.tag || 'div';
  if (useNth && seg.nth > 1) part += ':nth-of-type(' + seg.nth + ')';
  if (withAttr && seg.attrs) part += attrSuffix(seg.attrs);
  return part;
}

// structural path short → long, bare before attrs, :nth-of-type only when bare failed and isUnique confirms
function buildCss(desc, isUnique) {
  const segs = (desc.path || []).map((s) => ({ tag: s.tag, nth: s.nth }));
  segs.push({ tag: desc.tag || 'div', nth: desc.nth, attrs: desc.attrs || {} });
  for (let k = 1; k <= segs.length; k++) {
    const slice = segs.slice(segs.length - k);
    for (const withAttr of [false, true]) {
      const cand = slice
        .map((s, i) => segPart(s, withAttr && i === slice.length - 1, false))
        .join(' > ');
      if (isUnique(cand)) return cand;
      if (slice.some((s) => s.nth > 1)) {
        const candNth = slice
          .map((s, i) => segPart(s, withAttr && i === slice.length - 1, true))
          .join(' > ');
        if (isUnique(candNth)) return candNth;
      }
    }
  }
  return null;
}

// priority: data-testid > id > role > name > text > css > xpath > coordinate (competitor-research §3 / rpa.md §3.1)
function generateSelector(desc, isUnique) {
  const uniq = typeof isUnique === 'function' ? isUnique : () => true; // omitted → unique-at-first-candidate
  const attrs = (desc && desc.attrs) || {};
  const q = (selector, selectorType) => ({ selector, selectorType, quality: qualities[selectorType] });

  if (attrs['data-testid']) return q('[data-testid="' + esc(attrs['data-testid']) + '"]', 'data-testid');

  if (attrs.id) {
    const id = String(attrs.id);
    if (/^[A-Za-z_-][\w-]*$/.test(id)) return q('#' + id, 'id');
    return q('[id="' + esc(id) + '"]', 'id');
  }

  if (attrs.role) {
    if (attrs['aria-label']) {
      return q('[role="' + esc(attrs.role) + '"][aria-label="' + esc(attrs['aria-label']) + '"]', 'role');
    }
    return q('[role="' + esc(attrs.role) + '"]', 'role');
  }

  if (attrs.name) return q('[name="' + esc(attrs.name) + '"]', 'name');

  if (desc.text && String(desc.text).trim()) return q('text=' + normalizeText(desc.text), 'text');

  const css = buildCss(desc, uniq);
  if (css) return q(css, 'css');

  // xpath: last structural resort, only when css failed uniqueness AND class present; relative only (no /html/... absolute)
  if (attrs.class) {
    return q('//' + (desc.tag || 'div') + '[@class="' + esc(attrs.class) + '"]', 'xpath');
  }

  if (desc.coords && typeof desc.coords.x === 'number' && typeof desc.coords.y === 'number') {
    return { selector: { x: desc.coords.x, y: desc.coords.y }, selectorType: 'coordinate', quality: qualities.coordinate };
  }

  return null; // nothing usable
}

// pure: flags raw fixed-timeout waits (humanize §7 wait-ms publish ban); smart waits (for: selector/text/url) pass through.
function lintBlockingSleeps(nodes) {
  if (!Array.isArray(nodes)) return [];
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (
      node &&
      node.type === 'wait' &&
      (node.kind === 'delay' || node.for === 'timeout') &&
      typeof node.ms === 'number'
    ) {
      out.push({ index: i, node, reason: 'blocking sleep: replace with smart wait (page.wait) before publish' });
    }
  }
  return out;
}

// factory: stateful recorder; nodes are plain objects matching rpa-ast shape (type present), fed to rpa-ast.validate downstream
function createRecorder(options) {
  const opts = options || {};
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const rng = opts.rng || null; // optional seeded-rng ({jitter} or {next}); absent → exact legacy ms
  const gen =
    typeof opts.generateSelector === 'function'
      ? opts.generateSelector
      : (d) => generateSelector(d, opts.isUnique);

  let nodes = [];
  let lastEventTs = null;
  let lastInput = null; // {key, ts, node} for debounce merge

  function attach(node, sel) {
    if (sel) {
      node.selector = sel.selector;
      node.selectorType = sel.selectorType;
      node.quality = sel.quality;
    }
    return node;
  }

  function record(evt) {
    if (!evt || typeof evt.kind !== 'string') return null;
    const ts = now();

    // debounce: consecutive input, same desc, within window → merge value into last fill, return null
    let inputKey = null;
    if (evt.kind === 'input') {
      inputKey = JSON.stringify(evt.desc || null);
      if (lastInput && lastInput.key === inputKey && ts - lastInput.ts <= DEBOUNCE_MS) {
        lastInput.node.value = evt.value;
        lastInput.ts = ts;
        lastEventTs = ts;
        return null;
      }
    }

    const sel = evt.desc ? gen(evt.desc) : null;
    let node;
    switch (evt.kind) {
      case 'click':
        node = attach({ type: 'click' }, sel);
        if (evt.button !== undefined) node.button = evt.button;
        break;
      case 'input':
        node = attach({ type: 'fill', value: evt.value }, sel);
        break;
      case 'keydown':
        node = attach({ type: 'press', key: evt.key }, sel);
        break;
      case 'select':
        node = attach({ type: 'select', value: evt.value }, sel);
        break;
      case 'navigate':
        node = { type: 'goto', url: evt.url };
        break;
      case 'scroll':
        node = attach({ type: 'scroll', y: evt.y }, sel);
        if (evt.toEnd !== undefined) node.toEnd = evt.toEnd;
        break;
      case 'change':
        node = attach({ type: 'upload', files: Array.isArray(evt.files) ? evt.files.slice() : [] }, sel);
        break;
      case 'wait-ms':
        node = { type: 'wait', kind: 'delay', ms: evt.ms };
        break;
      default:
        return null; // unknown kind — emit nothing
    }

    // gap > 2000ms between events → insert wait timeout node before the event
    if (evt.kind !== 'wait-ms' && lastEventTs !== null && ts - lastEventTs > WAIT_GAP_MS) {
      const gapMs = ts - lastEventTs;
      // ponytail: threshold fixed for stable detection; only recorded ms jitters.
      let ms = gapMs;
      if (rng) {
        const j =
          typeof rng.jitter === 'function'
            ? rng.jitter(gapMs, 0.25)
            : gapMs * (1 + (rng.next() * 2 - 1) * 0.25); // {next}-only rng shape
        ms = Math.max(1, Math.round(j));
      }
      nodes.push({ type: 'wait', kind: 'delay', ms });
    }

    if (evt.kind === 'click' && Number(evt.clickCount) >= 2) {
      // double-click ≥2 → two click nodes (replay performs two clicks)
      nodes.push(node);
      node = { ...node };
    }
    nodes.push(node);

    if (evt.kind === 'input') lastInput = { key: inputKey, ts, node };
    else lastInput = null;
    lastEventTs = ts;
    return node;
  }

  return {
    record,
    flush: () => null, // no pending partial state (input merges eagerly)
    events: () => nodes.slice(),
    stop: () => ({ version: 1, nodes: nodes.slice(), meta: { recordedAt: now() } }),
    reset: () => {
      nodes = [];
      lastEventTs = null;
      lastInput = null;
    },
  };
}

module.exports = { generateSelector, createRecorder, lintBlockingSleeps, qualities };
