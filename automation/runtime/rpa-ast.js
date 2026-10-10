// ponytail: RPA compiles to AST executed by rpaExecutor which maps 1:1 onto script-runner browserApi — no second runtime.
'use strict';

const MAX_NODES = 5000;
const MAX_IF_LOOP_DEPTH = 8;
const MAX_LOOP_ITERS = 10000;
const MAX_STEPS = 100000;

class RpaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RpaError';
    this.code = 'RPA';
    this.retriable = false;
  }
}

const NODE_TYPES = new Set([
  'start', 'end',
  'goto',
  'click', 'clickText', 'clickRole',
  'fill', 'type', 'press', 'select',
  'wait',
  'readText', 'readAttr',
  'scroll',
  'upload', 'downloadWait', 'screenshot', 'execJs',
  'if', 'loop', 'setVar',
  'gotoLabel', 'label',
  'try', 'throw', 'log',
]);

const CHILD_LISTS = ['then', 'else', 'body', 'catchBody'];
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const COND_OPS = new Set(['==', '!=', '>', '<', '>=', '<=', 'contains', 'truthy']);
const FOREACH_RE = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+over\s+([A-Za-z_$][A-Za-z0-9_$]*)$/;
const WAIT_KINDS = new Set(['selector', 'text', 'url', 'timeout']);
const NEEDS_SELECTOR = new Set(['click', 'fill', 'type', 'select', 'readText', 'readAttr', 'upload']);
const OUT_VAR_TYPES = new Set(['readText', 'readAttr', 'screenshot', 'execJs']);

function normalizeAst(astJson) {
  if (typeof astJson === 'string') astJson = JSON.parse(astJson);
  if (Array.isArray(astJson)) return astJson;
  if (astJson && Array.isArray(astJson.nodes)) return astJson.nodes;
  throw new RpaError('ast must be {nodes:[]} | nodes[] | json string');
}

function walkTree(list, visit) {
  if (!Array.isArray(list)) return;
  for (const node of list) {
    if (!node || typeof node !== 'object') continue;
    visit(node);
    for (const key of CHILD_LISTS) walkTree(node[key], visit);
  }
}

