'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { GeminiLiveSocket, toGeminiSchema } = require('../core/gemini-live-adapter');
const { RealtimeSession } = require('../skills/realtime-voice');

const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeTransport() {
  const transport = new EventEmitter();
  transport.sent = [];
  transport.send = raw => transport.sent.push(JSON.parse(raw));
  transport.close = () => transport.emit('close', 1000, '');
  transport.server = msg => transport.emit('message', Buffer.from(JSON.stringify(msg)));
  return transport;
}

function connectedSocket() {
  const transport = fakeTransport();
  const socket = new GeminiLiveSocket({ apiKey: 'k', model: 'gemini-live-test', voice: 'Charon', createTransport: () => transport });
  const events = [];
  socket.addEventListener('message', ev => events.push(JSON.parse(ev.data)));
  transport.emit('open');
  socket.send(JSON.stringify({ type: 'session.update', session: { instructions: 'Be Jarvis.', tools: [], turn_detection: { silence_duration_ms: 180 } } }));
  transport.server({ setupComplete: {} });
  return { socket, transport, events };
}

const audioPart = text => ({ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(text).toString('base64') } });

test('gemini-live: tool schemas are converted to Gemini types', () => {
  const schema = toGeminiSchema({
    type: 'object',
    additionalProperties: false,
    properties: { id: { type: 'string', enum: ['a', 'b'] }, tags: { type: 'array', items: { type: 'string' } } },
    required: ['id']
  });
  assert.deepEqual(schema, {
    type: 'OBJECT',
    properties: { id: { type: 'STRING', enum: ['a', 'b'] }, tags: { type: 'ARRAY', items: { type: 'STRING' } } },
    required: ['id']
  });
});

test('gemini-live: first session.update becomes setup and setupComplete becomes session.updated', () => {
  const { transport, events } = connectedSocket();
  const setup = transport.sent[0].setup;
  assert.equal(setup.model, 'models/gemini-live-test');
  assert.equal(setup.realtimeInputConfig.activityHandling, 'NO_INTERRUPTION');
  assert.equal(setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 180);
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon');
  assert.deepEqual(events.map(e => e.type), ['session.updated']);
});

test('gemini-live: a spoken turn is reported like a speculative server-VAD response', () => {
  const { transport, events } = connectedSocket();
  transport.server({ serverContent: { inputTranscription: { text: 'What time ' } } });
  transport.server({ serverContent: { inputTranscription: { text: 'is it?' } } });
  transport.server({ serverContent: { modelTurn: { parts: [audioPart('pcm')] } } });
  transport.server({ serverContent: { outputTranscription: { text: 'It is noon.' } } });
  transport.server({ serverContent: { turnComplete: true } });

  assert.deepEqual(events.slice(1).map(e => e.type), [
    'input_audio_buffer.speech_started',
    'input_audio_buffer.speech_stopped',
    'response.created',
    'conversation.item.input_audio_transcription.completed',
    'response.output_audio.delta',
    'response.output_audio_transcript.delta',
    'response.done'
  ]);
  assert.equal(events.find(e => e.type.endsWith('transcription.completed')).transcript, 'What time is it?');
});

test('gemini-live: tool output and the follow-up instructions travel in one toolResponse', () => {
  const { socket, transport, events } = connectedSocket();
  transport.server({ toolCall: { functionCalls: [{ id: 'c1', name: 'see_screen', args: { detail: 'high' } }] } });
  const call = events.find(e => e.type === 'response.function_call_arguments.done');
  assert.deepEqual({ id: call.call_id, name: call.name, args: JSON.parse(call.arguments) }, { id: 'c1', name: 'see_screen', args: { detail: 'high' } });

  socket.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' } }));
  socket.send(JSON.stringify({ type: 'response.create', response: { instructions: 'Ask one confirmation question.' } }));
  const toolMessages = transport.sent.filter(m => m.toolResponse);
  assert.equal(toolMessages.length, 1);
  assert.deepEqual(toolMessages[0].toolResponse.functionResponses[0], {
    id: 'c1', name: 'see_screen', response: { ok: true, instruction: 'Ask one confirmation question.' }
  });
  assert.equal(transport.sent.filter(m => m.clientContent).length, 0);
});

