'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RealtimeSession } = require('../skills/realtime-voice');

function alwaysOnSession(options = {}) {
  const sent = [];
  const session = new RealtimeSession({ wakeRequired: true, ...options });
  session.ready = true;
  session.ws = { send: raw => sent.push(JSON.parse(raw)), close() {} };
  session.provider = { id: 'voice-live' };
  session._startBackgroundGrounding = () => {};
  session._flushPlayback = () => {};
  const suppressed = [];
  const accepted = [];
  session.on('turn_suppressed', reason => suppressed.push(reason));
  session.on('user_transcript', text => accepted.push(text));
  return { session, sent, suppressed, accepted };
}
const tone = (amplitude, bytes = 1920) => { const buffer = Buffer.alloc(bytes); for (let i = 0; i < bytes; i += 2) buffer.writeInt16LE(i % 4 ? amplitude : -amplitude, i); return buffer; };

test('room talk without the wake word is dropped silently and removed from the server conversation', () => {
  const { session, sent, suppressed, accepted } = alwaysOnSession();
  assert.equal(session._acceptTranscript('what is the capital of france', { itemId: 'item-1' }), false);
  assert.deepEqual(suppressed, ['no-wake']);
  assert.deepEqual(accepted, []);
  assert.ok(sent.some(m => m.type === 'conversation.item.delete' && m.item_id === 'item-1'));
  assert.equal(sent.some(m => m.type === 'response.create'), false);
  session.close();
});

test('"Jarvis, <command>" is accepted with the wake phrase stripped, and follow-ups then need no wake word', () => {
  const { session, sent, suppressed, accepted } = alwaysOnSession();
  assert.equal(session._acceptTranscript('Jarvis, why is the sky blue?', { itemId: 'i1' }), true);
  assert.deepEqual(accepted, ['why is the sky blue']);
  assert.equal(sent.filter(m => m.type === 'response.create').length, 1);
  assert.equal(session._conversationContext.isActive(), true);
  assert.equal(session._acceptTranscript('and why is grass green?', { itemId: 'i2' }), true);
  assert.deepEqual(accepted, ['why is the sky blue', 'and why is grass green?']);
  assert.deepEqual(suppressed, []);
  session.close();
});

test('a bare "Hey Jarvis" opens the conversation window (chime path) without creating a response', () => {
  const { session, sent, suppressed, accepted } = alwaysOnSession();
  assert.equal(session._acceptTranscript('Hey Jarvis.', { itemId: 'i1' }), false);
  assert.deepEqual(suppressed, ['wake-only']);
  assert.equal(session._conversationContext.isActive(), true);
  assert.equal(sent.some(m => m.type === 'response.create'), false);
  assert.equal(session._acceptTranscript('open safari', { itemId: 'i2' }), true);
  assert.deepEqual(accepted, ['open safari']);
  session.close();
});

test('server auto-response stays off until the conversation is active, then switches on', () => {
  const { session, sent } = alwaysOnSession();
  assert.equal(session._autoResponseOn, false);
  session._syncAutoResponse();
  assert.equal(sent.filter(m => m.type === 'session.update').length, 0);
  session._conversationContext.touch();
  session._syncAutoResponse();
  const updates = sent.filter(m => m.type === 'session.update');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].session.turn_detection.create_response, true);
  session.close();
});

test('an explicit Fn session is never wake-gated', () => {
  const { session, accepted } = alwaysOnSession({ explicitUserSession: true });
  assert.equal(session._acceptTranscript('what is the capital of france'), true);
  assert.deepEqual(accepted, ['what is the capital of france']);
  session.close();
});

test('idle energy gate keeps quiet audio local, and opens with a pre-roll so the first syllable is not clipped', () => {
  const { session } = alwaysOnSession();
  session.enableNativeAec();
  for (let i = 0; i < 12; i++) assert.equal(session._nativeGate(tone(20)).send, false);
  const opened = session._nativeGate(tone(3000));
  assert.equal(opened.send, true);
  assert.ok(opened.audio.length > 1920, 'pre-roll is prepended to the first speech chunk');
  assert.equal(session._nativeGate(tone(20)).send, true);           // hangover keeps the tail
  session._idleHangMs = 0;
  assert.equal(session._nativeGate(tone(20)).send, false);          // closed again
  session.close();
});

test('inside a conversation the idle gate is bypassed so everything the user says reaches the server', () => {
  const { session } = alwaysOnSession();
  session.enableNativeAec();
  session._conversationContext.touch();
  assert.equal(session._nativeGate(tone(20)).send, true);
  session.close();
});
