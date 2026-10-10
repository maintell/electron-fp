// ponytail: executes trajectory PLANS against injected transports; policy = send-first (webContents.sendInputEvent, zero TCP), CDP-dispatch fallback. SDK signatures unchanged — caller (P1 glue) maps page.click/type onto this.
'use strict';

// Backend rule per call: try send(event) -> backend='send'; on throw -> await
// dispatch(cdpMethod, cdpParams) -> backend='dispatch'. Sync send wrapped in Promise.resolve().
// rng is unused when plans are precomputed; kept for future trajectory synthesis.

function backendOf(used) {
  if (used.size === 0) return 'send';
  if (used.size === 1) return [...used][0];
  return 'mixed';
}

function createInputAdapter({ send, dispatch, sleep, rng } = {}) {
  // rng: reserved for future plan synthesis; plans arrive precomputed today.
  void rng;
  const doSleep =
    typeof sleep === 'function' ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));

  async function emit(sendEvent, cdpMethod, cdpParams, used) {
    if (typeof send === 'function') {
      try {
        await Promise.resolve(send(sendEvent));
        used.add('send');
        return 'send';
      } catch (_) {
        // fall through to CDP dispatch
      }
    }
    if (typeof dispatch !== 'function') throw new Error('NO_DISPATCH_BACKEND');
    await dispatch(cdpMethod, cdpParams);
    used.add('dispatch');
    return 'dispatch';
  }

  async function clickAt({ moves, holdMs } = {}) {
    const points = (moves && moves.points) || [];
    const used = new Set();
    for (const p of points) {
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      await emit(
        { type: 'mouseMove', x, y, button: 'left' },
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x, y, button: 'left' },
        used
      );
      await doSleep(p.dtMs);
    }
    if (points.length > 0) {
      const last = points[points.length - 1];
      const x = Math.round(last.x);
      const y = Math.round(last.y);
      await emit(
        { type: 'mouseDown', x, y, button: 'left', clickCount: 1 },
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
        used
      );
      await doSleep(holdMs || 0);
      await emit(
        { type: 'mouseUp', x, y, button: 'left', clickCount: 1 },
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
        used
      );
    }
    return { backend: backendOf(used), moves: points.length };
  }

  function isBackspace(op) {
    if (!op || typeof op !== 'object') return false;
    if (typeof op.op === 'string' && op.op.toLowerCase() === 'backspace') return true;
    if (op.ch === 'Backspace') return true;
    return false;
  }

  async function typeOps(ops) {
    const list = ops || [];
    const used = new Set();
    let chars = 0;
    for (const op of list) {
      if (isBackspace(op)) {
        // Mapping: Electron sendInputEvent uses keyCode 'Backspace'; CDP uses
        // keyDown/keyUp with empty text + VK 8 (windowsVirtualKeyCode/nativeVirtualKeyCode).
        await emit(
          { type: 'keyDown', keyCode: 'Backspace' },
          'Input.dispatchKeyEvent',
          { type: 'keyDown', text: '', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
          used
        );
        await emit(
          { type: 'keyUp', keyCode: 'Backspace' },
          'Input.dispatchKeyEvent',
          { type: 'keyUp', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
          used
        );
        await doSleep(op.delayMs || 0);
        continue;
      }
      const ch = op.ch != null ? op.ch : op.op;
      await emit(
        { type: 'keyDown', keyCode: ch },
        'Input.dispatchKeyEvent',
        { type: 'keyDown', text: ch },
        used
      );
      await emit(
        { type: 'char', keyCode: ch },
        'Input.dispatchKeyEvent',
        { type: 'char', text: ch },
        used
      );
      await emit(
        { type: 'keyUp', keyCode: ch },
        'Input.dispatchKeyEvent',
        { type: 'keyUp', text: ch },
        used
      );
      chars++;
      await doSleep(op.delayMs || 0);
    }
    return { backend: backendOf(used), chars };
  }

  async function scrollTicks(ticks) {
    // ponytail: accept raw array or planScroll() envelope {ticks:[...]} — A/B lane contract seam.
    const list = Array.isArray(ticks) ? ticks : (ticks && ticks.ticks) || [];
    const used = new Set();
    for (const t of list) {
      await emit(
        { type: 'mouseWheel', deltaX: t.dx, deltaY: t.dy },
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: 0, y: 0, deltaX: t.dx, deltaY: t.dy },
        used
      );
      await doSleep(t.dtMs || 0);
    }
    return { backend: backendOf(used), ticks: list.length };
  }

  return { clickAt, typeOps, scrollTicks };
}

module.exports = { createInputAdapter };
