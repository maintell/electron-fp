'use strict';

const { parseCron, nextCronAt, createScheduler } = require('./runtime/scheduler');

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

// fixed clock: Mon 2026-09-21 08:00 UTC; onFire spy records "scheduleId:ctxId"
function makeSched() {
  const state = { t: Date.UTC(2026, 8, 21, 8, 0, 0), audits: [], fires: [] };
  const sch = createScheduler({
    now: () => state.t,
    audit: (e) => state.audits.push(e),
    onFire: (schedule, ctx) => state.fires.push(schedule.id + ':' + ctx.id),
  });
  return { s: sch, state, advance: (ms) => { state.t += ms; } };
}

// --- 1. parseCron field expansion ---
check('parseCron */5 9-17 * * 1-5 sets correct', () => {
  const c = parseCron('*/5 9-17 * * 1-5');
  assert(c.min.size === 12 && c.min.has(0) && c.min.has(55) && !c.min.has(3), 'min step');
  assert(c.hour.size === 9 && c.hour.has(9) && c.hour.has(17) && !c.hour.has(8), 'hour range');
  assert(c.dom.size === 31 && c.mon.size === 12, 'dom/mon full');
  assert(c.dow.size === 5 && c.dow.has(1) && c.dow.has(5) && !c.dow.has(0) && !c.dow.has(6), 'dow Mon-Fri');
  assert(c.domRestricted === false && c.dowRestricted === true, 'restriction flags');
  // list + macro sugar
  const l = parseCron('0,30 12 * * *');
  assert(l.min.size === 2 && l.min.has(0) && l.min.has(30), 'list items');
  const d = parseCron('@daily');
  assert(d.min.has(0) && d.hour.has(0) && !d.domRestricted, '@daily sugar');
});

// --- 2. parseCron rejects ---
check('parseCron rejects 4 fields / bad month / non-numeric / dow 7', () => {
  assertThrows(() => parseCron('* * * *'), '5 fields');
  assertThrows(() => parseCron('0 0 * 13 *'), 'out of range');
  assertThrows(() => parseCron('x * * * *'), 'non-numeric');
  assertThrows(() => parseCron('* * * * abc'), 'non-numeric');
  assertThrows(() => parseCron('* * * * 7'), 'out of range');
  assertThrows(() => parseCron('61 * * * *'), 'out of range');
  assertThrows(() => parseCron('5-1 * * * *'), 'bad range');
});

// --- 3. nextCronAt edges ---
check('nextCronAt weekday skip / year wrap / dom-dow OR / impossible throws', () => {
  // Mon 08:59 -> same day 09:00
  assert(
    nextCronAt('0 9 * * 1-5', Date.UTC(2026, 8, 21, 8, 59)) === Date.UTC(2026, 8, 21, 9, 0),
    'Mon 08:59 -> Mon 09:00'
  );
  // Fri 09:00 (== slot, need strictly greater) -> Mon 09:00 (weekend skipped)
  assert(
    nextCronAt('0 9 * * 1-5', Date.UTC(2026, 8, 25, 9, 0)) === Date.UTC(2026, 8, 28, 9, 0),
    'Fri 09:00 -> Mon 09:00'
  );
  // Jan 2 -> next year Jan 1
  assert(
    nextCronAt('0 0 1 1 *', Date.UTC(2027, 0, 2)) === Date.UTC(2028, 0, 1),
    'Jan 2 -> next Jan 1'
  );
  // both restricted => OR: Sat Sep 12 -> Sun Sep 13 (dom hit, not Fri)
  assert(
    nextCronAt('0 0 13 * 5', Date.UTC(2026, 8, 12, 0, 0)) === Date.UTC(2026, 8, 13, 0, 0),
    'dom/dow OR-semantics'
  );
  // only dow restricted gates (dom=*): Sat -> next Fri, ignores dom
  assert(
    nextCronAt('0 0 * * 5', Date.UTC(2026, 8, 12, 0, 0)) === Date.UTC(2026, 8, 18, 0, 0),
    'dow-only gating'
  );
  assertThrows(() => nextCronAt('0 0 30 2 *', Date.UTC(2026, 0, 1)), '366 days');
});

// --- 4. once fires exactly once ---
check('once fires exactly once then done; past atMs fires on next tick', () => {
  const { s, state, advance } = makeSched();
  const a = s.add({
    scriptId: 's1', type: 'once', atMs: state.t + 1000, profileContexts: [{ id: 'p1' }],
  });
  s.tick();
  assert(state.fires.length === 0, 'not due yet');
  advance(1000);
  s.tick();
  assert(state.fires.length === 1, 'fired once');
  assert(a.state === 'done' && a.nextRunAt === null, 'state done, nextRunAt null');
  advance(60000);
  s.tick();
  assert(state.fires.length === 1, 'second tick no fire');

  // past atMs => nextRunAt kept in the past, fires on next tick (spec: immediate-ish)
  const b = s.add({
    scriptId: 's1', type: 'once', atMs: state.t - 5000, profileContexts: [{ id: 'p1' }],
  });
  assert(b.nextRunAt === state.t - 5000, 'past atMs kept as-is');
  s.tick();
  assert(state.fires.length === 2 && b.state === 'done', 'past once fired on tick');
});

