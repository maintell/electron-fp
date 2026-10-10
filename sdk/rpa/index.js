'use strict';
// @fp-automation/rpa — fluent AST builder + serializer. The AST schema is the
// SAME as automation/runtime/rpa-ast.js (node types, child lists
// then/else/body/catchBody, cond ops, refs {var}/{param}/{const}); validation and
// compilation reuse that module directly — no second schema, no second runtime.
const rpaAst = require('../../automation/runtime/rpa-ast.js');

// Value refs (rpa-ast refValue): a literal is wrapped as {const:...}.
function ref(x) {
  if (x && typeof x === 'object' && ('var' in x || 'param' in x || 'const' in x)) return x;
  return { const: x };
}
function v(name) {
  return { var: name };
}
function p(name) {
  return { param: name };
}

class Flow {
  constructor(nodes) {
    this.nodes = nodes || [];
  }
  add(node) {
    this.nodes.push(node);
    return this;
  }
  goto(url) {
    return this.add({ type: 'goto', url });
  }
  click(selector) {
    return this.add({ type: 'click', selector });
  }
  clickText(text) {
    return this.add({ type: 'clickText', text });
  }
  clickRole(role) {
    return this.add({ type: 'clickRole', role });
  }
  fill(selector, value) {
    return this.add({ type: 'fill', selector, value });
  }
  type(selector, text) {
    return this.add({ type: 'type', selector, text });
  }
  press(selector, key) {
    return this.add({ type: 'press', selector, key });
  }
  select(selector, value) {
    return this.add({ type: 'select', selector, value });
  }
  wait(spec) {
    return this.add(Object.assign({ type: 'wait' }, spec));
  }
  readText(selector, outVar) {
    return this.add({ type: 'readText', selector, outVar });
  }
  readAttr(selector, name, outVar) {
    return this.add({ type: 'readAttr', selector, name, outVar });
  }
  scroll(opts) {
    return this.add(Object.assign({ type: 'scroll' }, opts));
  }
  upload(selector, files) {
    return this.add({ type: 'upload', selector, files });
  }
  downloadWait(pattern) {
    return this.add({ type: 'downloadWait', pattern });
  }
  screenshot(outVar) {
    return this.add({ type: 'screenshot', outVar });
  }
  execJs(expression, outVar) {
    return this.add({ type: 'execJs', expression, outVar });
  }
  setVar(name, value) {
    return this.add({ type: 'setVar', name, value });
  }
  log(msg) {
    return this.add({ type: 'log', msg });
  }
  throwError(message) {
    return this.add({ type: 'throw', message });
  }
  label(name) {
    return this.add({ type: 'label', name });
  }
  gotoLabel(label) {
    return this.add({ type: 'gotoLabel', label });
  }
  if(cond, thenFn, elseFn) {
    const node = { type: 'if', cond, then: block(thenFn) };
    if (elseFn) node.else = block(elseFn);
    return this.add(node);
  }
  loop(times, bodyFn) {
    return this.add({ type: 'loop', times, body: block(bodyFn) });
  }
  forEach(expr, bodyFn) {
    return this.add({ type: 'loop', forEach: expr, body: block(bodyFn) });
  }
  try(bodyFn, catchFn, catchName) {
    const node = { type: 'try', body: block(bodyFn), catchName: catchName || 'e' };
    if (catchFn) node.catchBody = block(catchFn);
    return this.add(node);
  }
  toAst() {
    return { nodes: this.nodes };
  }
  toJson() {
    return JSON.stringify({ nodes: this.nodes });
  }
}

function block(fn) {
  const f = new Flow();
  if (fn) fn(f);
  return f.nodes;
}

function flow() {
  return new Flow();
}

module.exports = {
  flow,
  Flow,
  ref,
  v,
  p,
  // re-exported from the runtime so the SDK and the runtime share ONE schema
  createAst: rpaAst.createAst,
  validateAst: rpaAst.validateAst,
  astToScript: rpaAst.astToScript,
  runAst: rpaAst.runAst,
  RpaError: rpaAst.RpaError,
};
