'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ConversationContext } = require('../core/conversation-context');

test('conversation context retains references through a natural spoken pause', () => {
  let now = 1_000;
  const context = new ConversationContext({ now: () => now });
  context.observe('User', 'Open the project called Atlas.');

  now += 45_000;
  const resolved = context.resolve('Continue with it.');
  assert.equal(resolved.active, true);
  assert.equal(resolved.resolved, true);
  assert.match(resolved.entities.project, /^Atlas\.?$/);
});

test('conversation context expires after genuine inactivity', () => {
  let now = 1_000;
  const context = new ConversationContext({ now: () => now });
  context.observe('User', 'Open the project called Atlas.');

  now += 60_001;
  const resolved = context.resolve('Continue with it.');
  assert.equal(resolved.active, false);
  assert.equal(resolved.resolved, false);
  assert.equal(resolved.ambiguous, true);
});