function validateAst(nodes) {
  const errors = [];
  let count = 0;
  const labels = new Set();
  const labelOrder = [];
  const gotoLabels = [];

  const badIdent = (v) => typeof v !== 'string' || !IDENT.test(v);

  function walk(list, ifDepth) {
    if (list == null) return;
    if (!Array.isArray(list)) {
      errors.push('body must be array');
      return;
    }
    for (const node of list) {
      count++;
      if (!node || typeof node !== 'object') {
        errors.push('invalid node at index');
        continue;
      }
      const t = node.type;
      if (typeof t !== 'string' || !NODE_TYPES.has(t)) {
        errors.push('unknown type: ' + String(t));
        continue;
      }
      if (NEEDS_SELECTOR.has(t) && (typeof node.selector !== 'string' || !node.selector)) {
        errors.push(t + ' missing selector');
      }
      if (t === 'goto' && (typeof node.url !== 'string' || !node.url)) {
        errors.push('goto missing url');
      }
      if (t === 'clickText' && (typeof node.text !== 'string' || !node.text)) {
        errors.push('clickText missing text');
      }
      if (t === 'clickRole' && (typeof node.role !== 'string' || !node.role)) {
        errors.push('clickRole missing role');
      }
      if (t === 'press' && typeof node.key !== 'string') errors.push('press missing key');
      if (t === 'readAttr' && (typeof node.name !== 'string' || !node.name)) {
        errors.push('readAttr missing name');
      }
      if (OUT_VAR_TYPES.has(t) && node.outVar !== undefined && badIdent(node.outVar)) {
        errors.push(t + ' invalid outVar: ' + String(node.outVar));
      }
      if (t === 'upload' && !Array.isArray(node.files)) errors.push('upload missing files[]');
      if (t === 'execJs' && (typeof node.expression !== 'string' || !node.expression)) {
        errors.push('execJs missing expression');
      }
      if (t === 'wait') {
        if (!WAIT_KINDS.has(node.for)) errors.push('wait bad for: ' + String(node.for));
        else if (node.for === 'selector' && !node.selector) errors.push('wait missing selector');
        else if (node.for === 'text' && (!node.selector || node.text == null)) errors.push('wait missing text/selector');
        else if (node.for === 'url' && !node.url) errors.push('wait missing url');
        else if (node.for === 'timeout' && !(typeof node.ms === 'number' && node.ms >= 0)) {
          errors.push('wait missing ms');
        }
      }
      if (t === 'if') {
        const c = node.cond;
        if (!c || typeof c !== 'object' || !COND_OPS.has(c.op) || c.left === undefined) {
          errors.push('if bad cond');
        } else if (c.op !== 'truthy' && c.right === undefined) {
          errors.push('if cond missing right');
        }
        if (ifDepth + 1 > MAX_IF_LOOP_DEPTH) {
          errors.push('if/loop nesting depth > ' + MAX_IF_LOOP_DEPTH);
        }
        walk(node.then, ifDepth + 1);
        walk(node.else, ifDepth + 1);
        continue;
      }
      if (t === 'loop') {
        if (node.times === undefined && !node.forEach) errors.push('loop needs times|forEach');
        if (node.forEach !== undefined && !FOREACH_RE.test(String(node.forEach))) {
          errors.push('loop bad forEach: ' + String(node.forEach));
        }
        if (ifDepth + 1 > MAX_IF_LOOP_DEPTH) {
          errors.push('if/loop nesting depth > ' + MAX_IF_LOOP_DEPTH);
        }
        walk(node.body, ifDepth + 1);
        continue;
      }
      if (t === 'setVar' && badIdent(node.name)) errors.push('setVar invalid name: ' + String(node.name));
      if (t === 'label') {
        if (badIdent(node.name)) errors.push('label invalid name: ' + String(node.name));
        else {
          if (labels.has(node.name)) errors.push('duplicate label: ' + node.name);
          labels.add(node.name);
          labelOrder.push(node.name);
        }
      }
      if (t === 'gotoLabel') {
        if (typeof node.label !== 'string' || !node.label) errors.push('gotoLabel missing label');
        else gotoLabels.push(node.label);
      }
      if (t === 'try') {
        if (badIdent(node.catchName)) errors.push('try invalid catchName: ' + String(node.catchName));
        if (!Array.isArray(node.body)) errors.push('try missing body[]');
        walk(node.body, ifDepth);
        walk(node.catchBody, ifDepth);
        continue;
      }
      if (t === 'throw' && node.message === undefined && node.valueFromVar === undefined) {
        errors.push('throw missing message');
      }
      if (t === 'log' && node.msg === undefined && node.valueFromVar === undefined) {
        errors.push('log missing msg');
      }
      for (const key of CHILD_LISTS) walk(node[key], ifDepth);
    }
  }

  walk(nodes, 0);
  if (count > MAX_NODES) errors.push('node cap exceeded: ' + count + ' > ' + MAX_NODES);
  for (const g of gotoLabels) {
    if (!labels.has(g)) errors.push('dangling label: ' + g);
  }
  return { ok: errors.length === 0, errors };
}

function createAst() {
  return {
    nodes: [],
    add(node) {
      this.nodes.push(node);
      return this;
    },
    validate() {
      return validateAst(this.nodes);
    },
    toJson() {
      return JSON.stringify({ nodes: this.nodes });
    },
    fromJson(json) {
      const o = typeof json === 'string' ? JSON.parse(json) : json;
      this.nodes = Array.isArray(o) ? o.slice() : Array.isArray(o && o.nodes) ? o.nodes.slice() : [];
      return this;
    },
  };
}

function indexLabels(nodes, map) {
  nodes.forEach((node, i) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'label') map.set(node.name, { container: nodes, index: i });
    for (const key of CHILD_LISTS) {
      if (Array.isArray(node[key])) indexLabels(node[key], map);
    }
  });
}

function refValue(ref, vars, params) {
  if (ref === null || typeof ref !== 'object') return ref;
  if ('var' in ref) return vars.get(ref.var);
  if ('param' in ref) return params[ref.param];
  if ('const' in ref) return ref.const;
  return undefined;
}

function evalCond(cond, vars, params) {
  const l = refValue(cond.left, vars, params);
  const r = refValue(cond.right, vars, params);
  switch (cond.op) {
    case '==': return l === r;
    case '!=': return l !== r;
    case '>': return l > r;
    case '<': return l < r;
    case '>=': return l >= r;
    case '<=': return l <= r;
    case 'contains': return String(l).includes(String(r));
    case 'truthy': return !!l;
    default: throw new RpaError('bad cond op: ' + String(cond.op));
  }
}