// --- 5. interval cadence + overdue catch-up ---
check('interval +5s/+10s; overdue >2x => one fire + skip audit, nextRunAt=now+everyMs', () => {
  const { s, state, advance } = makeSched();
  const iv = s.add({
    scriptId: 's1', type: 'interval', everyMs: 5000, profileContexts: [{ id: 'p1' }],
  });
  assert(iv.nextRunAt === state.t + 5000, 'initial nextRunAt = now+5s');
  advance(5000);
  s.tick();
  assert(state.fires.length === 1, 'fire at +5s');
  advance(5000);
  s.tick();
  assert(state.fires.length === 2, 'fire at +10s');
  advance(30000); // now +40s; due was +15s => overdue 25s > 2x5s
  s.tick();
  assert(state.fires.length === 3, 'single catch-up fire, missed windows not backfilled');
  assert(state.audits.some((a) => a.type === 'schedule-skip'), 'schedule-skip audited');
  assert(iv.nextRunAt === state.t + 5000, 'nextRunAt = now+5s, not past slots');
  assert(iv.state === 'active', 'stays active');
});

// --- 6. cron fire + per-ctx fan-out ---
check('cron fires on minute cross, 2 profileContexts => onFire twice', () => {
  const { s, state, advance } = makeSched();
  const c = s.add({
    scriptId: 's1', type: 'cron', cron: '* * * * *',
    profileContexts: [{ id: 'p1' }, { id: 'p2' }],
  });
  assert(c.nextRunAt === state.t + 60000, 'next minute boundary');
  s.tick();
  assert(state.fires.length === 0, 'before minute cross');
  advance(60000);
  s.tick();
  assert(state.fires.length === 2, 'one onFire per ctx');
  assert(state.fires[0].endsWith(':p1') && state.fires[1].endsWith(':p2'), 'both ctxs, order kept');
  const fireAudits = state.audits.filter((a) => a.type === 'schedule-fire');
  assert(fireAudits.length === 1 && fireAudits[0].ctxCount === 2, 'audit ctxCount=2');
  assert(c.nextRunAt === state.t + 60000, 'cron advanced to next slot');
});

// --- 7. pause / resume semantics ---
check('pause blocks; resume overdue once fires immediately; resume overdue cron waits', () => {
  const { s, state, advance } = makeSched();
  const a = s.add({
    scriptId: 's1', type: 'once', atMs: state.t + 5000, profileContexts: [{ id: 'p1' }],
  });
  s.pause(a.id);
  assert(a.state === 'paused', 'paused keeps nextRunAt: ' + a.nextRunAt);
  assert(a.nextRunAt === state.t + 5000, 'nextRunAt preserved while paused');
  advance(10000);
  s.tick();
  assert(state.fires.length === 0, 'paused: no fire');
  s.resume(a.id);
  assert(a.state === 'active', 'resumed');
  s.tick();
  assert(state.fires.length === 1 && a.state === 'done', 'overdue once fires on resume tick');

  const c = s.add({
    scriptId: 's1', type: 'cron', cron: '0 9 * * *', profileContexts: [{ id: 'p1' }],
  });
  assert(c.nextRunAt === Date.UTC(2026, 8, 21, 9, 0), 'cron due Mon 09:00');
  s.pause(c.id);
  advance(2 * 3600 * 1000); // ~10:00, past due
  s.tick();
  assert(state.fires.length === 1, 'paused cron no fire');
  s.resume(c.id);
  assert(c.nextRunAt === Date.UTC(2026, 8, 22, 9, 0), 'overdue cron recomputed to next future slot');
  s.tick();
  assert(state.fires.length === 1, 'no immediate fire after cron resume');
});

// --- 8. triggerNow ---
check('triggerNow cron fires + future nextRunAt; triggerNow once => done', () => {
  const { s, state } = makeSched();
  const c = s.add({
    scriptId: 's1', type: 'cron', cron: '0 9 * * *',
    profileContexts: [{ id: 'p1' }, { id: 'p2' }],
  });
  const before = c.nextRunAt;
  s.triggerNow(c.id);
  assert(state.fires.length === 2, 'manual fan-out per ctx');
  assert(c.lastFiredAt === state.t, 'lastFiredAt = now');
  assert(c.nextRunAt === before && c.nextRunAt > state.t, 'nextRunAt recomputed still future');
  assert(c.state === 'active', 'manual trigger keeps cron active');

  const a = s.add({
    scriptId: 's1', type: 'once', atMs: state.t + 60000, profileContexts: [{ id: 'p1' }],
  });
  s.triggerNow(a.id);
  assert(a.state === 'done' && a.nextRunAt === null, 'once -> done after manual fire');
  const n = state.fires.length;
  s.tick();
  assert(state.fires.length === n, 'done once not re-fired by tick');
});

