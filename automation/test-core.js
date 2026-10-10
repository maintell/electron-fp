'use strict';

const { createSessionStateMachine, gateCdpMethod, createPendingMap } = require('./runtime/core');

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

function assertThrows(fn, msgPart) {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    if (msgPart) assert(e.message.includes(msgPart), 'wrong error: ' + e.message);
  }
  assert(threw, 'expected throw');
}

// --- state machine: legal path ---
check('sm legal path created→starting→ready→attached→detaching→closed', () => {
  const sm = createSessionStateMachine();
  assert(sm.getState() === 'created', 'initial state');
  sm.transition('starting');
  sm.transition('ready');
  sm.transition('attached');
  sm.transition('detaching');
  sm.transition('closed');
  assert(sm.getState() === 'closed', 'final state');
});

// --- crashed recover ---
check('sm crashed recover attached→crashed→ready', () => {
  const sm = createSessionStateMachine();
  sm.transition('starting');
  sm.transition('ready');
  sm.transition('attached');
  sm.transition('crashed');
  assert(sm.getState() === 'crashed', 'crashed');
  sm.transition('ready');
  assert(sm.getState() === 'ready', 'recovered');
});

// --- illegal transitions ---
check('sm illegal closed→attached throws, state unchanged', () => {
  const sm = createSessionStateMachine();
  sm.transition('starting');
  sm.transition('ready');
  sm.transition('detaching');
  sm.transition('closed');
  assertThrows(() => sm.transition('attached'), 'illegal transition: closed->attached');
  assert(sm.getState() === 'closed', 'state unchanged');
});

check('sm illegal ready→starting throws, state unchanged', () => {
  const sm = createSessionStateMachine();
  sm.transition('starting');
  sm.transition('ready');
  assertThrows(() => sm.transition('starting'), 'illegal transition: ready->starting');
  assert(sm.getState() === 'ready', 'state unchanged');
});

check('sm canTransition false without throw', () => {
  const sm = createSessionStateMachine();
  assert(sm.canTransition('starting') === true, 'legal ok');
  assert(sm.canTransition('closed') === false, 'illegal false');
  assert(sm.getState() === 'created', 'state unchanged');
});

// --- gate allow ---
check('gate allow Page.navigate / Runtime.evaluate / Storage.getCookies / Target.attachToTarget', () => {
  assert(gateCdpMethod('Page.navigate') === true, 'Page.navigate');
  assert(gateCdpMethod('Runtime.evaluate') === true, 'Runtime.evaluate');
  assert(gateCdpMethod('Storage.getCookies') === true, 'Storage.getCookies');
  assert(gateCdpMethod('Target.attachToTarget') === true, 'Target.attachToTarget');
});

// --- gate deny ---
check('gate deny Browser.close (control stays denied)', () => {
  assert(gateCdpMethod('Browser.close') === false, 'Browser.close');
});

check('gate allow Browser.getVersion (read-only introspection)', () => {
  assert(gateCdpMethod('Browser.getVersion') === true, 'Browser.getVersion');
});

check('gate allow Target.getTargets (read-only discovery)', () => {
  assert(gateCdpMethod('Target.getTargets') === true, 'Target.getTargets');
});

check('gate deny control methods Browser.close / Target.createTarget / closeTarget', () => {
  assert(gateCdpMethod('Browser.close') === false, 'Browser.close');
  assert(gateCdpMethod('Target.createTarget') === false, 'createTarget');
  assert(gateCdpMethod('Target.closeTarget') === false, 'closeTarget');
});

check('gate deny SystemInfo / FileSystem / Target.createTarget / closeTarget', () => {
  assert(gateCdpMethod('SystemInfo.getProcessInfo') === false, 'SystemInfo');
  assert(gateCdpMethod('FileSystem.readFileSync') === false, 'FileSystem');
  assert(gateCdpMethod('Target.createTarget') === false, 'createTarget');
  assert(gateCdpMethod('Target.closeTarget') === false, 'closeTarget');
});

check('gate default deny Foo.bar', () => {
  assert(gateCdpMethod('Foo.bar') === false, 'default deny');
});

// --- pendingMap ---
check('pendingMap add/resolve removes, size bookkeeping', () => {
  const pm = createPendingMap();
  assert(pm.size === 0, 'empty');
  pm.add(1);
  assert(pm.has(1) && pm.size === 1, 'after add');
  assert(pm.resolve(1, 'ok') === true, 'resolve true');
  assert(!pm.has(1) && pm.size === 0, 'removed after resolve');
});

check('pendingMap reject removes, returns true', () => {
  const pm = createPendingMap();
  pm.add(2);
  assert(pm.reject(2, new Error('x')) === true, 'reject true');
  assert(!pm.has(2) && pm.size === 0, 'removed after reject');
});

check('pendingMap duplicate add throws', () => {
  const pm = createPendingMap();
  pm.add(3);
  assertThrows(() => pm.add(3), 'duplicate');
});

check('pendingMap unknown resolve/reject return false', () => {
  const pm = createPendingMap();
  assert(pm.resolve(99, 'v') === false, 'unknown resolve');
  assert(pm.reject(99, new Error('e')) === false, 'unknown reject');
  assert(pm.size === 0, 'size unchanged');
});

console.log('SUMMARY pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
