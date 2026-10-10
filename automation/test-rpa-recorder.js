'use strict';

const { generateSelector, createRecorder, lintBlockingSleeps, qualities } = require('./runtime/rpa-recorder');
const { createRng } = require('./runtime/seeded-rng');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS ' + name);
  } catch (err) {
    fail++;
    console.log('FAIL ' + name + ' :: ' + err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// --- selector priority ---

check('sel data-testid beats id+name+text', () => {
  const r = generateSelector({
    tag: 'button',
    attrs: { 'data-testid': 'go', id: 'x', name: 'n' },
    text: 'Go',
  });
  assert(r.selectorType === 'data-testid', 'type: ' + r.selectorType);
  assert(r.selector === '[data-testid="go"]', 'selector: ' + r.selector);
  assert(r.quality === 100, 'quality');
});

check('sel id when no testid', () => {
  const r = generateSelector({ tag: 'div', attrs: { id: 'main' } });
  assert(r.selectorType === 'id', 'type');
  assert(r.selector === '#main', 'selector: ' + r.selector);
  assert(r.quality === 90, 'quality');
});

check('sel id starting with digit → [id=]', () => {
  const r = generateSelector({ tag: 'div', attrs: { id: '1st' } });
  assert(r.selectorType === 'id', 'type');
  assert(r.selector === '[id="1st"]', 'selector: ' + r.selector);
});

check('sel role+aria-label → role', () => {
  const r = generateSelector({ tag: 'div', attrs: { role: 'button', 'aria-label': 'OK' } });
  assert(r.selectorType === 'role', 'type');
  assert(r.selector === '[role="button"][aria-label="OK"]', 'selector: ' + r.selector);
  assert(r.quality === 80, 'quality');
});

check('sel name only → name', () => {
  const r = generateSelector({ tag: 'input', attrs: { name: 'email' } });
  assert(r.selectorType === 'name', 'type');
  assert(r.selector === '[name="email"]', 'selector');
  assert(r.quality === 70, 'quality');
});

check('sel text only → normalized text=', () => {
  const r = generateSelector({ tag: 'button', attrs: {}, text: '  Login   Now  ' });
  assert(r.selectorType === 'text', 'type');
  assert(r.selector === 'text=Login Now', 'selector: ' + r.selector);
  assert(r.quality === 60, 'quality');
});

check('sel css: short path not unique, true after attrs added', () => {
  const counts = new Map([
    ['div', 5],
    ['div.card', 1],
  ]);
  const isUnique = (s) => (counts.get(s) || 0) === 1;
  const r = generateSelector({ tag: 'div', attrs: { class: 'card' }, path: [{ tag: 'body' }] }, isUnique);
  assert(r.selectorType === 'css', 'type: ' + r.selectorType);
  assert(r.selector === 'div.card', 'selector: ' + r.selector);
  assert(r.quality === 40, 'quality');
});

check('sel xpath only when css fails uniqueness AND has class', () => {
  const isUnique = () => false; // registry: nothing unique → css fails
  const r = generateSelector({ tag: 'div', attrs: { class: 'card' }, path: [{ tag: 'body' }] }, isUnique);
  assert(r.selectorType === 'xpath', 'type: ' + r.selectorType);
  assert(r.selector === '//div[@class="card"]', 'selector: ' + r.selector);
  assert(r.quality === 20, 'quality');
});

check('sel coordinate last: no attrs+coords, css fails, no class', () => {
  const isUnique = () => false;
  const r = generateSelector(
    { tag: 'div', attrs: {}, path: [{ tag: 'body' }], coords: { x: 10, y: 20 } },
    isUnique
  );
  assert(r.selectorType === 'coordinate', 'type: ' + r.selectorType);
  assert(r.selector.x === 10 && r.selector.y === 20, 'coords');
  assert(r.quality === 10, 'quality');
});

check('quality ordering data-testid>id>role>name>text>css>xpath>coordinate', () => {
  const order = ['data-testid', 'id', 'role', 'name', 'text', 'css', 'xpath', 'coordinate'];
  for (let i = 0; i < order.length - 1; i++) {
    assert(qualities[order[i]] > qualities[order[i + 1]], order[i] + ' > ' + order[i + 1]);
  }
  assert(qualities['data-testid'] === 100, 'testid=100');
  assert(qualities.coordinate === 10, 'coordinate=10');
});

// --- recorder event → node mapping ---

check('rec click → click node', () => {
  let t = 0;
  const rec = createRecorder({ now: () => t });
  const n = rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'b' } } });
  assert(n && n.type === 'click', 'node type');
  assert(n.selector === '#b', 'selector via injected generateSelector default');
  const ev = rec.events();
  assert(ev.length === 1 && ev[0].type === 'click', 'events');
});

