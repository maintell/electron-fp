'use strict';

const { createAst, runAst, astToScript, RpaError } = require('./runtime/rpa-ast');

let pass = 0;
let fail = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++;
      console.log('PASS ' + name);
    })
    .catch((err) => {
      fail++;
      console.log('FAIL ' + name + ' :: ' + err.message);
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function makeSandbox(over) {
  const calls = [];
  const logs = [];
  const sandbox = {
    calls,
    logs,
    params: { kw: 'hello' },
    browser: {
      goto: async (u) => {
        calls.push('goto ' + u);
      },
    },
    page: {
      click: async (s) => {
        calls.push('click ' + s);
      },
      fill: async (s, val) => {
        calls.push('fill ' + s + ' ' + val);
      },
      type: async (s, val) => {
        calls.push('type ' + s + ' ' + val);
      },
      press: async (s, k) => {
        calls.push('press ' + s + ' ' + k);
      },
      select: async (s, val) => {
        calls.push('select ' + s + ' ' + val);
      },
      waitForSelector: async (s) => {
        calls.push('waitForSelector ' + s);
      },
      waitForText: async (s, t) => {
        calls.push('waitForText ' + s + ' ' + t);
      },
      waitForURL: async (u) => {
        calls.push('waitForURL ' + u);
      },
      evaluate: async () => {
        calls.push('evaluate');
        return 42;
      },
      screenshot: async () => 'png',
    },
    delay: async (ms) => {
      calls.push('delay ' + ms);
    },
    log: (m) => {
      logs.push(m);
    },
  };
  return Object.assign(sandbox, over || {});
}

function ifNest(depth) {
  let body = [{ type: 'log', msg: 'x' }];
  for (let i = 0; i < depth; i++) {
    body = [{ type: 'if', cond: { left: { const: 1 }, op: 'truthy' }, then: body, else: [] }];
  }
  return body;
}

async function main() {
  await check('linear replay order correct', async () => {
    const sb = makeSandbox();
    const r = await runAst(
      {
        nodes: [
          { type: 'start' },
          { type: 'goto', url: 'https://x' },
          { type: 'click', selector: '#a' },
          { type: 'fill', selector: '#b', value: 'v1' },
          { type: 'wait', for: 'selector', selector: '#c' },
          { type: 'wait', for: 'timeout', ms: 50 },
          { type: 'end' },
        ],
      },
      sb
    );
    assert(
      sb.calls.join('|') === 'goto https://x|click #a|fill #b v1|waitForSelector #c|delay 50',
      'calls: ' + sb.calls.join('|')
    );
    assert(r.logs && Array.isArray(r.logs), 'logs array');
  });

  await check('valueFromVar / valueFrom param fill', async () => {
    const sb = makeSandbox();
    await runAst(
      {
        nodes: [
          { type: 'setVar', name: 'word', value: 'world' },
          { type: 'fill', selector: '#v', valueFromVar: 'word' },
          { type: 'fill', selector: '#p', valueFrom: 'param.kw' },
        ],
      },
      sb
    );
    assert(sb.calls.join('|') === 'fill #v world|fill #p hello', 'calls: ' + sb.calls.join('|'));
  });

  await check('if true/false branches', async () => {
    for (const [flag, exp] of [
      [true, 'click #t'],
      [false, 'click #f'],
    ]) {
      const sb = makeSandbox();
      await runAst(
        {
          nodes: [
            { type: 'setVar', name: 'flag', value: flag },
            {
              type: 'if',
              cond: { left: { var: 'flag' }, op: 'truthy' },
              then: [{ type: 'click', selector: '#t' }],
              else: [{ type: 'click', selector: '#f' }],
            },
          ],
        },
        sb
      );
      assert(sb.calls.join('|') === exp, flag + ' -> ' + sb.calls.join('|'));
    }
  });

  await check('loop times=3 (+ hard cap reject)', async () => {
    const sb = makeSandbox();
    await runAst({ nodes: [{ type: 'loop', times: 3, body: [{ type: 'click', selector: '#n' }] }] }, sb);
    assert(sb.calls.filter((c) => c === 'click #n').length === 3, 'calls: ' + sb.calls.join('|'));
    let threw = null;
    try {
      await runAst({ nodes: [{ type: 'loop', times: 10001, body: [] }] }, makeSandbox());
    } catch (e) {
      threw = e;
    }
    assert(threw && /loop cap/.test(threw.message), 'cap not enforced: ' + (threw && threw.message));
  });

  await check('forEach over arrayVar', async () => {
    const sb = makeSandbox();
    await runAst(
      {
        nodes: [
          { type: 'setVar', name: 'items', value: ['a', 'b', 'c'] },
          {
            type: 'loop',
            forEach: 'it over items',
            body: [{ type: 'fill', selector: '#x', valueFromVar: 'it' }],
          },
        ],
      },
      sb
    );
    assert(sb.calls.join('|') === 'fill #x a|fill #x b|fill #x c', 'calls: ' + sb.calls.join('|'));
  });

  await check('setVar + readText outVar feeds if', async () => {
    const sb = makeSandbox();
    const r = await runAst(
      {
        nodes: [
          { type: 'setVar', name: 'marker', value: 42 },
          { type: 'readText', selector: '#t', outVar: 'got' },
          {
            type: 'if',
            cond: { left: { var: 'got' }, op: '==', right: { var: 'marker' } },
            then: [{ type: 'click', selector: '#match' }],
            else: [{ type: 'click', selector: '#miss' }],
          },
        ],
      },
      sb
    );
    assert(r.vars.got === 42 && r.vars.marker === 42, 'vars: ' + JSON.stringify(r.vars));
    assert(sb.calls.join('|') === 'evaluate|click #match', 'calls: ' + sb.calls.join('|'));
  });

  await check('gotoLabel forward skips nodes', async () => {
    const sb = makeSandbox();
    await runAst(
      {
        nodes: [
          { type: 'click', selector: '#1' },
          { type: 'gotoLabel', label: 'skip' },
          { type: 'click', selector: '#2' },
          { type: 'label', name: 'skip' },
          { type: 'click', selector: '#3' },
        ],
      },
      sb
    );
    assert(sb.calls.join('|') === 'click #1|click #3', 'calls: ' + sb.calls.join('|'));
  });

  await check('gotoLabel backward infinite loop hits step cap', async () => {
    let threw = null;
    try {
      await runAst(
        {
          nodes: [
            { type: 'label', name: 'top' },
            { type: 'gotoLabel', label: 'top' },
          ],
        },
        makeSandbox()
      );
    } catch (e) {
      threw = e;
    }
    assert(threw && /step cap/.test(threw.message), 'cap not hit: ' + (threw && threw.message));
  });

  await check('try/catch captures thrown step', async () => {
    const sb = makeSandbox();
    const r = await runAst(
      {
        nodes: [
          {
            type: 'try',
            body: [{ type: 'throw', message: 'boom' }],
            catchName: 'err',
            catchBody: [{ type: 'log', valueFromVar: 'err' }],
          },
        ],
      },
      sb
    );
    assert(typeof r.vars.err === 'string', 'err var missing: ' + JSON.stringify(r.vars));
    assert(/^RpaError: /.test(r.vars.err), 'err name: ' + r.vars.err);
    assert(/boom/.test(r.vars.err), 'err message: ' + r.vars.err);
    assert(/step \d+ \(throw\)/.test(r.vars.err), 'step info: ' + r.vars.err);
    assert(r.logs.length === 1 && r.logs[0] === r.vars.err, 'logs: ' + JSON.stringify(r.logs));
  });

  await check('validate rejects unknown type', async () => {
    const v = createAst().fromJson({ nodes: [{ type: 'nope' }] }).validate();
    assert(v.ok === false, 'should fail');
    assert(v.errors.some((e) => /unknown type/.test(e)), v.errors.join('; '));
  });

  await check('validate rejects goto missing url', async () => {
    const v = createAst().fromJson({ nodes: [{ type: 'goto' }] }).validate();
    assert(v.ok === false, 'should fail');
    assert(v.errors.some((e) => /missing url/.test(e)), v.errors.join('; '));
  });

  await check('validate rejects dangling gotoLabel', async () => {
    const v = createAst().fromJson({ nodes: [{ type: 'gotoLabel', label: 'nowhere' }] }).validate();
    assert(v.ok === false, 'should fail');
    assert(v.errors.some((e) => /dangling label/.test(e)), v.errors.join('; '));
  });

  await check('validate rejects node cap >5000', async () => {
    const nodes = [];
    for (let i = 0; i < 5001; i++) nodes.push({ type: 'start' });
    const v = createAst().fromJson({ nodes }).validate();
    assert(v.ok === false, 'should fail');
    assert(v.errors.some((e) => /node cap/.test(e)), v.errors.join('; '));
  });

  await check('validate rejects if/loop depth >8 (accepts 8)', async () => {
    const bad = createAst().fromJson({ nodes: ifNest(9) }).validate();
    assert(bad.ok === false, 'depth 9 should fail');
    assert(bad.errors.some((e) => /depth/.test(e)), bad.errors.join('; '));
    const good = createAst().fromJson({ nodes: ifNest(8) }).validate();
    assert(good.ok === true, 'depth 8 should pass: ' + good.errors.join('; '));
  });

  await check('astToScript linear contains await browser.goto and parses', async () => {
    const out = astToScript({
      nodes: [
        { type: 'start' },
        { type: 'goto', url: 'https://x' },
        { type: 'click', selector: '#a' },
        { type: 'if', cond: { left: { const: 1 }, op: 'truthy' }, then: [{ type: 'log', msg: 'y' }], else: [] },
        { type: 'loop', times: 2, body: [{ type: 'press', key: 'Enter' }] },
      ],
    });
    assert(typeof out.code === 'string', 'code type');
    assert(out.code.includes('await browser.goto'), 'missing goto: ' + out.code);
    assert(out.metadata && out.metadata.nodes === 7, 'metadata.nodes: ' + JSON.stringify(out.metadata));
    // new Function check: parse as async body (top-level await allowed inside async)
    // eslint-disable-next-line no-new-func
    const fn = new Function('return (async function(){' + out.code + '\n})');
    assert(typeof fn === 'function', 'new Function parse failed');
  });

  await check('RpaError semantics: name + retriable=false', async () => {
    const e = new RpaError('x');
    assert(e.name === 'RpaError', 'name: ' + e.name);
    assert(e.retriable === false, 'retriable');
    assert(e instanceof Error, 'instanceof Error');
  });

  console.log('DONE pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log('FAIL unhandled :: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
