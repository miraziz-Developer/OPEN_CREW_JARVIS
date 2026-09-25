'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalize, looksLikeUzbekTurn, looksLikeEnglishIntent,
  classifyUserTurn, isRepeatedResponse, conversationIdleDelay
} = require('../core/voice-turn-policy');

test('short acknowledgements remain silent', () => {
  assert.equal(classifyUserTurn('Ha.').reason, 'acknowledgement');
  assert.equal(classifyUserTurn("xo'p").accept, false);
});

test('short acknowledgements continue an active conversation', () => {
  assert.deepEqual(classifyUserTurn('Ha', { conversationActive: true }), {
    accept: true,
    reason: 'contextual-acknowledgement'
  });
  assert.deepEqual(classifyUserTurn('yes', { conversationActive: true }), {
    accept: true,
    reason: 'contextual-acknowledgement'
  });
  assert.equal(classifyUserTurn('yes').reason, 'acknowledgement');
});

test('English acknowledgements remain silent while complete English turns pass', () => {
  assert.equal(classifyUserTurn('Okay.').reason, 'acknowledgement');
  assert.equal(classifyUserTurn('Please continue with the deployment.').accept, true);
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
  assert.deepEqual(classifyUserTurn('Salaam.', { mediaMode: true, explicitUserTrigger: true }), {
    accept: true,
    reason: 'speech'
  });
  // Chaqiruvsiz bitta so'z media paytida ham rad etiladi (sababi: bir so'zli shovqin filtri birinchi ishlaydi).
  assert.equal(classifyUserTurn('Salaam.', { mediaMode: true }).accept, false);
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
  assert.equal(classifyUserTurn('Analyze why this architecture is better.', { mediaMode: true }).accept, true);
  assert.equal(classifyUserTurn("Who's first is Agent A. Look for Agent A. Agent B is Agent A. Let's look for Agent B.", { mediaMode: true }).reason, 'media-background');
  assert.equal(classifyUserTurn("Damn, he looks like he is from a big city. I don't remember what country he is from.", { mediaMode: true }).reason, 'media-background');
});

test('near duplicate assistant responses are recognized early', () => {
  assert.equal(isRepeatedResponse('Chrome brauzeri muvaffaqiyatli ochildi', 'Chrome brauzeri muvaffaqiyatli ochildi.'), true);
  assert.equal(isRepeatedResponse('Bugun havo issiq', 'Chrome brauzeri muvaffaqiyatli ochildi.'), false);
  assert.equal(isRepeatedResponse('Chrome brauzeri orqali', 'Chrome brauzeri orqali GitHub ochildi va loyiha topildi'), false);
});

test('conversation follow-up window starts after queued assistant playback', () => {
  assert.equal(conversationIdleDelay({
    now: 1000, idleMs: 20000, followupMs: 30000,
    playbackUntil: 5000, awaitingFollowup: true
  }), 34000);
  assert.equal(conversationIdleDelay({
    now: 1000, idleMs: 20000, followupMs: 30000,
    playbackUntil: 5000, awaitingFollowup: false
  }), 24000);
});
test('room noise from the logs is rejected; real commands and answers to a question are kept', () => {
  const reject = [['啊，star of those per an end 。Cool tonight, we sound cool', {}, 'foreign-script'], ['Hey, Cortana.', { conversationActive: true }, 'other-assistant'],
    ['Können.', { conversationActive: true }, 'low-information'], ['Controller.', { conversationActive: true }, 'low-information'], ['山にやってますが', {}, 'foreign-script']];
  for (const [text, ctx, reason] of reject) assert.deepEqual(classifyUserTurn(text, ctx), { accept: false, reason }, text);
  for (const [text, ctx] of [['open safari', {}], ['what is on my calendar today', { conversationActive: true }], ['Telegram', { conversationActive: true, lastAssistant: 'Which app?' }], ['stop', {}]]) {
    assert.equal(classifyUserTurn(text, ctx).accept, true, text);
  }
});
