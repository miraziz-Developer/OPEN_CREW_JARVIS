'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessSample } = require('../scripts/collect-wake-samples');

test('wake sample quality rejects silence and clipping', () => {
  assert.equal(assessSample({ rms: 20, peak: 60, clippedRatio: 0 }).accepted, false);
  assert.equal(assessSample({ rms: 4000, peak: 32767, clippedRatio: 0.01 }).accepted, false);
});

test('wake sample quality accepts clear non-clipped speech', () => {
  assert.deepEqual(assessSample({ rms: 1800, peak: 9000, clippedRatio: 0 }), {
    accepted: true,
    reason: null
  });
});