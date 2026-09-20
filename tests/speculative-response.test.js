'use strict';

const test = require('node:test');
const { afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { RealtimeSession, buildSessionUpdate } = require('../skills/realtime-voice');

const open = [];
afterEach(() => { for (const s of open.splice(0)) { try { s.close(); } catch (_) {} } });

function liveSession() {
  const session = new RealtimeSession({ explicitUserSession: true });
  const sent = [];
  const played = [];
  session.ws = { send: raw => sent.push(JSON.parse(raw)), close() {} };
  session.provider = { id: 'voice-live' };
  session._flushPlayback = () => {};
  session._playChunk = buf => played.push(buf.toString());
  session._startBackgroundGrounding = () => {};
  session._expertAnswer = async () => '';
  session.ready = true;
  open.push(session);
  return { session, sent, played };
}
const msg = (session, event) => session._onMessage({ data: JSON.stringify(event) });
const audio = text => ({ type: 'response.audio.delta', delta: Buffer.from(text).toString('base64') });

test('speculative mode makes Voice Live create the response at end of speech', () => {
  const provider = { id: 'voice-live', voice: { type: 'azure-standard', name: 'n' } };
  const on = buildSessionUpdate(provider, { instructions: 'base', tools: [], speculative: true }).session;
  assert.equal(on.turn_detection.create_response, true);
  assert.match(on.instructions, /^base\n\n/);
  const media = buildSessionUpdate(provider, { instructions: 'base', tools: [], speculative: true, startMediaAware: true }).session;
  assert.equal(media.turn_detection.create_response, false);
  const fallback = buildSessionUpdate({ id: 'azure-realtime', voice: 'shimmer' }, { instructions: 'base', tools: [], speculative: true }).session;
  assert.equal(fallback.audio.input.turn_detection.create_response, false);
});

test('accepted turn plays held audio and sends no second response.create', () => {
  const { session, sent, played } = liveSession();
  msg(session, { type: 'input_audio_buffer.speech_stopped' });
  msg(session, { type: 'response.created', response: { id: 'r1' } });
  msg(session, audio('hello'));
  assert.deepEqual(played, []);
  msg(session, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'What is the capital of France?' });
  assert.deepEqual(played, ['hello']);
  msg(session, audio(' world'));
  assert.deepEqual(played, ['hello', ' world']);
  assert.equal(sent.filter(m => m.type === 'response.create').length, 0);
});

test('accepted transcript before the response exists still avoids a duplicate response', () => {
  const { session, sent, played } = liveSession();
  msg(session, { type: 'input_audio_buffer.speech_stopped' });
  msg(session, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'What is the capital of France?' });
  msg(session, { type: 'response.created', response: { id: 'r1' } });
  msg(session, audio('bonjour'));
  assert.deepEqual(played, ['bonjour']);
  assert.equal(sent.filter(m => m.type === 'response.create').length, 0);
});

test('rejected turn cancels the response, drops held audio, and never runs held tool calls', () => {
  const { session, sent, played } = liveSession();
  const calls = [];
  session._handleFunctionCall = call => calls.push(call);
  msg(session, { type: 'input_audio_buffer.speech_stopped' });
  msg(session, { type: 'response.created', response: { id: 'r1' } });
  msg(session, audio('leak'));
  msg(session, { type: 'response.function_call_arguments.done', call_id: 'c1', name: 'run_task', arguments: '{}' });
  msg(session, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'uh' });
  assert.ok(sent.some(m => m.type === 'response.cancel'));
  msg(session, audio('more'));
  assert.deepEqual(played, []);
  assert.deepEqual(calls, []);
});

test('non-conversation route discards the speculative response and defers its own until it clears', () => {
  const { session, sent, played } = liveSession();
  session._runDirectFastAction = () => session._sendResponseCreate({ instructions: 'ack' });
  msg(session, { type: 'input_audio_buffer.speech_stopped' });
  msg(session, { type: 'response.created', response: { id: 'r1' } });
  msg(session, audio('spec'));
  msg(session, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'what time is it' });
  assert.deepEqual(played, []);
  assert.ok(sent.some(m => m.type === 'response.cancel'));
  assert.equal(sent.filter(m => m.type === 'response.create').length, 0);
  msg(session, { type: 'response.done', response: { status: 'cancelled' } });
  assert.equal(sent.filter(m => m.type === 'response.create').length, 1);
});

test('held tool calls run only after the turn is accepted', () => {
  const { session } = liveSession();
  const calls = [];
  session._handleFunctionCall = call => calls.push(call.name);
  msg(session, { type: 'input_audio_buffer.speech_stopped' });
  msg(session, { type: 'response.created', response: { id: 'r1' } });
  msg(session, { type: 'response.function_call_arguments.done', call_id: 'c1', name: 'see_screen', arguments: '{}' });
  assert.deepEqual(calls, []);
  msg(session, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Can you look at my screen please?' });
  assert.deepEqual(calls, ['see_screen']);
});

test('the fallback provider never uses speculative responses', () => {
  const { session, sent } = liveSession();
  session.provider = { id: 'azure-realtime' };
  msg(session, { type: 'input_audio_buffer.speech_stopped' });
  msg(session, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'What is the capital of France?' });
  assert.equal(sent.filter(m => m.type === 'response.create').length, 1);
});

test('gate-closed silence is fed to the server only while its VAD still thinks the user is speaking', () => {
  const { session, sent } = liveSession();
  const appends = () => sent.filter(m => m.type === 'input_audio_buffer.append');
  session._feedTrailingSilence(960);
  assert.equal(appends().length, 0);
  msg(session, { type: 'input_audio_buffer.speech_started' });
  session._feedTrailingSilence(960);
  assert.equal(appends().length, 1);
  assert.ok(Buffer.from(appends()[0].audio, 'base64').every(byte => byte === 0));
  msg(session, { type: 'input_audio_buffer.speech_stopped' });
  session._feedTrailingSilence(960);
  assert.equal(appends().length, 1);
});

