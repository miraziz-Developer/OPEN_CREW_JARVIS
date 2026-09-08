'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWakeText, isWakePhrase, extractAddressedCommand, findWakeRecognition } = require('../core/wake-word-policy');

test('wake phrase normalization accepts common Jarvis transcriptions', () => {
  assert.equal(normalizeWakeText('  Hey, JARVIS! '), 'hey jarvis');
  for (const phrase of ['Hey Jarvis', 'Jarviz', 'hey Jervis', 'Djarvis']) {
    assert.equal(isWakePhrase(phrase), true, phrase);
  }
  for (const phrase of ['', 'one minute', 'salaam', 'background television']) {
    assert.equal(isWakePhrase(phrase), false, phrase);
  }
});

test('addressed command extraction distinguishes inline speech from wake-only speech', () => {
  assert.deepEqual(extractAddressedCommand('Jarvis, open Safari please.'), {
    addressed: true, wake: 'jarvis', command: 'open safari please'
  });
  assert.deepEqual(extractAddressedCommand('Hey Jervis!'), {
    addressed: true, wake: 'hey jervis', command: ''
  });
  assert.equal(extractAddressedCommand('Open Safari please'), null);
});

test('hybrid wake recognition accepts either locale without accepting unrelated speech', () => {
  assert.equal(findWakeRecognition([
    { status: 'ok', text: 'One minute.' },
    { status: 'ok', text: 'Hey Jervis.' }
  ]).text, 'Hey Jervis.');
  assert.equal(findWakeRecognition([
    { status: 'ok', text: 'Salaam.' },
    { status: 'error', text: '' }
  ]), null);
});

test('cross-locale phonetic evidence recovers the observed accented wake phrase safely', () => {
  const wake = findWakeRecognition([
    { status: 'ok', text: 'Salome.' },
    { status: 'ok', text: 'Salom men tuman.' }
  ]);
  assert.equal(wake.text, 'Hey Jarvis');
  assert.equal(wake.source, 'cross-locale-phonetic');

  // One weak decoder result or an ordinary greeting is insufficient.
  assert.equal(findWakeRecognition([{ status: 'ok', text: 'Salome.' }]), null);
  assert.equal(findWakeRecognition([
    { status: 'ok', text: 'Hello.' },
    { status: 'ok', text: 'Salom men keldim.' }
  ]), null);
  assert.equal(findWakeRecognition([
    { status: 'ok', text: 'Salome.' },
    { status: 'ok', text: 'Salom.' }
  ]), null);
});