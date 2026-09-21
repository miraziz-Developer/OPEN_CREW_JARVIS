'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MissionStore } = require('../core/missions/store');
const { GoalEngine } = require('../core/missions/engine');
const { createRunner } = require('../core/mission-runner');

function setup(script, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-missions-'));
  const store = new MissionStore({ dir });
  const calls = [];
  const llm = { completeJson: async request => { calls.push(request.system.slice(0, 30)); return script(request, calls.length); } };
  const workerCalls = [];
  const workers = {};
  for (const name of ['agent', 'interpreter', 'browser', 'gui', 'think']) {
    workers[name] = { run: async input => { workerCalls.push({ name, prompt: input.prompt }); return (options.worker || (async () => ({ ok: true, output: `done by ${name}` })))(input, name, workerCalls.length); } };
  }
  const engine = new GoalEngine({ store, llm, workers, assess: options.assess, fullAutonomy: () => false });
  return { dir, store, engine, workerCalls, calls };
}

const PLAN = { criteria: ['file exists'], tasks: [{ title: 'Create file', worker: 'interpreter', prompt: 'create /tmp/x', priority: 9 }, { title: 'Verify', worker: 'think', prompt: 'verify', priority: 5 }] };

async function drive(engine, store, id, max = 20) {
  for (let i = 0; i < max; i++) {
    const mission = store.get(id);
    if (!['planning', 'running'].includes(mission.status)) return mission;
    await engine.step(mission);
  }
  return store.get(id);
}

test('store numbers missions, drains inbox commands and streams events by offset', () => {
  const { store } = setup(() => ({}));
  const first = store.create('first goal');
  const second = store.create('second goal');
  assert.deepEqual([first.n, second.n], [1, 2]);
  assert.equal(store.get('mission 2').id, second.id);
  assert.equal(store.get('1').id, first.id);
  const offset = store.eventsOffset();
  store.appendEvent({ kind: 'x', text: 'hello' });
  const { events } = store.readEventsSince(offset);
  assert.equal(events.length, 1);
  store.enqueue(2, 'pause');
  const commands = store.drainInbox();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].action, 'pause');
  assert.equal(store.drainInbox().length, 0);
});

test('goal engine plans, executes tasks by priority, verifies with evidence and completes', async () => {
  const { engine, store, workerCalls } = setup((request, index) => {
    if (/planning core/.test(request.system)) return PLAN;
    if (/Task just run: t1/.test(request.user)) return { task_status: 'done', evidence: 'file created', new_tasks: [], goal_achieved: false, summary: 'created' };
    return { task_status: 'done', evidence: 'verified', new_tasks: [], goal_achieved: true, goal_evidence: 'file exists at /tmp/x with content', summary: 'all good' };
  });
  const mission = store.create('make the file');
  const done = await drive(engine, store, mission.id);
  assert.equal(done.status, 'completed');
  assert.equal(workerCalls[0].name, 'interpreter');           // higher priority first
  assert.match(done.result, /file exists/);
  assert.equal(done.tasks.filter(t => t.status === 'done').length, 2);
  const kinds = store.readEventsSince(0).events.map(e => e.kind);
  assert.ok(kinds.includes('mission.planned') && kinds.includes('mission.completed'));
});

test('goal_achieved without concrete evidence is not accepted', async () => {
  let reflections = 0;
  const { engine, store } = setup(request => {
    if (/planning core/.test(request.system)) return { criteria: ['c'], tasks: [{ title: 'only', worker: 'think', prompt: 'p', priority: 5 }] };
    reflections += 1;
    return reflections === 1
      ? { task_status: 'done', evidence: 'ok', goal_achieved: true, goal_evidence: '', summary: 's' }
      : { task_status: 'done', evidence: 'ok', goal_achieved: true, goal_evidence: 'verified with output 42', summary: 's' };
  });
  const mission = store.create('goal');
  const done = await drive(engine, store, mission.id);
  assert.equal(done.status, 'completed');
  assert.ok(reflections >= 2);
});