test('a rejected echo/noise turn never cancels or flushes the reply that is currently being spoken', () => {
  const { session, sent } = liveSession();
  let flushed = 0;
  session._flushPlayback = () => { flushed++; };
  session.assistantSpeaking = true;
  session._realtimeResponseActive = true;
  msg(session, { type: 'input_audio_buffer.speech_stopped' });
  assert.equal(session._spec, null);
  msg(session, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'uh' });
  assert.equal(sent.some(m => m.type === 'response.cancel'), false);
  assert.equal(flushed, 0);
});

test('server auto-response is switched off while JARVIS speaks and back on when the reply is done', () => {
  const { session, sent } = liveSession();
  const updates = () => sent.filter(m => m.type === 'session.update').map(m => m.session.turn_detection.create_response);
  msg(session, { type: 'response.created', response: { id: 'own' } });
  msg(session, audio('hi'));
  assert.deepEqual(updates(), [false]);
  msg(session, audio(' there'));
  assert.deepEqual(updates(), [false]);
  msg(session, { type: 'response.done', response: { status: 'completed' } });
  assert.deepEqual(updates(), [false, true]);
});

test('late audio from a barge-in-cancelled response cannot re-enter the speaking state', () => {
  const { session, played } = liveSession();
  msg(session, { type: 'response.created', response: { id: 'r1' } });
  msg(session, audio('one'));
  assert.equal(session.assistantSpeaking, true);
  session._responseInterrupted = true;
  session._dropStaleAudio = true;
  msg(session, { type: 'response.done', response: { status: 'cancelled' } });
  assert.equal(session.assistantSpeaking, false);
  msg(session, audio('late'));
  assert.equal(session.assistantSpeaking, false);
  assert.deepEqual(played, ['one']);
  msg(session, { type: 'response.created', response: { id: 'r2' } });
  msg(session, audio('fresh'));
  assert.deepEqual(played, ['one', 'fresh']);
});

test('a stuck speaking flag with no audio flowing is reset so the gate can hear the user again', () => {
  const { session, sent } = liveSession();
  session.assistantSpeaking = true;
  session._autoResponseOn = false;
  session._playbackUntil = Date.now() - 5000;
  session._lastAudioQueuedAt = Date.now() - 6000;
  session.feedAudio(Buffer.alloc(640));
  assert.equal(session.assistantSpeaking, false);
  assert.ok(sent.some(m => m.type === 'session.update' && m.session.turn_detection.create_response === true));
});

function duckedSession() {
  const ctx = liveSession();
  ctx.signals = [];
  ctx.session.playProc = { kill: signal => ctx.signals.push(signal), stdin: { writable: true, write() { return true; } } };
  ctx.session.assistantSpeaking = true;
  ctx.session._realtimeResponseActive = true;
  ctx.session._lastAssistantTranscript = "Glad to hear it! If there's anything you'd like to chat about, just let me know.";
  return ctx;
}

test('a false barge-in caused by JARVIS echo resumes the reply instead of killing it', () => {
  const { session, sent, signals } = duckedSession();
  let flushed = 0;
  session._flushPlayback = () => { flushed++; };
  session._beginDuck();
  assert.deepEqual(signals, ['SIGSTOP']);
  msg(session, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Glad to hear it.' });
  assert.deepEqual(signals, ['SIGSTOP', 'SIGCONT']);
  assert.equal(session._duck, null);
  assert.equal(sent.some(m => m.type === 'response.cancel'), false);
  assert.equal(flushed, 0);
  assert.ok(session._noBargeInUntil > Date.now());
});

test('a real interruption cancels the paused reply and the new answer waits for the cancelled response to clear', () => {
  const { session, sent, signals } = duckedSession();
  let flushed = 0;
  session._flushPlayback = () => { flushed++; };
  session._beginDuck();
  msg(session, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Wait, what is the capital of Italy?' });
  assert.deepEqual(signals, ['SIGSTOP', 'SIGCONT']);
  assert.equal(sent.filter(m => m.type === 'response.cancel').length, 1);
  assert.equal(flushed, 1);
  assert.equal(sent.filter(m => m.type === 'response.create').length, 0);
  msg(session, { type: 'response.done', response: { status: 'cancelled' } });
  assert.equal(sent.filter(m => m.type === 'response.create').length, 1);
});

test('an unverified pause is committed after the verify timeout', () => {
  const { session, sent } = duckedSession();
  session._flushPlayback = () => {};
  session._beginDuck();
  session._commitBargeIn('timeout');
  assert.equal(session._duck, null);
  assert.equal(sent.filter(m => m.type === 'response.cancel').length, 1);
});

test('verify timeout resumes the reply when the server heard no ongoing speech, and commits when it did', () => {
  const quiet = duckedSession();
  quiet.session._flushPlayback = () => {};
  quiet.session._beginDuck();
  quiet.session._onDuckTimeout();
  assert.deepEqual(quiet.signals, ['SIGSTOP', 'SIGCONT']);
  assert.equal(quiet.sent.some(m => m.type === 'response.cancel'), false);

  const talking = duckedSession();
  talking.session._flushPlayback = () => {};
  talking.session._beginDuck();
  msg(talking.session, { type: 'input_audio_buffer.speech_started' });
  talking.session._onDuckTimeout();
  assert.equal(talking.sent.filter(m => m.type === 'response.cancel').length, 1);
});
