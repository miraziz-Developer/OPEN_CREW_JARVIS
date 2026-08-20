'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  integerToUzbek,
  normalizeApostrophes,
  normalizeUzbekSpeech,
  ordinalToUzbek,
  voiceStyleInstructions
} = require('../core/uzbek-speech-normalizer');

test('integerToUzbek converts common cardinal values', () => {
  assert.equal(integerToUzbek(0), 'nol');
  assert.equal(integerToUzbek(42), 'qirq ikki');
  assert.equal(integerToUzbek(2026), 'ikki ming yigirma olti');
  assert.equal(integerToUzbek(125000), 'bir yuz yigirma besh ming');
});

test('ordinalToUzbek inflects the final number word', () => {
  assert.equal(ordinalToUzbek(21), 'yigirma birinchi');
  assert.equal(ordinalToUzbek(2026), 'ikki ming yigirma oltinchi');
});

test('normalizes Uzbek apostrophes without changing quote punctuation', () => {
  assert.equal(normalizeApostrophes("O'zbekiston g`alaba qozondi"), 'O‘zbekiston g‘alaba qozondi');
  assert.equal(normalizeApostrophes("U 'ha' dedi"), "U 'ha' dedi");
});

test('expands time, date, percent, currency and decimal for speech', () => {
  assert.equal(normalizeUzbekSpeech('Uchrashuv 21.08.2026 kuni 09:05 da.'),
    'Uchrashuv yigirma birinchi avgust, ikki ming yigirma oltinchi yil kuni to‘qqiz-u besh da.');
  assert.equal(normalizeUzbekSpeech('Natija 12,5%, narxi 150 USD.'),
    'Natija o‘n ikki butun besh foiz, narxi bir yuz ellik AQSh dollari.');
  assert.equal(normalizeUzbekSpeech('Aniqlik 97,5% ga yetdi.'),
    'Aniqlik to‘qson yetti butun besh foizga yetdi.');
});

test('expands common technical abbreviations and URLs', () => {
  assert.equal(normalizeUzbekSpeech('API va JSON https://jarvis.ai/docs da.'),
    'ey pi ay va jeyson jarvis nuqta ai slesh docs da.');
});

test('long identifiers are read digit by digit', () => {
  assert.equal(normalizeUzbekSpeech('Kod 90817263.'),
    'Kod to‘qqiz nol sakkiz bir yetti ikki olti uch.');
});

test('cinematic profile is explicit and can be disabled', () => {
  const instructions = voiceStyleInstructions('cinematic-uzbek');
  assert.match(instructions, /Cedar/);
  assert.match(instructions, /O‘ va g‘/);
  assert.equal(voiceStyleInstructions('default'), '');
});