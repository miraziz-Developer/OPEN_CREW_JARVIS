'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isStopIntent } = require('../core/voice-turn-policy');
const { RealtimeSession } = require('../skills/realtime-voice');

test('short stop and acknowledgement phrases are stop intents in Uzbek, English and Russian', () => {
  for (const text of ['Aha, okay okay.', 'Boldi.', "Bo'ldi, kerak emas.", 'Stop.', 'Okay, that is enough.', 'Хватит', 'Ладно, понял', 'Thank you.', 'Got it.', 'Keremas', '啊哈ok ok 。', 'Boldy.', 'VD.', 'Top.', 'Stap!']) {
    assert.equal(isStopIntent(text), true, text);
  }
});

test('real follow-ups and commands are never stop intents', () => {
  for (const text of ['What about Spain?', 'Okay, and what about Spain?', 'Tell me more.', 'Yes, please continue explaining.', 'Stop the music.', 'Okay open Safari', '啊哈', 'Python is better', 'Shot', 'Tell']) {
    assert.equal(isStopIntent(text), false, text);
  }
});

function speakingSession() {
  const sent = [];
  const signals = [];
  const session = new RealtimeSession({ explicitUserSession: true });
  session.ready = true;
  session.ws = { send: raw => sent.push(JSON.parse(raw)), close() {} };
  session.provider = { id: 'voice-live' };
  session.playProc = { kill: signal => signals.push(signal), stdin: { writable: true, write() { return true; } } };
  session._startBackgroundGrounding = () => {};
  let flushed = 0;
  session._flushPlayback = () => { flushed++; };
  session.assistantSpeaking = true;
  session._realtimeResponseActive = true;
  session._lastAssistantTranscript = 'Paris was founded by a Celtic tribe called the Parisii and grew into a major Roman city.';
  return { session, sent, signals, flushed: () => flushed };
}
const say = (session, transcript) => session._onMessage({ data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript }) });

test('saying "boldi" while JARVIS speaks after a barge-in pause stops the reply and produces no new response', () => {
  const { session, sent, flushed } = speakingSession();
  const suppressed = [];
  session.on('turn_suppressed', (reason) => suppressed.push(reason));
  session._beginDuck();
  say(session, 'Boldi.');
  assert.deepEqual(suppressed, ['stop-command']);
  assert.equal(sent.filter(m => m.type === 'response.cancel').length, 1);
  assert.equal(flushed(), 1);
  assert.equal(session.assistantSpeaking, false);
  assert.equal(sent.some(m => m.type === 'response.create'), false);
  assert.ok(session._quietUntil > Date.now());
  session.close();
});

test('a stop phrase without a barge-in pause still cancels and flushes the speaking reply', () => {
  const { session, sent, flushed } = speakingSession();
  say(session, 'Okay okay, kerak emas.');
  assert.equal(sent.filter(m => m.type === 'response.cancel').length, 1);
  assert.equal(flushed(), 1);
  assert.equal(sent.some(m => m.type === 'response.create'), false);
  session.close();
});

test('the same acknowledgement is ignored quietly when JARVIS is not speaking', () => {
  const { session, sent } = speakingSession();
  session.assistantSpeaking = false;
  session._realtimeResponseActive = false;
  session._playbackUntil = 0;
  say(session, 'Okay okay.');
  assert.equal(sent.some(m => m.type === 'response.cancel'), false);
  session.close();
});

test('background follow-ups stay quiet right after the user asked JARVIS to stop', () => {
  const { session } = speakingSession();
  session._backgroundResearch = { serial: session._groundedTurnSerial, question: 'q', answer: 'late answer' };
  let delivered = 0;
  session._deliverSpokenAnswer = async () => { delivered++; };
  session._realtimeResponseActive = false;
  session.assistantSpeaking = false;
  session._quietUntil = Date.now() + 5000;
  session._deliverReadyBackgroundResearch();
  assert.equal(delivered, 0);
  session._quietUntil = 0;
  session._deliverReadyBackgroundResearch();
  assert.equal(delivered, 1);
  session.close();
});
