'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VisualActionLoop, chooseSemantic, chooseVisual } = require('../core/visual-action-loop');
const { verifyActionResult } = require('../core/action-result');

const state = (title = 'Before') => ({ app: 'Notes', window: { title }, focus: null });
function fixture(overrides = {}) {
  let observations = [state(), state('Saved')];
  const calls = { semantic: 0, visual: 0, locate: 0 };
  const loop = new VisualActionLoop({
    observe: async () => observations.shift() || state('Saved'),
    inspect: async () => [{ title: 'Save', path: [0, 1], score: 90 }],
    actSemantic: async () => { calls.semantic++; return { status: 'ok' }; },
    locateVisual: async () => { calls.locate++; return []; },
    actVisual: async () => { calls.visual++; return { status: 'ok' }; },
    authorize: () => ({ allowed: true, assessment: { risk: 'low' } }), ...overrides
  });
  return { loop, calls };
}

test('visual loop prefers Accessibility and returns trusted independently verified Action Result v1', async () => {
  const { loop, calls } = fixture();
  const result = await loop.run({ target: { name: 'Save' }, action: 'press', expect: { windowTitle: 'Saved', changed: true } });
  assert.equal(result.status, 'completed');
  assert.equal(result.version, 1);
  assert.equal(calls.semantic, 1);
  assert.equal(calls.locate, 0);
  assert.deepEqual(result.evidence.map(item => item.type), ['accessibility', 'world-state']);
  assert.equal(verifyActionResult(result).verification.passed, true);
});

test('visual loop falls back to a unique high-confidence fresh visual target', async () => {
  const { loop, calls } = fixture({ inspect: async () => [], locateVisual: async () => [{ name: 'Save', confidence: 0.94, center: { x: 10, y: 20 } }] });
  const result = await loop.run({ target: { name: 'Save' }, expect: { windowTitle: 'Saved' } });
  assert.equal(result.status, 'completed');
  assert.equal(calls.visual, 1);
  assert.equal(result.evidence[0].type, 'screenshot');
});

test('failed verification re-observes and re-localizes instead of reusing stale coordinates', async () => {
  const centers = [], observations = [state(), state(), state(), state('Saved')];
  let locate = 0;
  const { loop } = fixture({
    observe: async () => observations.shift(), inspect: async () => [],
    locateVisual: async () => [{ name: 'Save', confidence: 0.95, center: { x: ++locate * 10, y: 20 } }],
    actVisual: async ({ target }) => { centers.push(target.center.x); return { status: 'ok' }; }
  });
  const result = await loop.run({ target: { name: 'Save' }, expect: { windowTitle: 'Saved' } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(centers, [10, 20]);
  assert.deepEqual(result.actions.map(item => item.status), ['failed', 'completed']);
});

test('ambiguous targets and missing confirmation stop before acting', async () => {
  assert.equal(chooseSemantic([{ score: 50 }, { score: 47 }]).reason, 'ambiguous');
  assert.equal(chooseVisual([{ confidence: 0.9, center: { x: 1, y: 1 } }, { confidence: 0.85, center: { x: 2, y: 2 } }]).reason, 'ambiguous');
  let acted = false;
  const { loop } = fixture({ authorize: () => ({ allowed: false, assessment: { risk: 'high', fingerprint: 'abc' } }), actSemantic: async () => { acted = true; } });
  const result = await loop.run({ target: { name: 'Delete' }, expect: { changed: true } });
  assert.equal(result.status, 'blocked');
  assert.equal(acted, false);
  assert.equal(result.verification.checks[0].name, 'safety-authorization');
  const stillBlocked = await loop.run({ target: { name: 'Delete' }, expect: { changed: true }, confirmed: true });
  assert.equal(stillBlocked.status, 'blocked');
});

test('visual fallback never types without a uniquely identified Accessibility field', async () => {
  const { loop, calls } = fixture({ inspect: async () => [], locateVisual: async () => [{ name: 'Name', confidence: 0.99, center: { x: 10, y: 20 } }] });
  const result = await loop.run({ target: { name: 'Name' }, action: 'set_value', value: 'secret', expect: { changed: true } });
  assert.equal(result.status, 'blocked');
  assert.equal(calls.visual, 0);
  assert.match(result.summary, /Accessibility element/);
});

test('visual loop requires an explicit observable expectation', async () => {
  const { loop } = fixture();
  await assert.rejects(loop.run({ target: { name: 'Save' } }), /observable expectation/);
});