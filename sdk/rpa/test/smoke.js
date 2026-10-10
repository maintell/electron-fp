'use strict';
// Smoke test for @fp-automation/rpa:
//   build an AST (navigation + click + control flow) with the fluent builder,
//   serialize to JSON, then validate + round-trip + compile through the SAME
//   runtime schema (automation/runtime/rpa-ast.js). PASS/FAIL lines; exit 0 ==
//   the rpa layer's AST is schema-consistent and round-trips.
const { flow, v, ref, validateAst, astToScript, createAst } = require('../index.js');

let pass = 0;
let fail = 0;
function t(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('PASS ' + name);
  } else {
    fail++;
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

const f = flow();
f.goto('https://example.com');
f.wait({ for: 'selector', selector: '#app' });
f.click('#login');
f.fill('#user', 'alice');
f.if({ op: 'contains', left: v('title'), right: ref('Welcome') }, (then) => {
  then.log('welcome');
}, (alt) => {
  alt.click('#retry');
});
f.loop(3, (body) => {
  body.click('.next');
  body.wait({ for: 'timeout', ms: 100 });
});
f.readText('#result', 'result');

const ast = f.toAst();

// 1. schema validation via the runtime
const vres = validateAst(ast.nodes);
t('validateAst ok (schema-consistent)', vres.ok === true, JSON.stringify(vres.errors));
t('AST has expected node count', ast.nodes.length === 7, String(ast.nodes.length));
t('control flow present (if + loop)', ast.nodes.some((n) => n.type === 'if') && ast.nodes.some((n) => n.type === 'loop'));

// 2. serialize to JSON
const json = f.toJson();
const parsed = JSON.parse(json);
t('serialized as {nodes:[...]}', Array.isArray(parsed.nodes) && parsed.nodes.length === ast.nodes.length);

// 3. round-trip: JSON deep-equal
const round = JSON.parse(JSON.stringify(parsed)).nodes;
t('JSON round-trip is deep-equal', JSON.stringify(round) === JSON.stringify(ast.nodes));

// 4. round-trip via the runtime's own builder (createAst().fromJson)
const rebuilt = createAst().fromJson(json);
t('createAst().fromJson round-trips', JSON.stringify(rebuilt.nodes) === JSON.stringify(ast.nodes));
t('rebuilt AST re-validates', validateAst(rebuilt.nodes).ok === true);

// 5. compile through the same runtime
const out = astToScript(json);
t('astToScript returns {code,metadata}', !!out && typeof out.code === 'string' && !!out.metadata, JSON.stringify(out).slice(0, 90));
t('compiled code contains the ops', /goto/.test(out.code) && /click/.test(out.code), out.code.slice(0, 80));

console.log('SUMMARY pass=' + pass + ' fail=' + fail);
process.exitCode = fail === 0 ? 0 : 1;
const safety = setTimeout(() => process.exit(process.exitCode), 2000);
if (typeof safety.unref === 'function') safety.unref();
