'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ConversationContext } = require('../core/conversation-context');
const { ActionSafetyPolicy, assessAction } = require('../core/action-safety-policy');
const { InteractionPolicy } = require('../core/interaction-policy');

test('follow-up context resolves entities inside the window and expires cleanly', () => {
  let now = 1000;
  const context = new ConversationContext({ now: () => now, windowMs: 20000 });
  context.observe('user', 'Open project Atlas', { world: { app: 'VS Code' } });
  now += 5000;
  const followUp = context.resolve('Continue that task there');
  assert.equal(followUp.resolved, true);
  assert.equal(followUp.entities.project, 'Atlas');
  assert.equal(followUp.entities.app, 'VS Code');
  assert.match(context.grounding('Continue that task'), /project: Atlas/);
  now += 21000;
  assert.equal(context.resolve('Continue that task').ambiguous, true);
});

test('unbound references are marked ambiguous instead of guessed', () => {
  const context = new ConversationContext();
  assert.deepEqual(context.resolve('Send it there'), {
    active: false, referential: true, resolved: false, ambiguous: true,
    entities: {}, lastReferencedObject: null
  });
});

test('action safety allows low-risk actions and gates destructive or external effects', () => {
  assert.equal(assessAction({ kind: 'fast-action', id: 'open:safari' }).requiresConfirmation, false);
  assert.equal(assessAction({ kind: 'fast-action', id: 'system:empty_trash' }).destructive, true);
  assert.equal(assessAction({ kind: 'task', description: 'Send an email to Ada' }).externalSideEffect, true);
});

test('confirmation grant is explicit, scoped, expiring and one-shot', () => {
  let now = 1000;
  const policy = new ActionSafetyPolicy({ now: () => now, confirmationTtlMs: 5000 });
  const action = { kind: 'task', description: 'Send the report by email' };
  assert.equal(policy.authorize(action).allowed, false);
  assert.equal(policy.handleUtterance('maybe').matched, false);
  assert.equal(policy.handleUtterance('confirm').confirmed, true);
  assert.equal(policy.authorize(action).reason, 'explicit-confirmation');
  assert.equal(policy.authorize(action).allowed, false);
  now += 6000;
  assert.equal(policy.handleUtterance('confirm').matched, false);
});

test('full autonomy permits only routine actions and never bypasses high-risk confirmation', () => {
  const autonomy = new ActionSafetyPolicy({ fullAutonomyProvider: () => true });
  const routine = { kind: 'task', description: 'Update the local project configuration' };
  const highRisk = { kind: 'task', description: 'Send an email to Ada' };
  assert.equal(autonomy.authorize(routine).reason, 'full-autonomy-routine-action');
  assert.equal(autonomy.authorize(highRisk).allowed, false);
  assert.equal(autonomy.authorize(highRisk).assessment.category, 'external-communication');
});

test('routine mutation returns to confirmation when full autonomy is disabled', () => {
  const policy = new ActionSafetyPolicy({ fullAutonomyProvider: () => false });
  assert.equal(policy.authorize({ kind: 'task', description: 'Install project dependencies' }).allowed, false);
});

test('privacy and focus suppress non-urgent interruptions while progress stays bounded', () => {
  const policy = new InteractionPolicy({ progressAfterMs: 1800, progressRepeatMs: 12000 });
  assert.equal(policy.notification({ urgency: 1 }, { privacyMode: true }).reason, 'privacy-mode');
  assert.equal(policy.notification({ urgency: 0.8 }, { meeting: true }).mode, 'queue');
  assert.equal(policy.notification({ urgency: 0.95 }, { focusMode: true }).mode, 'interrupt');
  assert.deepEqual(policy.responsePlan({ expectedMs: 1000 }).progress, []);
  assert.deepEqual(policy.responsePlan({ expectedMs: 30000 }).progress, [1800, 13800, 25800]);
});