test('gemini-live: prepared-answer instructions become a text turn', () => {
  const { socket, transport } = connectedSocket();
  socket.send(JSON.stringify({ type: 'response.create', response: { instructions: 'Read exactly: Done.' } }));
  assert.deepEqual(transport.sent.at(-1), {
    clientContent: { turns: [{ role: 'user', parts: [{ text: 'Read exactly: Done.' }] }], turnComplete: true }
  });
});

test('gemini-live: a bare response.create with nothing to answer still completes', async () => {
  const { socket, events } = connectedSocket();
  socket.send(JSON.stringify({ type: 'response.create' }));
  await tick();
  assert.equal(events.at(-1).type, 'response.done');
});

test('gemini-live: cancel drops the rest of the model turn', async () => {
  const { socket, transport, events } = connectedSocket();
  transport.server({ serverContent: { modelTurn: { parts: [audioPart('one')] } } });
  socket.send(JSON.stringify({ type: 'response.cancel' }));
  transport.server({ serverContent: { modelTurn: { parts: [audioPart('two')] } } });
  await tick();
  assert.equal(events.filter(e => e.type === 'response.output_audio.delta').length, 1);
  assert.equal(events.at(-1).response.status, 'cancelled');
});

test('gemini-live: a rejected setup surfaces as an error so the skill can fall back', () => {
  const transport = fakeTransport();
  const socket = new GeminiLiveSocket({ apiKey: 'k', model: 'm', voice: 'v', createTransport: () => transport });
  const errors = [];
  const closes = [];
  socket.addEventListener('error', ev => errors.push(ev.message));
  socket.addEventListener('close', () => closes.push(true));
  transport.emit('open');
  transport.emit('close', 1008, 'models/m is not found');
  assert.match(errors[0], /before setup completed \(1008: models\/m is not found\)/);
  assert.deepEqual(closes, []);
});

// ── Integration with the real RealtimeSession: the skill's filters still decide. ──

function geminiSession() {
  const { socket, transport } = connectedSocket();
  const session = new RealtimeSession({ explicitUserSession: true });
  const played = [];
  session.ws = socket;
  session.provider = { id: 'gemini-live', autoResponds: true };
  session._flushPlayback = () => {};
  session._playChunk = buf => played.push(buf.toString());
  session._startBackgroundGrounding = () => {};
  session._expertAnswer = async () => '';
  session.ready = true;
  socket.addEventListener('message', ev => session._onMessage(ev));
  return { session, transport, played };
}

test('gemini-live + session: an accepted question plays the native answer immediately', () => {
  const { session, transport, played } = geminiSession();
  transport.server({ serverContent: { inputTranscription: { text: 'What is the capital of France?' } } });
  transport.server({ serverContent: { modelTurn: { parts: [audioPart('Paris.')] } } });
  assert.deepEqual(played, ['Paris.']);
  session.close();
});

test('gemini-live + session: a noise turn is vetoed, so neither audio nor tools leak', async () => {
  const { session, transport, played } = geminiSession();
  const calls = [];
  session._handleFunctionCall = call => calls.push(call.name);
  transport.server({ serverContent: { inputTranscription: { text: 'uh' } } });
  transport.server({ serverContent: { modelTurn: { parts: [audioPart('leak')] } } });
  transport.server({ toolCall: { functionCalls: [{ id: 'c9', name: 'run_task', args: {} }] } });
  transport.server({ serverContent: { modelTurn: { parts: [audioPart('more leak')] } } });
  await tick();
  assert.deepEqual(played, []);
  assert.deepEqual(calls, []);
  session.close();
});