check('rec input debounce: same desc within 300ms merges → 1 fill last value', () => {
  let t = 0;
  const rec = createRecorder({ now: () => t });
  const desc = { tag: 'input', attrs: { id: 'u' } };
  const n1 = rec.record({ kind: 'input', desc, value: 'a' });
  t = 100;
  const n2 = rec.record({ kind: 'input', desc: { ...desc }, value: 'b' });
  assert(n1 && n1.type === 'fill', 'first fill');
  assert(n2 === null, 'debounced returns null');
  const ev = rec.events();
  assert(ev.length === 1, 'merged to single node, got ' + ev.length);
  assert(ev[0].value === 'b', 'last value wins: ' + ev[0].value);
});

check('rec gap>2000ms inserts wait timeout node', () => {
  let t = 0;
  const rec = createRecorder({ now: () => t });
  rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'a' } } });
  t = 3000;
  rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'b' } } });
  const ev = rec.events();
  assert(ev.length === 3, 'click, wait, click; got ' + ev.length);
  assert(ev[1].type === 'wait', 'wait inserted, got ' + ev[1].type);
  assert(ev[1].ms === 3000, 'wait ms = gap, got ' + ev[1].ms);
});

check('rec gap<=2000ms no wait inserted', () => {
  let t = 0;
  const rec = createRecorder({ now: () => t });
  rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'a' } } });
  t = 1500;
  rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'b' } } });
  const ev = rec.events();
  assert(ev.length === 2, 'no wait, got ' + ev.length);
  assert(ev.every((n) => n.type !== 'wait'), 'no wait node');
});

check('rec navigate → goto', () => {
  let t = 0;
  const rec = createRecorder({ now: () => t });
  const n = rec.record({ kind: 'navigate', url: 'https://example.test/' });
  assert(n.type === 'goto', 'type');
  assert(n.url === 'https://example.test/', 'url');
});

check('rec select → select', () => {
  let t = 0;
  const rec = createRecorder({ now: () => t });
  const n = rec.record({ kind: 'select', desc: { tag: 'select', attrs: { id: 's' } }, value: 'red' });
  assert(n.type === 'select', 'type');
  assert(n.value === 'red', 'value');
});

check('rec keydown → press', () => {
  let t = 0;
  const rec = createRecorder({ now: () => t });
  const n = rec.record({ kind: 'keydown', key: 'Enter', desc: { tag: 'input', attrs: { id: 'f' } } });
  assert(n.type === 'press', 'type');
  assert(n.key === 'Enter', 'key');
});

check('rec scroll / change(upload) / wait-ms map', () => {
  let t = 0;
  const rec = createRecorder({ now: () => t });
  const s = rec.record({ kind: 'scroll', desc: { tag: 'div', attrs: { id: 'c' } }, y: 500 });
  assert(s.type === 'scroll' && s.y === 500, 'scroll');
  const u = rec.record({ kind: 'change', desc: { tag: 'input', attrs: { id: 'file' } }, files: ['a.txt'] });
  assert(u.type === 'upload' && u.files.length === 1 && u.files[0] === 'a.txt', 'upload');
  const w = rec.record({ kind: 'wait-ms', ms: 500 });
  assert(w.type === 'wait' && w.ms === 500, 'wait-ms');
});

check('rec clickCount>=2 → two click nodes', () => {
  let t = 0;
  const rec = createRecorder({ now: () => t });
  const n = rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'd' } }, clickCount: 2 });
  assert(n && n.type === 'click', 'returns node');
  const ev = rec.events();
  assert(ev.length === 2, 'two nodes, got ' + ev.length);
  assert(ev[0].type === 'click' && ev[1].type === 'click', 'both click');
});

check('rec flush returns nothing, reset clears', () => {
  let t = 0;
  const rec = createRecorder({ now: () => t });
  rec.record({ kind: 'navigate', url: 'https://x.test/' });
  assert(rec.flush() === null, 'flush pending nothing');
  rec.reset();
  assert(rec.events().length === 0, 'reset clears');
});

check('rec stop shell {nodes, meta}, nodes pass minimal validate shape (type present)', () => {
  let t = 0;
  const rec = createRecorder({ now: () => t });
  rec.record({ kind: 'navigate', url: 'https://x.test/' });
  t = 100;
  rec.record({ kind: 'click', desc: { tag: 'a', attrs: { id: 'l' } } });
  const s = rec.stop();
  assert(s.version === 1, 'version');
  assert(Array.isArray(s.nodes) && s.nodes.length === 2, 'nodes array');
  assert(s.meta && typeof s.meta.recordedAt === 'number', 'meta.recordedAt');
  for (const n of s.nodes) {
    assert(typeof n.type === 'string' && n.type.length > 0, 'node.type present');
  }
});

