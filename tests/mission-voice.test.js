'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RealtimeSession, buildTools, loadInstructions } = require('../skills/realtime-voice');
const { MissionStore } = require('../core/missions/store');
const { createMissionApi } = require('../core/missions/api');

function sessionWith(api) {
  const sent = [];
  const session = new RealtimeSession({ missions: api, explicitUserSession: true });
  session.ws = { send: raw => sent.push(JSON.parse(raw)), close() {} };
  session.ready = true;
  return { session, sent, outputOf: callId => sent.find(m => m.item?.call_id === callId)?.item.output };
}
const call = (session, name, args, id = 'c1') => session._handleFunctionCall({ name, call_id: id, arguments: JSON.stringify(args) });

test('the voice model is offered start_mission, mission_status and mission_control', () => {
  const names = buildTools().map(tool => tool.name);
  for (const name of ['start_mission', 'mission_status', 'mission_control', 'run_task', 'fast_action']) assert.ok(names.includes(name), name);
  const control = buildTools().find(tool => tool.name === 'mission_control');
  assert.deepEqual(control.parameters.properties.action.enum, ['pause', 'resume', 'cancel', 'approve', 'reject', 'note']);
  assert.match(loadInstructions(), /voice bridge between the user and a team of autonomous background agents/);
});

test('voice tools create, inspect and control missions instantly without blocking the conversation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-voice-missions-'));
  const store = new MissionStore({ dir });
  const { session, sent, outputOf } = sessionWith(createMissionApi(store));

  const started = Date.now();
  await call(session, 'start_mission', { goal: 'Research the best laptops and write a report until it is done', hours: 6 }, 'a');
  assert.ok(Date.now() - started < 500, 'must return immediately');
  assert.match(outputOf('a'), /Mission 1 started/);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].budget.maxHours, 6);
  assert.ok(sent.some(m => m.type === 'response.create'), 'the model gets to speak right away');

  await call(session, 'mission_status', {}, 'b');
  assert.match(outputOf('b'), /Mission 1 \(planning\)/);

  await call(session, 'mission_control', { action: 'pause' }, 'c');
  assert.match(outputOf('c'), /Pause sent to mission 1/);
  assert.equal(store.drainInbox()[0].action, 'pause');

  await call(session, 'mission_control', { action: 'explode', mission: '1' }, 'd');
  assert.match(outputOf('d'), /Unknown action/);
  session.close();
});

test('control asks which mission when several are open, and approve targets the one waiting for approval', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-voice-missions-'));
  const store = new MissionStore({ dir });
  const api = createMissionApi(store);
  const one = store.create('goal one');
  const two = store.create('goal two');
  assert.match(api.control(null, 'pause'), /Which mission\? Open ones: 1, 2/);
  two.status = 'awaiting_approval';
  two.pendingApproval = { taskId: 't1', reason: 'send an email' };
  store.save(two);
  assert.match(api.control(null, 'approve'), /Approve sent to mission 2/);
  assert.match(api.status(), /waiting for approval: send an email/);
  assert.equal(one.status, 'planning');
});

test('announce queues a background mission update for speech and the instructions list open missions', () => {
  const { session } = sessionWith(null);
  let delivered = 0;
  session._deliverReadyBackgroundWork = () => { delivered++; };
  assert.equal(session.announce('Mission 2 is complete: report written.'), true);
  assert.equal(session._backgroundTaskResults.length, 1);
  assert.equal(delivered, 1);
  assert.equal(session.announce('   '), false);
  session.close();
});

test('a session without a mission API answers politely instead of crashing', async () => {
  const { session, outputOf } = sessionWith(null);
  await call(session, 'start_mission', { goal: 'x' }, 'z');
  assert.match(outputOf('z'), /not available/);
  session.close();
});
