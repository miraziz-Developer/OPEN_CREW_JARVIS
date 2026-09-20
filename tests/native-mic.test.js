'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { NativeMic } = require('../core/native-mic');
const { RealtimeSession } = require('../skills/realtime-voice');

function fakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.end = () => {};
  proc.killed = [];
  proc.kill = signal => { proc.killed.push(signal); };
  return proc;
}

test('NativeMic streams helper audio and reports readiness', () => {
  const proc = fakeProc();
  const mic = new NativeMic({ binary: '/fake', exists: () => true, spawn: () => proc });
  const events = [];
  mic.on('ready', () => events.push('ready'));
  mic.on('data', chunk => events.push(chunk.length));
  assert.equal(mic.start(), process.platform === 'darwin');
  if (process.platform !== 'darwin') return;
  proc.stderr.emit('data', Buffer.from('READY\n'));
  proc.stdout.emit('data', Buffer.alloc(640));
  assert.deepEqual(events, ['ready', 640]);
  mic.stop();
  assert.deepEqual(proc.killed, ['SIGTERM']);
});

test('NativeMic reports unavailable when the helper is missing so callers can fall back', () => {
  const mic = new NativeMic({ binary: '/missing', exists: () => false, spawn: () => { throw new Error('must not spawn'); } });
  let reason = '';
  mic.on('unavailable', value => { reason = value; });
  assert.equal(mic.start(), false);
  assert.equal(reason, 'binary-missing');
});

test('NativeMic surfaces the helper error message on exit', () => {
  if (process.platform !== 'darwin') return;
  const proc = fakeProc();
  const mic = new NativeMic({ binary: '/fake', exists: () => true, spawn: () => proc });
  let info;
  mic.on('exit', value => { info = value; });
  mic.start();
  proc.stderr.emit('data', Buffer.from('ERROR: voice processing yoqilmadi\n'));
  proc.emit('exit', 2, null);
  assert.equal(info.code, 2);
  assert.match(info.error, /voice processing/);
});

test('native AEC gate sends everything when idle and only loud audio as a barge-in while JARVIS speaks', () => {
  const session = new RealtimeSession();
  const loud = Buffer.alloc(640); for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(i % 4 ? 3000 : -3000, i);
  const quiet = Buffer.alloc(640); for (let i = 0; i < quiet.length; i += 2) quiet.writeInt16LE(i % 4 ? 30 : -30, i);
  session.enableNativeAec();
  assert.equal(session._nativeGate(quiet).send, true);
  session.assistantSpeaking = true;
  assert.equal(session._nativeGate(quiet).send, false);
  const gated = session._nativeGate(loud);
  assert.equal(gated.send, true);
  assert.equal(gated.reason, 'barge-in');
  session.close();
});

test('with native AEC the playback reference is not queued, and disabling restores the local AEC path', () => {
  const session = new RealtimeSession();
  let queued = 0;
  session.duplex.queuePlayback = () => { queued++; };
  session.playProc = { stdin: { writable: true, write() { return true; } }, kill() {} };
  session.enableNativeAec();
  session._writePlayback(Buffer.alloc(960));
  assert.equal(queued, 0);
  session.disableNativeAec('no-frames');
  assert.equal(session._nativeAec, false);
  session._writePlayback(Buffer.alloc(960));
  assert.equal(queued, 1);
  session.close();
});

test('once the user takes the turn during native AEC, quiet syllables are still sent', () => {
  const session = new RealtimeSession();
  const quiet = Buffer.alloc(640); for (let i = 0; i < quiet.length; i += 2) quiet.writeInt16LE(i % 4 ? 30 : -30, i);
  session.enableNativeAec();
  session.assistantSpeaking = true;
  assert.equal(session._nativeGate(quiet).send, false);
  session._bargeInConfirmed = true;
  assert.equal(session._nativeGate(quiet).send, true);
  session._bargeInConfirmed = false;
  session._serverSpeechOpen = true;
  assert.equal(session._nativeGate(quiet).send, true);
  session.close();
});

test('native barge-in sends the buffered pre-roll (including quiet syllables) when it is confirmed', () => {
  const session = new RealtimeSession();
  const sent = [];
  session.ready = true;
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session.playProc = { kill() {} };
  session.enableNativeAec();
  session.assistantSpeaking = true;
  const loud = Buffer.alloc(3200); for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(i % 4 ? 4000 : -4000, i);
  const quiet = Buffer.alloc(1280); for (let i = 0; i < quiet.length; i += 2) quiet.writeInt16LE(i % 4 ? 20 : -20, i);
  session.feedAudio(loud);   // 100 ms
  session.feedAudio(quiet);  // 40 ms dip below threshold: must stay in the pre-roll
  session.feedAudio(loud);   // 200 ms of qualifying speech, confirmation needs 250 ms
  session.feedAudio(loud);   // reaches confirmation
  assert.ok(session._duck);
  const appended = sent.filter(m => m.type === 'input_audio_buffer.append');
  assert.equal(appended.length, 1);
  // 16 kHz -> 24 kHz (x1.5): 3 loud chunks + the quiet dip are all included
  assert.equal(Buffer.from(appended[0].audio, 'base64').length, (3200 * 3 + 1280) * 1.5);
  session.close();
});

test('committing a barge-in marks JARVIS as no longer speaking so the user is heard immediately', () => {
  const session = new RealtimeSession();
  session.ws = { send() {} };
  session.playProc = { kill() {} };
  session._flushPlayback = () => {};
  session.assistantSpeaking = true;
  session._realtimeResponseActive = true;
  session._beginDuck();
  session._commitBargeIn('accepted');
  assert.equal(session.assistantSpeaking, false);
  session.close();
});
