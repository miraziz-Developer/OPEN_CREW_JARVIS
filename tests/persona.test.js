'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CHARACTER_INSTRUCTIONS, personaInstructions } = require('../core/persona');
const { loadInstructions } = require('../skills/realtime-voice');

test('character keeps the wit sparse, the edge loyal, and never overrides safety', () => {
  assert.match(CHARACTER_INSTRUCTIONS, /dry, deadpan/i);
  assert.match(CHARACTER_INSTRUCTIONS, /roughly one reply in five/i);
  assert.match(CHARACTER_INSTRUCTIONS, /never during a serious, risky, or stressful moment/i);
  assert.match(CHARACTER_INSTRUCTIONS, /never at the user/i);
  assert.match(CHARACTER_INSTRUCTIONS, /never threaten or demean/i);
  assert.match(CHARACTER_INSTRUCTIONS, /never overrides safety, honesty, confirmation requirements/i);
});

test('voice instructions include the character by default and JARVIS_PERSONA=plain removes it', () => {
  const previous = process.env.JARVIS_PERSONA;
  try {
    delete process.env.JARVIS_PERSONA;
    assert.match(loadInstructions(), /CHARACTER: you are JARVIS with an edge/);
    process.env.JARVIS_PERSONA = 'plain';
    assert.doesNotMatch(loadInstructions(), /CHARACTER: you are JARVIS with an edge/);
    const plainInstr = personaInstructions(k => (k === 'JARVIS_PERSONA' ? 'plain' : ''));
    assert.doesNotMatch(plainInstr, /CHARACTER: you are JARVIS with an edge/);
    assert.match(plainInstr, /BREVITY/); // qisqalik plain rejimda ham saqlanadi
  } finally {
    if (previous === undefined) delete process.env.JARVIS_PERSONA; else process.env.JARVIS_PERSONA = previous;
  }
});

test('hedged musings are conversation, while real commands still start a background task', () => {
  const { needsBackgroundAgentTask } = require('../skills/realtime-voice');
  for (const text of [
    'I think I should just delete all my files and start over.',
    'Maybe I should open a new project.',
    'What if we restart the server?',
    'I should probably fix the login bug tomorrow.'
  ]) assert.equal(needsBackgroundAgentTask(text), false, text);
  for (const text of [
    'Delete all my files and start over.',
    'Open the project folder and create a new file called notes.'
  ]) assert.equal(needsBackgroundAgentTask(text), true, text);
});

test('voice instructions tell the model it can act through run_task and must not ask for lookup-able details', () => {
  const instructions = require('../skills/realtime-voice').loadInstructions();
  assert.match(instructions, /never say you cannot do something/i);
  assert.match(instructions, /never ask the user for information you can look up/i);
  assert.match(instructions, /calendar and email/i);
  assert.match(instructions, /recall_memory first/i);
});

test('confirmation prompts say exactly what is about to happen', () => {
  const { confirmationPrompt } = require('../skills/realtime-voice');
  assert.match(confirmationPrompt('Send an email to John saying I will be late.', { externalSideEffect: true }), /sends something outside this machine: Send an email to John saying I will be late\. Say confirm/);
  assert.match(confirmationPrompt('Delete all my files', { destructive: true }), /destructive or hard to undo: Delete all my files/);
  assert.ok(confirmationPrompt('x'.repeat(400), {}).length < 190);
});