function resolveNodeValue(node, vars, params) {
  if (node.valueFromVar !== undefined) return vars.get(node.valueFromVar);
  if (node.valueFrom !== undefined) {
    const s = String(node.valueFrom);
    if (s.startsWith('param.')) return params[s.slice('param.'.length)];
    if (s.startsWith('var.')) return vars.get(s.slice('var.'.length));
    throw new RpaError('bad valueFrom: ' + s);
  }
  return node.value;
}

function innerTextExpr(selector) {
  return '(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); return el ? el.innerText : ""; })()';
}

function scrollExpr(node) {
  if (node.toEnd) return 'window.scrollTo(0, document.body.scrollHeight)';
  if (node.selector) return 'document.querySelector(' + JSON.stringify(node.selector) + ').scrollIntoView()';
  return 'window.scrollBy(0, ' + (Number(node.y) || 0) + ')';
}

function isCatchable(e) {
  return e instanceof RpaError || (e && (e.name === 'RpaError' || e.name === 'ScriptError'));
}

function stepWrap(e, stepNo, node) {
  if (e instanceof RpaError && e.stepIndex != null) return e;
  const w = new RpaError('step ' + stepNo + ' (' + node.type + '): ' + ((e && e.message) || e));
  w.stepIndex = stepNo;
  w.nodeType = node.type;
  w.retriable = false;
  if (e && e.stack) w.stack = e.stack;
  return w;
}

/**
 * Execute AST against a sandbox mapping 1:1 onto script-runner browserApi.
 * sandbox = {page, browser, params, delay, log, screenshot}
 * Returns {vars: Object, logs: []}.
 * Ceiling: gotoLabel only jumps within the active list or an ancestor list
 * (unwinding nested if/loop/try frames); jumping into an inactive nested body
 * throws. Add cross-frame entry if a builder ever emits it.
 */
