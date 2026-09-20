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
    assert.equal(personaInstructions(k => (k === 'JARVIS_PERSONA' ? 'plain' : '')), '');
  } finally {
    if (previous === undefined) delete process.env.JARVIS_PERSONA; else process.env.JARVIS_PERSONA = previous;
  }
});
