'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StandingApprovals } = require('../core/missions/standing');
const { GoalEngine } = require('../core/missions/engine');
const { MissionStore } = require('../core/missions/store');
const { createMissionApi } = require('../core/missions/api');
const { RealtimeSession } = require('../skills/realtime-voice');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'standing-')); }

test('a standing permission covers job applications up to the daily limit and then asks again', () => {
  let now = Date.parse('2026-09-21T10:00:00');
  const standing = new StandingApprovals({ file: path.join(tmp(), 's.json'), now: () => now });
  standing.grant({ scopes: ['job-applications'], perDay: 2, days: 3 });
  const engine = new GoalEngine({ store: {}, llm: {}, workers: {}, standing });
  const ask = prompt => engine._needsApproval({ title: prompt, prompt, approved: false });
  assert.equal(ask('Apply to the Senior Backend Engineer job at Acme using Easy Apply'), null);
  assert.equal(ask('Apply to the Node.js Engineer job at Globex using Easy Apply'), null);
  assert.match(ask('Apply to the Python Engineer job at Initech using Easy Apply'), /job application/);
  now += 86400000;
  assert.equal(ask('Apply to the Go Engineer job at Hooli using Easy Apply'), null);
  now += 4 * 86400000;
  assert.match(ask('Apply to the Rust Engineer job at Pied Piper using Easy Apply'), /job application/);
});

test('standing permissions never cover payments, deletions, passwords or unrelated scopes', () => {
  const standing = new StandingApprovals({ file: path.join(tmp(), 's.json') });
  standing.grant({ scopes: ['job-applications', 'recruiter-messages', 'external-messages'], perDay: 50, days: 30 });
  const engine = new GoalEngine({ store: {}, llm: {}, workers: {}, standing });
  const ask = prompt => engine._needsApproval({ title: prompt, prompt, approved: false });
  assert.ok(ask('Buy the premium LinkedIn subscription'));
  assert.ok(ask('Delete all my files and apply to jobs'));
  assert.ok(ask('Apply to the job and enter my password when asked'));
  assert.ok(ask('Transfer money to the recruiter'));
  const narrow = new StandingApprovals({ file: path.join(tmp(), 'n.json') });
  narrow.grant({ scopes: ['recruiter-messages'], perDay: 5 });
  const narrowEngine = new GoalEngine({ store: {}, llm: {}, workers: {}, standing: narrow });
  assert.ok(narrowEngine._needsApproval({ title: 'Apply to the job', prompt: 'Apply to the Data Engineer job using Easy Apply', approved: false }));
  assert.equal(narrowEngine._needsApproval({ title: 'Message HR', prompt: 'Message the HR of Acme about the role', approved: false }), null);
});

test('rules expire, can be revoked, and reject unknown scopes', () => {
  let now = 1000;
  const standing = new StandingApprovals({ file: path.join(tmp(), 's.json'), now: () => now });
  assert.throws(() => standing.grant({ scopes: ['everything'] }), /Noma'lum/);
  const rule = standing.grant({ scopes: ['external-messages'], days: 1 });
  assert.equal(standing.list().length, 1);
  assert.equal(standing.revoke(rule.id), 1);
  assert.equal(standing.list().length, 0);
  standing.grant({ scopes: ['external-messages'], days: 1 });
  now += 2 * 86400000;
  assert.equal(standing.list().length, 0);
});

test('granting by voice needs a spoken confirmation; listing and revoking work immediately', async () => {
  const dir = tmp();
  const api = createMissionApi(new MissionStore({ dir }));
  const spoken = [];
  const session = new RealtimeSession({ missions: api, explicitUserSession: true });
  session.ws = { send() {}, close() {} };
  session._deliverSpokenAnswer = async text => { spoken.push(text); };
  const output = session._standingApproval({ action: 'grant', scopes: ['job-applications'], per_day: 5, days: 3 });
  assert.match(output, /Waiting for the user to say confirm/);
  assert.equal(api.standing.list().length, 0, 'nothing is granted before confirmation');
  assert.match(spoken.join(' '), /Say confirm to proceed, or cancel/);
  session._actionSafety.handleUtterance('confirm');
  await session._pendingConfirmedAction();
  assert.equal(api.standing.list().length, 1);
  assert.match(api.listStanding(), /job-applications, 5\/day/);
  assert.match(session._standingApproval({ action: 'revoke', id: 'all' }), /Revoked 1/);
  assert.match(session._standingApproval({ action: 'grant', scopes: ['payments'] }), /Say which kind/);
  session.close();
});