function runAst(astJson, sandbox) {
  const nodes = normalizeAst(astJson);
  const v = validateAst(nodes);
  if (!v.ok) throw new RpaError('invalid ast: ' + v.errors.join('; '));

  const page = sandbox && sandbox.page;
  const browser = sandbox && sandbox.browser;
  const params = Object.assign({}, (sandbox && sandbox.params) || {});
  const delay = (sandbox && sandbox.delay) || (async () => { throw new RpaError('delay not available'); });
  const logs = [];
  const vars = new Map();
  const labels = new Map();
  indexLabels(nodes, labels);

  let stepNo = 0;
  let halted = false;
  let jump = null; // {container, index}

  async function execList(list) {
    let i = 0;
    while (i < list.length && !halted) {
      const node = list[i];
      stepNo++;
      if (stepNo > MAX_STEPS) throw new RpaError('step cap exceeded: ' + MAX_STEPS);
      try {
        await execNode(node);
      } catch (e) {
        throw stepWrap(e, stepNo, node);
      }
      if (halted) return;
      if (jump) {
        if (jump.container === list) {
          i = jump.index + 1;
          jump = null;
          continue;
        }
        return; // propagate to ancestor frame that owns the label list
      }
      i++;
    }
  }

  async function execNode(n) {
    switch (n.type) {
      case 'start':
        return;
      case 'end':
        halted = true;
        return;
      case 'goto':
        await browser.goto(String(n.url));
        return;
      case 'click': {
        let sel = String(n.selector);
        if (n.selectorType === 'text') sel = 'text=' + sel;
        else if (n.selectorType === 'xpath') sel = 'xpath=' + sel;
        await page.click(sel);
        return;
      }
      case 'clickText':
        if (typeof page.clickText === 'function') await page.clickText(n.text);
        else await page.click('text=' + n.text);
        return;
      case 'clickRole': {
        let sel = '[role="' + n.role + '"]';
        if (n.name) sel += '[aria-label="' + n.name + '"]';
        await page.click(sel);
        return;
      }
      case 'fill':
        await page.fill(String(n.selector), toStr(resolveNodeValue(n, vars, params)));
        return;
      case 'type':
        await page.type(String(n.selector), toStr(resolveNodeValue(n, vars, params)));
        return;
      case 'press':
        await page.press(n.selector ? String(n.selector) : 'body', String(n.key));
        return;
      case 'select': {
        const fn = page.select || page.selectOption;
        if (typeof fn !== 'function') throw new RpaError('page.select not available');
        await fn.call(page, String(n.selector), toStr(resolveNodeValue(n, vars, params)));
        return;
      }
      case 'wait':
        if (n.for === 'selector') await page.waitForSelector(String(n.selector), { visible: n.visible === true });
        else if (n.for === 'text') await page.waitForText(String(n.selector), n.text);
        else if (n.for === 'url') await page.waitForURL(n.url);
        else await delay(n.ms);
        return;
      case 'readText':
        vars.set(n.outVar, await page.evaluate(innerTextExpr(String(n.selector))));
        return;
      case 'readAttr': {
        let val;
        if (typeof page.getAttribute === 'function') val = await page.getAttribute(String(n.selector), n.name);
        else {
          val = await page.evaluate(
            '(() => { const el = document.querySelector(' + JSON.stringify(String(n.selector)) + '); return el ? el.getAttribute(' + JSON.stringify(String(n.name)) + ') : null; })()'
          );
        }
        if (n.outVar) vars.set(n.outVar, val);
        return;
      }
      case 'scroll':
        await page.evaluate(scrollExpr(n));
        return;
      case 'upload':
        if (typeof page.setInputFiles === 'function') await page.setInputFiles(String(n.selector), n.files);
        else if (sandbox.upload && typeof sandbox.upload.setFiles === 'function') await sandbox.upload.setFiles(String(n.selector), n.files);
        else throw new RpaError('upload not available');
        return;
      case 'downloadWait':
        if (sandbox.download && typeof sandbox.download.wait === 'function') await sandbox.download.wait();
        else throw new RpaError('download.wait not available');
        return;
      case 'screenshot': {
        const fn = typeof sandbox.screenshot === 'function' ? sandbox.screenshot : page.screenshot;
        const ctx = typeof sandbox.screenshot === 'function' ? sandbox : page;
        const out = await fn.call(ctx);
        if (n.outVar) vars.set(n.outVar, out);
        return;
      }
      case 'execJs': {
        const out = await page.evaluate(n.expression);
        if (n.outVar) vars.set(n.outVar, out);
        return;
      }
      case 'if':
        await execList(evalCond(n.cond, vars, params) ? (n.then || []) : (n.else || []));
        return;
      case 'loop': {
        if (n.forEach !== undefined) {
          const m = FOREACH_RE.exec(String(n.forEach));
          if (!m) throw new RpaError('bad forEach: ' + n.forEach);
          const arr = vars.get(m[2]);
          if (!Array.isArray(arr)) throw new RpaError('forEach array missing: ' + m[2]);
          if (arr.length > MAX_LOOP_ITERS) throw new RpaError('loop cap exceeded: ' + arr.length);
          for (let k = 0; k < arr.length; k++) {
            vars.set(m[1], arr[k]);
            await execList(n.body || []);
            if (halted || jump) return;
          }
          return;
        }
        let t = n.times;
        if (t && typeof t === 'object' && 'var' in t) t = vars.get(t.var);
        t = Number(t);
        if (!Number.isFinite(t) || t < 0) throw new RpaError('bad loop times: ' + String(n.times));
        if (t > MAX_LOOP_ITERS) throw new RpaError('loop cap exceeded: ' + t);
        const rounds = Math.floor(t);
        for (let k = 0; k < rounds; k++) {
          await execList(n.body || []);
          if (halted || jump) return;
        }
        return;
      }
      case 'setVar':
        if (n.valueFromVar !== undefined) vars.set(n.name, vars.get(n.valueFromVar));
        else if (n.valueFromParam !== undefined) vars.set(n.name, params[n.valueFromParam]);
        else vars.set(n.name, n.value);
        return;
      case 'label':
        return; // marker; jump table pre-indexed
      case 'gotoLabel': {
        const target = labels.get(n.label);
        if (!target) throw new RpaError('dangling label: ' + n.label);
        jump = { container: target.container, index: target.index };
        return;
      }
      case 'try':
        try {
          await execList(n.body || []);
        } catch (e) {
          if (!isCatchable(e)) throw e;
          vars.set(n.catchName, String((e && e.name) || 'Error') + ': ' + String((e && e.message) || e));
          await execList(n.catchBody || []);
        }
        return;
      case 'throw':
        throw new RpaError(n.valueFromVar !== undefined ? String(vars.get(n.valueFromVar)) : String(n.message));
      case 'log': {
        const m = n.valueFromVar !== undefined ? vars.get(n.valueFromVar) : n.msg;
        logs.push(m);
        if (typeof sandbox.log === 'function') sandbox.log(m);
        return;
      }
      default:
        throw new RpaError('unknown type: ' + String(n.type));
    }
  }

  async function main() {
    await execList(nodes);
    if (jump) throw new RpaError('gotoLabel target not on active frame');
    return { vars: Object.fromEntries(vars), logs };
  }
  return main();
}

