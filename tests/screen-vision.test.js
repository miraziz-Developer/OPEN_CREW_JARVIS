'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractJson, normalizeVisionResult, buildVisionRequestBody } = require('../skills/screen-vision');

test('structured vision parses fenced JSON and computes pixel center', () => {
  const parsed = extractJson('```json\n{"summary":"Save visible","elements":[{"name":"Save","role":"button","confidence":1.4,"bounds":{"x":10,"y":20,"width":80,"height":40}}]}\n```');
  const result = normalizeVisionResult(parsed);
  assert.equal(result.elements[0].confidence, 1);
  assert.deepEqual(result.elements[0].center, { x: 50, y: 40 });
});

test('structured vision removes invalid geometry and sorts confidence', () => {
  const result = normalizeVisionResult({ elements: [
    { name: 'bad', confidence: 1, bounds: { x: 'x', y: 0, width: 1, height: 1 } },
    { name: 'low', confidence: 0.2, bounds: { x: 0, y: 0, width: 1, height: 1 } },
    { name: 'high', confidence: 0.9, bounds: { x: 2, y: 3, width: 4, height: 5 }, center: { x: 9, y: 10 } }
  ] });
  assert.deepEqual(result.elements.map(item => item.name), ['high', 'low']);
  assert.deepEqual(result.elements[0].center, { x: 9, y: 10 });
});

test('structured vision requests guaranteed JSON output without changing normal requests', () => {
  const structured = buildVisionRequestBody('abc', 'locate', { structured: true });
  assert.deepEqual(structured.response_format, { type: 'json_object' });
  assert.equal(structured.max_completion_tokens, 2000);
  const normal = buildVisionRequestBody('abc', 'describe');
  assert.equal(normal.response_format, undefined);
  assert.equal(normal.max_completion_tokens, 800);
});