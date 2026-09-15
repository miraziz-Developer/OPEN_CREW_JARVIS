'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanPlace, parsePort, createViewUrl, normalizeLayers, availableLayers } = require('../skills/gods-eye-view');

test('Gods Eye View cleans bounded place queries', () => {
  assert.equal(cleanPlace('  Tashkent\n Uzbekistan  '), 'Tashkent Uzbekistan');
  assert.throws(() => cleanPlace(''), /place required/);
  assert.throws(() => cleanPlace('x'.repeat(161)), /at most 160/);
});

test('Gods Eye View allows supported public layers and rejects surveillance layers', () => {
  assert.deepEqual(normalizeLayers(['flights', 'cameras', 'fires', 'vessels']), ['flights', 'cctv', 'local-firms', 'ais-live-vessels']);
  assert.throws(() => normalizeLayers(['alpr-cameras']), /ALPR/);
  assert.throws(() => normalizeLayers(['private-cctv']), /Unsupported/);
  const layers = availableLayers();
  assert.ok(layers.layers.some(layer => layer.id === 'traffic'));
  assert.ok(layers.blocked.some(layer => layer.id === 'alpr-cameras'));
});

test('Gods Eye View encodes requested public layers in the upstream share view', () => {
  const url = new URL(createViewUrl('http://127.0.0.1:4173', 41.2995, 69.2401, { layers: ['traffic', 'earthquakes', 'flights'] }));
  const hash = new URLSearchParams(url.hash.slice(1));
  assert.equal(hash.get('l'), 'e.f.t');
});

test('Gods Eye View uses valid ports and encodes a local share view', () => {
  assert.equal(parsePort('4174'), 4174);
  assert.equal(parsePort('80'), 4173);
  const url = new URL(createViewUrl('http://127.0.0.1:4173', 41.2995, 69.2401, { altitude: 9000 }));
  assert.equal(url.origin, 'http://127.0.0.1:4173');
  const hash = new URLSearchParams(url.hash.slice(1));
  assert.equal(hash.get('lat'), '41.299500');
  assert.equal(hash.get('lon'), '69.240100');
  assert.equal(hash.get('alt'), '9000');
  assert.throws(() => createViewUrl('http://127.0.0.1:4173', 91, 69), /invalid coordinates/);
});