function toStr(v) {
  if (v === undefined || v === null) return v === null ? '' : '';
  return typeof v === 'string' ? v : String(v);
}

// ponytail: line-per-node generator for linear + if + loop subset.
// Ceiling: label/gotoLabel emitted as comments — no structured control-flow
// recovery (labels → while(true)/break needs CFG analysis); extend when the
// builder actually imports labeled flows into the Script store.
function astToScript(astJson) {
  const nodes = normalizeAst(astJson);
  const v = validateAst(nodes);
  if (!v.ok) throw new RpaError('invalid ast: ' + v.errors.join('; '));
  const lines = [];
  let ind = 0;
  let count = 0;
  const w = (s) => lines.push('  '.repeat(ind) + s);

  const genRef = (r) => {
    if (r === null || typeof r !== 'object') return JSON.stringify(r);
    if ('var' in r) return 'vars_[' + JSON.stringify(r.var) + ']';
    if ('param' in r) return 'params[' + JSON.stringify(r.param) + ']';
    if ('const' in r) return JSON.stringify(r.const);
    return 'undefined';
  };
  const genCond = (c) => {
    const l = genRef(c.left);
    const r = genRef(c.right);
    if (c.op === 'contains') return 'String(' + l + ').includes(String(' + r + '))';
    if (c.op === 'truthy') return '!!(' + l + ')';
    return '(' + l + ' ' + c.op + ' ' + r + ')';
  };
  const genValue = (n) => {
    if (n.valueFromVar !== undefined) return 'vars_[' + JSON.stringify(n.valueFromVar) + ']';
    if (n.valueFrom !== undefined) {
      const s = String(n.valueFrom);
      if (s.startsWith('param.')) return 'params[' + JSON.stringify(s.slice(6)) + ']';
      if (s.startsWith('var.')) return 'vars_[' + JSON.stringify(s.slice(4)) + ']';
      throw new RpaError('bad valueFrom: ' + s);
    }
    return JSON.stringify(n.value === undefined ? '' : n.value);
  };
  function gen(list) {
    for (const n of list) {
      count++;
      switch (n.type) {
        case 'start':
          break;
        case 'end':
          w('return;');
          break;
        case 'goto':
          w('await browser.goto(' + JSON.stringify(n.url) + ');');
          break;
        case 'click': {
          let sel = JSON.stringify(n.selector);
          if (n.selectorType === 'text') sel = JSON.stringify('text=' + n.selector);
          else if (n.selectorType === 'xpath') sel = JSON.stringify('xpath=' + n.selector);
          w('await page.click(' + sel + ');');
          break;
        }
        case 'clickText':
          w('await page.click(' + JSON.stringify('text=' + n.text) + ');');
          break;
        case 'clickRole': {
          let sel = '[role="' + n.role + '"]';
          if (n.name) sel += '[aria-label="' + n.name + '"]';
          w('await page.click(' + JSON.stringify(sel) + ');');
          break;
        }
        case 'fill':
          w('await page.fill(' + JSON.stringify(n.selector) + ', String(' + genValue(n) + '));');
          break;
        case 'type':
          w('await page.type(' + JSON.stringify(n.selector) + ', String(' + genValue(n) + '));');
          break;
        case 'press':
          w('await page.press(' + JSON.stringify(n.selector || 'body') + ', ' + JSON.stringify(n.key) + ');');
          break;
        case 'select':
          w('await page.select(' + JSON.stringify(n.selector) + ', String(' + genValue(n) + '));');
          break;
        case 'wait':
          if (n.for === 'selector') {
            w('await page.waitForSelector(' + JSON.stringify(n.selector) + ', { visible: ' + (n.visible === true) + ' });');
          } else if (n.for === 'text') {
            w('await page.waitForText(' + JSON.stringify(n.selector) + ', ' + JSON.stringify(n.text) + ');');
          } else if (n.for === 'url') {
            w('await page.waitForURL(' + JSON.stringify(n.url) + ');');
          } else {
            w('await delay(' + JSON.stringify(n.ms) + ');');
          }
          break;
        case 'readText':
          w((n.outVar ? 'vars_[' + JSON.stringify(n.outVar) + '] = ' : '') +
            'await page.evaluate(' + JSON.stringify(innerTextExpr(n.selector)) + ');');
          break;
        case 'readAttr':
          w((n.outVar ? 'vars_[' + JSON.stringify(n.outVar) + '] = ' : '') +
            'await page.getAttribute(' + JSON.stringify(n.selector) + ', ' + JSON.stringify(n.name) + ');');
          break;
        case 'scroll':
          w('await page.evaluate(' + JSON.stringify(scrollExpr(n)) + ');');
          break;
        case 'upload':
          w('await page.setInputFiles(' + JSON.stringify(n.selector) + ', ' + JSON.stringify(n.files) + ');');
          break;
        case 'downloadWait':
          w('await download.wait();');
          break;
        case 'screenshot':
          w((n.outVar ? 'vars_[' + JSON.stringify(n.outVar) + '] = ' : '') + 'await page.screenshot();');
          break;
        case 'execJs':
          w((n.outVar ? 'vars_[' + JSON.stringify(n.outVar) + '] = ' : '') +
            'await page.evaluate(' + JSON.stringify(n.expression) + ');');
          break;
        case 'if':
          w('if (' + genCond(n.cond) + ') {');
          ind++;
          gen(n.then || []);
          ind--;
          if (Array.isArray(n.else) && n.else.length) {
            w('} else {');
            ind++;
            gen(n.else);
            ind--;
          }
          w('}');
          break;
        case 'loop': {
          if (n.forEach !== undefined) {
            const m = FOREACH_RE.exec(String(n.forEach));
            if (!m) throw new RpaError('bad forEach: ' + n.forEach);
            w('for (const ' + m[1] + ' of vars_[' + JSON.stringify(m[2]) + ']) {');
            ind++;
            gen(n.body || []);
            ind--;
            w('}');
          } else {
            let t = n.times;
            const timesExpr =
              t && typeof t === 'object' && 'var' in t
                ? 'Number(vars_[' + JSON.stringify(t.var) + '])'
                : String(Number(t) || 0);
            w('for (let __i = 0; __i < ' + timesExpr + '; __i++) {');
            ind++;
            gen(n.body || []);
            ind--;
            w('}');
          }
          break;
        }
        case 'setVar': {
          let rhs;
          if (n.valueFromVar !== undefined) rhs = 'vars_[' + JSON.stringify(n.valueFromVar) + ']';
          else if (n.valueFromParam !== undefined) rhs = 'params[' + JSON.stringify(n.valueFromParam) + ']';
          else rhs = JSON.stringify(n.value);
          w('vars_[' + JSON.stringify(n.name) + '] = ' + rhs + ';');
          break;
        }
        case 'label':
          w('/* label: ' + n.name + ' */');
          break;
        case 'gotoLabel':
          w('/* gotoLabel: ' + n.label + ' (ceiling: labels not recovered as structured JS) */');
          break;
        case 'try':
          w('try {');
          ind++;
          gen(n.body || []);
          ind--;
          w('} catch (e) {');
          ind++;
          w('vars_[' + JSON.stringify(n.catchName) + '] = e.name + ": " + e.message;');
          gen(n.catchBody || []);
          ind--;
          w('}');
          break;
        case 'throw':
          if (n.valueFromVar !== undefined) {
            w('throw new Error(String(vars_[' + JSON.stringify(n.valueFromVar) + ']));');
          } else {
            w('throw new Error(' + JSON.stringify(String(n.message)) + ');');
          }
          break;
        case 'log':
          w('log(' + (n.valueFromVar !== undefined ? 'vars_[' + JSON.stringify(n.valueFromVar) + ']' : JSON.stringify(n.msg)) + ');');
          break;
        default:
          throw new RpaError('unknown type: ' + String(n.type));
      }
    }
  }

  w('const vars_ = {};');
  gen(nodes);
  return {
    code: lines.join('\n'),
    metadata: {
      nodes: count,
      ceiling: 'linear+if+loop+try correct; label/gotoLabel are comments only (needs CFG for while(true)/break)',
    },
  };
}

module.exports = {
  createAst,
  runAst,
  astToScript,
  RpaError,
  validateAst,
};
