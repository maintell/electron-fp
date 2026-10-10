'use strict';
// @fp-automation/tasks — task/queue/schedule layer over @fp-automation/core.
// The runtime task-item state machine (task-queue.js): CREATED -> QUEUED ->
// STARTING -> RUNNING -> (SUCCESS | FAILED | CANCELLED | TIMEOUT | CRASHED),
// with RETRYING -> QUEUED while attempts remain. This layer submits and polls.
const TERMINAL = ['SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT', 'CRASHED'];
const ACTIVE = ['QUEUED', 'STARTING', 'RUNNING', 'RETRYING', 'PAUSED', 'STOPPING'];

function createTaskClient(client, { pollMs = 50, timeoutMs = 30000 } = {}) {
  if (!client || !client.tasks) throw new Error('createTaskClient: a @fp-automation/core client is required');

  const api = {
    TERMINAL,
    ACTIVE,
    // submit returns the queue item ({ id, status:'QUEUED', ... }).
    submit(spec) {
      return client.tasks.enqueue(spec);
    },
    get(id) {
      return client.tasks.get(id);
    },
    list(q) {
      return client.tasks.list(q);
    },
    cancel(id) {
      return client.tasks.cancel(id);
    },
    pause(id, interrupt) {
      return client.tasks.pause(id, interrupt);
    },
    resume(id) {
      return client.tasks.resume(id);
    },
    // Poll until a terminal state; returns the final item + the ordered status
    // transitions observed (proves the state flow).
    async wait(id, opts = {}) {
      const deadline = Date.now() + (opts.timeoutMs || timeoutMs);
      const interval = opts.pollMs || pollMs;
      const states = [];
      for (;;) {
        const item = await api.get(id);
        if (!item) throw new Error('task not found: ' + id);
        if (states[states.length - 1] !== item.status) states.push(item.status);
        if (TERMINAL.indexOf(item.status) !== -1) return { item, states };
        if (Date.now() > deadline) throw new Error('wait timed out; last status=' + item.status);
        await new Promise((r) => setTimeout(r, interval));
      }
    },
    async runToTerminal(spec, opts = {}) {
      const queued = await api.submit(spec);
      const { item, states } = await api.wait(queued.id, opts);
      return { id: queued.id, item, states };
    },
    schedules: {
      add: (spec) => client.schedules.add(spec),
      list: (q) => client.schedules.list(q),
      pause: (id) => client.schedules.pause(id),
      resume: (id) => client.schedules.resume(id),
      trigger: (id) => client.schedules.trigger(id),
      remove: (id) => client.schedules.remove(id),
    },
  };
  return api;
}

module.exports = { createTaskClient, TERMINAL, ACTIVE };
