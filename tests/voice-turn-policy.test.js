'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalize, looksLikeUzbekTurn, looksLikeEnglishIntent,
  classifyUserTurn, isRepeatedResponse
} = require('../core/voice-turn-policy');

test('short acknowledgements remain silent', () => {
  assert.equal(classifyUserTurn('Ha.').reason, 'acknowledgement');
  assert.equal(classifyUserTurn("xo'p").accept, false);
});

test('low-information noise is silent but real short commands survive', () => {
  assert.equal(classifyUserTurn('um').reason, 'low-information');
  assert.equal(classifyUserTurn('Thank you').reason, 'low-information');
  assert.equal(classifyUserTurn('oh').accept, false);
  assert.equal(classifyUserTurn('och').accept, true);
  assert.equal(classifyUserTurn("to'xtat").accept, true);
  assert.equal(classifyUserTurn('nima bo‘ldi').accept, true);
});

test('assistant acoustic echo is rejected but a real command is accepted', () => {
  const lastAssistant = 'Hozir soat o‘n uchdan yetti daqiqa o‘tdi.';
  assert.equal(classifyUserTurn('hozir soat o‘n uchdan yetti daqiqa o‘tdi', { lastAssistant }).reason, 'assistant-echo');
  assert.equal(classifyUserTurn('Chrome brauzerini och', { lastAssistant }).accept, true);
});

test('media mode rejects foreign playback but preserves concise Uzbek commands', () => {
  assert.equal(looksLikeUzbekTurn('Chrome och'), true);
  assert.equal(looksLikeUzbekTurn("What's your destination?"), false);
  assert.deepEqual(classifyUserTurn('İki saat süre sonra hallederiz.', { mediaMode: true }), {
    accept: false,
    reason: 'media-background'
  });
  assert.deepEqual(classifyUserTurn('Jarvis, Chrome och', { mediaMode: true }), {
    accept: true,
    reason: 'speech'
  });
});

test('English questions and commands are accepted while passive media dialogue stays blocked', () => {
  assert.equal(looksLikeEnglishIntent('What time is it?'), true);
  assert.equal(looksLikeEnglishIntent('Please open Chrome'), true);
  assert.equal(looksLikeEnglishIntent('Happiness will come to you.'), false);
  assert.equal(looksLikeEnglishIntent('Will you open Chrome?'), true);
  assert.equal(classifyUserTurn('Thanks for watching, see you next time.', { mediaMode: true }).reason, 'media-background');
  assert.equal(classifyUserTurn('Happiness will come to you.', { mediaMode: true }).reason, 'media-background');
  assert.equal(classifyUserTurn('What time is it?', { mediaMode: true }).accept, true);
  assert.equal(classifyUserTurn('Please open Chrome', { mediaMode: true }).accept, true);
});

test('near duplicate assistant responses are recognized early', () => {
  assert.equal(isRepeatedResponse('Chrome brauzeri muvaffaqiyatli ochildi', 'Chrome brauzeri muvaffaqiyatli ochildi.'), true);
  assert.equal(isRepeatedResponse('Bugun havo issiq', 'Chrome brauzeri muvaffaqiyatli ochildi.'), false);
  assert.equal(isRepeatedResponse('Chrome brauzeri orqali', 'Chrome brauzeri orqali GitHub ochildi va loyiha topildi'), false);
});