'use strict';

const { createInputAdapter } = require('./runtime/input-adapter');

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

function makeFakes({ sendImpl, dispatchImpl } = {}) {
  const sends = [];
  const dispatches = [];
  const sleeps = [];
  const send =
    sendImpl ||
    ((ev) => {
      sends.push(ev);
      return 'ok';
    });
  const dispatch =
    dispatchImpl ||
    ((method, params) => {
      dispatches.push({ method, params });
      return Promise.resolve({ ok: true });
    });
  const sleep = (ms) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  return { sends, dispatches, sleeps, send, dispatch, sleep };
}

async function main() {
  await check('clickAt: moves emitted BEFORE down; order move,move,move,down,up', async () => {
    const f = makeFakes();
    const a = createInputAdapter({ send: f.send, dispatch: f.dispatch, sleep: f.sleep });
    const moves = { points: [{ x: 10, y: 20, dtMs: 5 }, { x: 30, y: 40, dtMs: 7 }, { x: 50, y: 60, dtMs: 9 }] };
    const r = await a.clickAt({ moves, holdMs: 11 });
    assert(r.backend === 'send', 'backend=' + r.backend);
    assert(r.moves === 3, 'moves=' + r.moves);
    assert(f.sends.length === 5, 'sends=' + f.sends.length);
    const types = f.sends.map((e) => e.type);
    assert(types.join(',') === 'mouseMove,mouseMove,mouseMove,mouseDown,mouseUp', 'order=' + types.join(','));
    assert(f.sends[0].x === 10 && f.sends[0].y === 20, 'first move coords');
    assert(f.dispatches.length === 0, 'no dispatch expected');
  });

  await check('clickAt: sleep calls == 3 dt + 1 hold, values passed through', async () => {
    const f = makeFakes();
    const a = createInputAdapter({ send: f.send, dispatch: f.dispatch, sleep: f.sleep });
    const moves = { points: [{ x: 1, y: 2, dtMs: 5 }, { x: 3, y: 4, dtMs: 7 }, { x: 5, y: 6, dtMs: 9 }] };
    await a.clickAt({ moves, holdMs: 11 });
    assert(f.sleeps.length === 4, 'sleeps=' + JSON.stringify(f.sleeps));
    assert(f.sleeps.join(',') === '5,7,9,11', 'sleeps=' + f.sleeps.join(','));
  });

  await check('send throws once -> fallback to dispatch, backend mixed', async () => {
    let calls = 0;
    const f = makeFakes({
      sendImpl: (ev) => {
        calls++;
        if (calls === 1) throw new Error('NO_SEND_BACKEND');
        f.sends.push(ev);
        return 'ok';
      },
    });
    const a = createInputAdapter({ send: f.send, dispatch: f.dispatch, sleep: f.sleep });
    const moves = { points: [{ x: 10, y: 10, dtMs: 1 }] };
    const r = await a.clickAt({ moves, holdMs: 2 });
    assert(r.backend === 'mixed', 'backend=' + r.backend);
    assert(f.dispatches.length === 1, 'dispatches=' + f.dispatches.length);
    assert(f.dispatches[0].method === 'Input.dispatchMouseEvent', 'method=' + f.dispatches[0].method);
    assert(f.dispatches[0].params.type === 'mouseMoved', 'cdp type=' + f.dispatches[0].params.type);
  });

  await check('send throws always -> backend dispatch', async () => {
    const f = makeFakes({
      sendImpl: () => {
        throw new Error('NO_SEND_BACKEND');
      },
    });
    const a = createInputAdapter({ send: f.send, dispatch: f.dispatch, sleep: f.sleep });
    const moves = { points: [{ x: 10, y: 10, dtMs: 1 }] };
    const r = await a.clickAt({ moves, holdMs: 2 });
    assert(r.backend === 'dispatch', 'backend=' + r.backend);
    assert(f.sends.length === 0, 'sends should be empty');
    assert(f.dispatches.length === 3, 'dispatches=' + f.dispatches.length); // move+down+up
  });

  await check("typeOps: char 'a' -> keyDown/char/keyUp order + sleep(delay)", async () => {
    const f = makeFakes();
    const a = createInputAdapter({ send: f.send, dispatch: f.dispatch, sleep: f.sleep });
    const r = await a.typeOps([{ op: 'char', ch: 'a', delayMs: 13 }]);
    assert(r.backend === 'send', 'backend=' + r.backend);
    assert(r.chars === 1, 'chars=' + r.chars);
    assert(f.sends.length === 3, 'sends=' + f.sends.length);
    assert(f.sends[0].type === 'keyDown' && f.sends[0].keyCode === 'a', 'e0=' + JSON.stringify(f.sends[0]));
    assert(f.sends[1].type === 'char' && f.sends[1].keyCode === 'a', 'e1=' + JSON.stringify(f.sends[1]));
    assert(f.sends[2].type === 'keyUp' && f.sends[2].keyCode === 'a', 'e2=' + JSON.stringify(f.sends[2]));
    assert(f.sleeps.length === 1 && f.sleeps[0] === 13, 'sleeps=' + JSON.stringify(f.sleeps));
  });

  await check('typeOps: backspace op -> Backspace keyCode (send) / VKey 8 (dispatch)', async () => {
    const f = makeFakes();
    const a = createInputAdapter({ send: f.send, dispatch: f.dispatch, sleep: f.sleep });
    const r = await a.typeOps([{ op: 'backspace', delayMs: 4 }]);
    assert(f.sends.length === 2, 'sends=' + JSON.stringify(f.sends));
    assert(f.sends[0].keyCode === 'Backspace', 'e0=' + JSON.stringify(f.sends[0]));
    assert(f.sends[1].type === 'keyUp', 'e1=' + JSON.stringify(f.sends[1]));

    const g = makeFakes({
      sendImpl: () => {
        throw new Error('NO_SEND_BACKEND');
      },
    });
    const b = createInputAdapter({ send: g.send, dispatch: g.dispatch, sleep: g.sleep });
    await b.typeOps([{ op: 'backspace', delayMs: 4 }]);
    assert(g.dispatches.length === 2, 'dispatches=' + JSON.stringify(g.dispatches));
    assert(
      g.dispatches[0].params.windowsVirtualKeyCode === 8 && g.dispatches[0].params.nativeVirtualKeyCode === 8,
      'vkey=' + JSON.stringify(g.dispatches[0].params)
    );
    assert(r.backend === 'send', 'backend=' + r.backend);
  });

  await check('scrollTicks: deltas passed through in order + sleeps', async () => {
    const f = makeFakes();
    const a = createInputAdapter({ send: f.send, dispatch: f.dispatch, sleep: f.sleep });
    const ticks = [{ dx: 0, dy: 100, dtMs: 6 }, { dx: 5, dy: -50, dtMs: 8 }];
    const r = await a.scrollTicks(ticks);
    assert(r.backend === 'send', 'backend=' + r.backend);
    assert(r.ticks === 2, 'ticks=' + r.ticks);
    assert(f.sends.length === 2, 'sends=' + f.sends.length);
    assert(f.sends[0].type === 'mouseWheel' && f.sends[0].deltaX === 0 && f.sends[0].deltaY === 100, 't0=' + JSON.stringify(f.sends[0]));
    assert(f.sends[1].type === 'mouseWheel' && f.sends[1].deltaX === 5 && f.sends[1].deltaY === -50, 't1=' + JSON.stringify(f.sends[1]));
    assert(f.sleeps.join(',') === '6,8', 'sleeps=' + f.sleeps.join(','));
  });

  await check('scrollTicks dispatch fallback carries x:0 y:0 deltas', async () => {
    const f = makeFakes({
      sendImpl: () => {
        throw new Error('NO_SEND_BACKEND');
      },
    });
    const a = createInputAdapter({ send: f.send, dispatch: f.dispatch, sleep: f.sleep });
    const r = await a.scrollTicks([{ dx: 3, dy: 7, dtMs: 2 }]);
    assert(r.backend === 'dispatch', 'backend=' + r.backend);
    assert(f.dispatches[0].method === 'Input.dispatchMouseEvent', 'method=' + f.dispatches[0].method);
    assert(
      f.dispatches[0].params.type === 'mouseWheel' && f.dispatches[0].params.x === 0 && f.dispatches[0].params.y === 0,
      'params=' + JSON.stringify(f.dispatches[0].params)
    );
  });

  await check('sleeps sequential: sleep args equal plan dtMs sequence exactly', async () => {
    const f = makeFakes();
    const a = createInputAdapter({ send: f.send, dispatch: f.dispatch, sleep: f.sleep });
    const moves = { points: [{ x: 0, y: 0, dtMs: 2 }, { x: 1, y: 1, dtMs: 4 }, { x: 2, y: 2, dtMs: 6 }] };
    await a.clickAt({ moves, holdMs: 8 });
    assert(JSON.stringify(f.sleeps) === JSON.stringify([2, 4, 6, 8]), 'sleeps=' + JSON.stringify(f.sleeps));
    const g = makeFakes();
    const b = createInputAdapter({ send: g.send, dispatch: g.dispatch, sleep: g.sleep });
    await b.scrollTicks([{ dx: 0, dy: 1, dtMs: 2 }, { dx: 0, dy: 2, dtMs: 4 }, { dx: 0, dy: 3, dtMs: 6 }]);
    assert(JSON.stringify(g.sleeps) === JSON.stringify([2, 4, 6]), 'sleeps=' + JSON.stringify(g.sleeps));
  });

  await check('contract: human-input plans execute end-to-end (click/type/scroll)', async () => {
    // ponytail: A/B lane seam guard — planner output shapes must stay executable by the adapter.
    const { createRng } = require('./runtime/seeded-rng');
    const hi = require('./runtime/human-input');
    const rng = createRng('contract-seam');
    const f = makeFakes();
    const a = createInputAdapter({ send: f.send, dispatch: f.dispatch, sleep: f.sleep });
    const ck = hi.planClick({ at: { x: 50, y: 60 }, from: { x: 0, y: 0 }, rng });
    const r1 = await a.clickAt({ moves: ck.moves, holdMs: ck.holdMs });
    assert(r1.moves === ck.moves.points.length, 'moves=' + r1.moves + ' plan=' + ck.moves.points.length);
    assert(f.sends.some((e) => e.type === 'mouseDown'), 'no mouseDown emitted');
    const ops = hi.planTyping({ text: 'ab', rng, mistakeProb: 0 });
    const r2 = await a.typeOps(ops);
    assert(r2.chars === 2, 'chars=' + r2.chars);
    const sc = hi.planScroll({ dy: 120, rng });
    const r3 = await a.scrollTicks(sc); // envelope form {ticks:[...]}, not raw array
    assert(r3.ticks === sc.ticks.length, 'ticks=' + r3.ticks + ' plan=' + sc.ticks.length);
    const planned = sc.ticks.reduce((s, t) => s + t.dy, 0);
    const emitted = f.sends.filter((e) => e.type === 'mouseWheel').reduce((s, e) => s + e.deltaY, 0);
    assert(emitted === planned, 'dy emitted=' + emitted + ' planned=' + planned);
  });

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('FAIL harness :: ' + e.message);
  process.exit(1);
});