// --- rng jitter + lintBlockingSleeps (humanize §7) ---

check('rng determinism: same seed same stream → identical wait ms', () => {
  const run = () => {
    let t = 0;
    const rec = createRecorder({ now: () => t, rng: createRng('rec1') });
    const waits = [];
    rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'a' } } });
    for (const gap of [2500, 4000, 3000, 5000]) {
      t += gap;
      rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'b' } } });
    }
    for (const n of rec.events()) if (n.type === 'wait') waits.push(n.ms);
    return waits;
  };
  const a = run();
  const b = run();
  assert(a.length === 4, '4 gap waits, got ' + a.length);
  assert(JSON.stringify(a) === JSON.stringify(b), 'identical: ' + JSON.stringify(a));
});

check('rng divergence: different seeds → at least one wait ms differs', () => {
  const run = (seed) => {
    let t = 0;
    const rec = createRecorder({ now: () => t, rng: createRng(seed) });
    rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'a' } } });
    for (const gap of [2500, 4000, 3000, 5000, 3500]) {
      t += gap;
      rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'b' } } });
    }
    return rec.events().filter((n) => n.type === 'wait').map((n) => n.ms);
  };
  const a = run('rec1');
  const b = run('rec2');
  assert(a.length === 5 && b.length === 5, 'lengths');
  assert(a.some((ms, i) => ms !== b[i]), 'at least one differs: ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b));
});

check('no-rng parity: gap 2500ms → exactly 2500 (legacy)', () => {
  let t = 0;
  const rec = createRecorder({ now: () => t });
  rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'a' } } });
  t = 2500;
  rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'b' } } });
  const ev = rec.events();
  assert(ev.length === 3, 'click, wait, click');
  assert(ev[1].ms === 2500, 'exact legacy ms, got ' + ev[1].ms);
});

check('jitter bounds: seeded run, all gap waits within [0.75×gap, 1.25×gap]', () => {
  let t = 0;
  const rec = createRecorder({ now: () => t, rng: createRng('bounds1') });
  const gaps = [2500, 4000, 10000];
  rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'a' } } });
  for (const gap of gaps) {
    t += gap;
    rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'b' } } });
  }
  const waits = rec.events().filter((n) => n.type === 'wait');
  assert(waits.length === gaps.length, 'count');
  waits.forEach((w, i) => {
    const lo = 0.75 * gaps[i];
    const hi = 1.25 * gaps[i];
    assert(w.ms >= lo && w.ms <= hi, 'gap ' + gaps[i] + ' → ' + w.ms + ' not in [' + lo + ',' + hi + ']');
    assert(Number.isInteger(w.ms) && w.ms >= 1, 'int ≥1');
  });
});

check('lintBlockingSleeps flags delay/timeout with index+reason, smart waits pass', () => {
  const nodes = [
    { type: 'click', selector: '#a' },
    { type: 'wait', kind: 'delay', ms: 2500 },
    { type: 'wait', for: 'timeout', ms: 1000 },
    { type: 'wait', for: 'selector', selector: '#b' },
    { type: 'wait', for: 'text', text: 'hi' },
    { type: 'wait', for: 'url', url: 'https://x.test/' },
  ];
  const out = lintBlockingSleeps(nodes);
  assert(out.length === 2, 'flags 2, got ' + out.length);
  assert(out[0].index === 1 && out[1].index === 2, 'indices 1,2');
  for (const e of out) {
    assert(e.node && e.reason === 'blocking sleep: replace with smart wait (page.wait) before publish', 'reason');
  }
  assert(lintBlockingSleeps([]).length === 0, 'empty → []');
});

check('lint on recorder output: stop().nodes → only gap waits flagged', () => {
  let t = 0;
  const rec = createRecorder({ now: () => t, rng: createRng('chain1') });
  rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'a' } } });
  t = 3000;
  rec.record({ kind: 'click', desc: { tag: 'button', attrs: { id: 'b' } } });
  const s = rec.stop();
  assert(s.nodes.length === 3, 'click, wait, click');
  const flagged = lintBlockingSleeps(s.nodes);
  assert(flagged.length === 1, 'only gap wait flagged, got ' + flagged.length);
  assert(flagged[0].index === 1 && flagged[0].node.type === 'wait', 'index 1 wait');
});

console.log('SUMMARY pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
