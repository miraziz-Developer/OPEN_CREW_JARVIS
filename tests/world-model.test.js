'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorldModel, normalizeSnapshot, diffSnapshots, verifyExpectation } = require('../core/world-model');
const { buildGroundedPrompt } = require('../skills/screen-vision');
const { parseJxaJson } = require('../core/macos-context');

const chrome = (url = 'https://example.com', title = 'Example') => ({
  capturedAt: 100, app: 'Google Chrome', bundleId: 'com.google.Chrome',
  window: { title, bounds: { x: 0, y: 0, width: 900, height: 700 } },
  browser: { name: 'Google Chrome', url, title }, focus: { role: 'AXTextField', title: 'Address', value: url }
});

test('snapshot normalization strips noise and semantic diff ignores timestamps', () => {
  const first = normalizeSnapshot(chrome(), 100);
  const second = normalizeSnapshot({ ...chrome(), capturedAt: 999 }, 999);
  assert.equal(diffSnapshots(first, second).changed, false);
  const changed = normalizeSnapshot(chrome('https://openai.com', 'OpenAI'), 1000);
  assert.equal(diffSnapshots(first, changed).contextChanged, true);
});

test('post-action verification requires explicit observable expectation', () => {
  const before = normalizeSnapshot(chrome());
  const after = normalizeSnapshot(chrome('https://github.com/org/repo', 'Repository'));
  const verified = verifyExpectation(before, after, { app: 'Chrome', url: 'github.com', changed: true });
  assert.equal(verified.ok, true);
  assert.equal(verifyExpectation(before, after, {}).ok, false);
  assert.equal(verifyExpectation(before, after, { windowTitle: 'Settings' }).ok, false);
});

test('world model persists bounded semantic event history atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-world-'));
  const file = path.join(dir, 'world.json');
  let now = 100;
  const model = new WorldModel({ file, maxEvents: 2, now: () => now });
  model.observe(chrome());
  now++; model.observe(chrome('https://a.test', 'A'));
  now++; model.observe(chrome('https://b.test', 'B'));
  assert.equal(model.history(10).length, 2);
  const resumed = new WorldModel({ file });
  assert.equal(resumed.current().browser.url, 'https://b.test');
});

test('vision prompt is grounded with app browser and focused accessibility context', () => {
  const prompt = buildGroundedPrompt('Tugmani top', normalizeSnapshot(chrome()));
  assert.match(prompt, /Google Chrome/);
  assert.match(prompt, /https:\/\/example\.com/);
  assert.match(prompt, /AXTextField/);
  assert.match(prompt, /o‘ylab topma/);
});

test('macOS JXA payload parser rejects noise and accepts semantic context', () => {
  assert.equal(parseJxaJson('not json'), null);
  assert.equal(parseJxaJson('{"app":"Safari","window":{"title":"Docs"}}').app, 'Safari');
});

test('separate world model instances merge fresh events instead of overwriting them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-world-race-'));
  const file = path.join(dir, 'world.json');
  const first = new WorldModel({ file, maxEvents: 10 });
  const second = new WorldModel({ file, maxEvents: 10 });
  first.observe(chrome('https://one.test', 'One'));
  second.observe(chrome('https://two.test', 'Two'));
  first.verify(first.current(), normalizeSnapshot(chrome('https://three.test', 'Three')), { url: 'three.test' });
  assert.equal(second.history(20).length, 3);
  assert.equal(second.history(20)[2].type, 'action.verified');
});