test('repeated failures block the mission instead of looping forever, and resume clears the counter', async () => {
  const { engine, store } = setup(request => {
    if (/planning core/.test(request.system)) return { criteria: ['c'], tasks: [{ title: 'flaky', worker: 'agent', prompt: 'do it', priority: 5 }] };
    return { task_status: 'retry', evidence: 'no luck', new_tasks: [{ title: 'flaky again', worker: 'agent', prompt: 'do it differently ' + Math.random(), priority: 5 }], goal_achieved: false };
  }, { worker: async () => ({ ok: false, output: '', error: 'boom' }) });
  const mission = store.create('goal', { maxConsecutiveFailures: 3 });
  const blocked = await drive(engine, store, mission.id, 30);
  assert.equal(blocked.status, 'blocked');
  assert.match(store.readEventsSince(0).events.at(-1).text, /stalled/);
  const resumed = engine.applyCommand(store.get(mission.id), { action: 'resume' });
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.consecutiveFailures, 0);
});

test('risky tasks wait for approval; approve continues and reject skips them', async () => {
  const plan = { criteria: ['c'], tasks: [{ title: 'Email the boss', worker: 'agent', prompt: 'send an email to my boss', priority: 5 }] };
  const assess = ({ description }) => ({ requiresConfirmation: /email/i.test(description), autonomousEligible: false, category: 'external-communication' });
  const script = request => /planning core/.test(request.system) ? plan
    : { task_status: 'done', evidence: 'sent', goal_achieved: true, goal_evidence: 'email sent confirmation', summary: 'sent' };

  const approved = setup(script, { assess });
  const a = approved.store.create('mail the boss');
  await drive(approved.engine, approved.store, a.id);
  let state = approved.store.get(a.id);
  assert.equal(state.status, 'awaiting_approval');
  assert.equal(approved.workerCalls.length, 0);
  approved.engine.applyCommand(state, { action: 'approve' });
  approved.store.save(state);
  state = await drive(approved.engine, approved.store, a.id);
  assert.equal(state.status, 'completed');
  assert.equal(approved.workerCalls.length, 1);

  const rejected = setup((request) => /planning core/.test(request.system) ? plan : { task_status: 'done', new_tasks: [], goal_achieved: false, blocked: true, blocker: 'need another way', summary: '' }, { assess });
  const r = rejected.store.create('mail the boss');
  await drive(rejected.engine, rejected.store, r.id);
  const pending = rejected.store.get(r.id);
  rejected.engine.applyCommand(pending, { action: 'reject' });
  assert.equal(pending.tasks[0].status, 'skipped');
  assert.equal(pending.status, 'running');
  assert.match(pending.notes[0], /rejected/);
});

test('cancel and pause during a running task are not overwritten by the finishing step', async () => {
  const { engine, store } = setup(request => /planning core/.test(request.system) ? PLAN : { task_status: 'done', evidence: 'x', goal_achieved: false }, {
    worker: async (input) => { engine.applyCommand(input.mission, { action: input.mission.n === 1 ? 'cancel' : 'pause' }); return { ok: true, output: 'late' }; }
  });
  const a = store.create('a');
  await engine.step(store.get(a.id));           // plan
  await engine.step(store.get(a.id));           // task runs, cancelled meanwhile
  assert.equal(store.get(a.id).status, 'cancelled');
  const b = store.create('b');
  await engine.step(store.get(b.id));
  await engine.step(store.get(b.id));
  const paused = store.get(b.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.tasks.find(t => t.status === 'running'), undefined);
});

test('iteration budget stops a mission with a clear resumable message', async () => {
  const { engine, store } = setup(request => /planning core/.test(request.system)
    ? { criteria: ['c'], tasks: [{ title: 't', worker: 'think', prompt: 'p', priority: 5 }] }
    : { task_status: 'done', evidence: 'ok', new_tasks: [{ title: 'more', worker: 'think', prompt: 'p' + Math.random(), priority: 5 }], goal_achieved: false });
  const mission = store.create('endless', { maxIterations: 3 });
  const stopped = await drive(engine, store, mission.id, 30);
  assert.equal(stopped.status, 'blocked');
  assert.match(store.readEventsSince(0).events.at(-1).text, /iteration budget/);
});