// --- 9. add/update validation ---
check('add/update validation rejects bad specs', () => {
  const { s, state } = makeSched();
  assertThrows(() => s.add({ type: 'once', atMs: state.t + 1000, profileContexts: [{ id: 'p1' }] }), 'scriptId');
  assertThrows(() => s.add({ scriptId: 's1', type: 'once', atMs: state.t + 1000 }), 'profileContexts');
  assertThrows(
    () => s.add({ scriptId: 's1', type: 'interval', everyMs: 999, profileContexts: [{ id: 'p1' }] }),
    'everyMs'
  );
  assertThrows(
    () => s.add({ scriptId: 's1', type: 'cron', cron: 'bad', profileContexts: [{ id: 'p1' }] }),
    '5 fields'
  );
  assertThrows(
    () => s.add({ scriptId: 's1', type: 'cron', cron: '61 * * * *', profileContexts: [{ id: 'p1' }] }),
    'out of range'
  );
  assertThrows(() => s.add({ scriptId: 's1', type: 'once', profileContexts: [{ id: 'p1' }] }), 'atMs');
  assertThrows(() => s.add({ scriptId: 's1', type: 'bogus', profileContexts: [{ id: 'p1' }] }), 'bad type');

  const iv = s.add({
    scriptId: 's1', type: 'interval', everyMs: 5000, profileContexts: [{ id: 'p1' }],
  });
  assertThrows(() => s.update(iv.id, { everyMs: 500 }), 'everyMs');
  assert(iv.everyMs === 5000 && iv.nextRunAt === state.t + 5000, 'failed update not half-applied');
  assertThrows(() => s.update(iv.id, { profileContexts: [] }), 'profileContexts');
  assert(iv.profileContexts.length === 1, 'patch rolled back');
  s.update(iv.id, { everyMs: 10000 });
  assert(iv.nextRunAt === state.t + 10000, 'timing change recomputes nextRunAt');

  assertThrows(() => s.pause('nope'), 'unknown schedule');
  assertThrows(() => s.triggerNow('nope'), 'unknown schedule');
  assertThrows(() => createScheduler({ now: () => 0 }), 'onFire required');
});

// --- 10. list pagination + stats ---
check('list pagination + enabled filter + stats counts', () => {
  const { s, state, advance } = makeSched();
  const a = s.add({
    scriptId: 's1', type: 'interval', everyMs: 5000, profileContexts: [{ id: 'p1' }],
  });
  const b = s.add({
    scriptId: 's1', type: 'cron', cron: '* * * * *', profileContexts: [{ id: 'p1' }],
  });
  const c = s.add({
    scriptId: 's1', type: 'once', atMs: state.t + 1000, profileContexts: [{ id: 'p1' }],
  });
  const d = s.add({
    scriptId: 's1', type: 'interval', everyMs: 5000,
    profileContexts: [{ id: 'p1' }], enabled: false,
  });
  s.pause(b.id);
  advance(1000);
  s.tick(); // c due -> done; a due at +5s not yet; b paused; d disabled

  assert(s.list().length === 4, 'list all');
  assert(s.list({ limit: 2 }).length === 2, 'limit');
  assert(s.list({ offset: 2 }).length === 2, 'offset');
  assert(s.list({ limit: 3, offset: 1 }).length === 3, 'limit+offset');
  assert(s.list({ enabled: false }).length === 1 && s.list({ enabled: false })[0].id === d.id, 'enabled=false');
  assert(s.list({ enabled: true }).length === 3, 'enabled=true');

  const st = s.stats();
  assert(st.total === 4, 'total');
  // d: state stays 'active' though disabled (enabled is a separate gate)
  assert(st.active === 2, 'active (a + disabled-but-active d), got ' + st.active);
  assert(st.paused === 1 && st.done === 1, 'paused/done');
  assert(st.nextDueInMs === a.nextRunAt - state.t, 'nextDueInMs from earliest active');
});

// --- 11. enabled:false never fires ---
check('enabled:false schedule never fires even when due', () => {
  const { s, state, advance } = makeSched();
  const d = s.add({
    scriptId: 's1', type: 'interval', everyMs: 5000,
    profileContexts: [{ id: 'p1' }], enabled: false,
  });
  advance(20000);
  s.tick();
  s.tick();
  assert(state.fires.length === 0, 'disabled skipped');
  assert(d.state === 'active' && d.lastFiredAt === null, 'untouched');
  assert(d.nextRunAt <= state.t, 'still overdue (paused-like hold)');
});

console.log('SUMMARY pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