test('runner recovers interrupted tasks, applies inbox commands and forwards important events', async () => {
  const { engine, store } = setup(request => /planning core/.test(request.system)
    ? { criteria: ['c'], tasks: [{ title: 't', worker: 'think', prompt: 'p', priority: 5 }] }
    : { task_status: 'done', evidence: 'ok', goal_achieved: true, goal_evidence: 'concrete proof', summary: 'finished' });
  const mission = store.create('recover me');
  await engine.step(store.get(mission.id));                       // plan
  const crashed = store.get(mission.id);
  crashed.tasks[0].status = 'running'; crashed.tasks[0].attempts = 1; store.save(crashed);

  const sent = [];
  const runner = createRunner({ store, engine, notify: async text => { sent.push(text); return true; } });
  assert.equal(runner.recover(), 1);
  assert.equal(store.get(mission.id).tasks[0].status, 'pending');
  for (let i = 0; i < 6; i++) { await runner.tick(); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(store.get(mission.id).status, 'completed');
  assert.ok(sent.some(text => /complete/.test(text)));

  const other = store.create('to cancel');
  store.enqueue(other.id, 'cancel');
  await runner.tick();
  assert.equal(store.get(other.id).status, 'cancelled');
});

test('reflection can skip pending tasks that earlier work already satisfied, so simple goals finish quickly', async () => {
  const { engine, store, workerCalls } = setup(request => {
    if (/planning core/.test(request.system)) return { criteria: ['done'], tasks: [
      { title: 'do everything', worker: 'interpreter', prompt: 'a', priority: 9 },
      { title: 'redundant check', worker: 'think', prompt: 'b', priority: 3 }] };
    return { task_status: 'done', evidence: 'all done', skip_tasks: ['t2'], goal_achieved: true, goal_evidence: 'verified by the first task output', summary: 's' };
  });
  const mission = store.create('simple goal');
  const done = await drive(engine, store, mission.id);
  assert.equal(done.status, 'completed');
  assert.equal(workerCalls.length, 1);
  assert.equal(done.tasks.find(t => t.id === 't2').status, 'skipped');
});

test('risk assessment ignores negated warnings and harmless phrases but still catches real risky actions', () => {
  const { sanitizeForRisk } = require('../core/missions/engine');
  const { assessAction } = require('../core/action-safety-policy');
  const flagged = text => assessAction({ kind: 'task', description: sanitizeForRisk(text) }).requiresConfirmation;
  assert.equal(flagged('Inspect the folder read-only. Do NOT modify or delete any files and do not send anything.'), false);
  assert.equal(flagged('Run ls /private/tmp/demo and report file permissions and default permissions'), false);
  assert.equal(flagged('Open Safari and search for the news'), false);
  assert.equal(flagged('Delete all my files in Documents'), true);
  assert.equal(flagged('Send an email to my boss with the report. Do not delete anything.'), true);
  assert.equal(flagged('Buy the domain example.com'), true);
});

test('runner writes finished missions to long-term memory and only notifies about important events', async () => {
  const { engine, store } = setup(request => /planning core/.test(request.system)
    ? { criteria: ['c'], tasks: [{ title: 't', worker: 'think', prompt: 'p', priority: 5 }] }
    : { task_status: 'done', evidence: 'ok', goal_achieved: true, goal_evidence: 'concrete proof', summary: 'finished' });
  const remembered = [];
  const notified = [];
  const runner = createRunner({ store, engine, remember: event => remembered.push(event.kind), notify: async text => { notified.push(text); return true; } });
  store.create('memory test');
  for (let i = 0; i < 6; i++) { await runner.tick(); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.deepEqual(remembered, ['mission.completed']);
  assert.equal(notified.length, 1);
});

test('risk assessment ignores URL query strings and harmless "message"/"format" wording', () => {
  const { sanitizeForRisk } = require('../core/missions/engine');
  const { assessAction } = require('../core/action-safety-policy');
  const flagged = text => assessAction({ kind: 'task', description: sanitizeForRisk(text) }).requiresConfirmation;
  assert.equal(flagged("Use curl -s 'https://wttr.in/Tashkent?format=3' and return a short message in the error field"), false);
  assert.equal(flagged('Return the result as formatted text with an error message on failure'), false);
  assert.equal(flagged('Format the disk and reinstall'), true);
  assert.equal(flagged('Send a message to my brother'), true);
});
