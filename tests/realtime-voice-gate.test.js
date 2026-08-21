'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RealtimeSession, needsGroundedAnswer, needsContextGrounding,
  needsExpertAnswer, matchDirectFastAction
} = require('../skills/realtime-voice');

test('transcript gate creates a response only for accepted user turns', async () => {
  const session = new RealtimeSession({
    fastActionRunner: async id => ({ status: 'ok', message: id === 'info:time' ? '23:09' : 'Bajarildi' })
  });
  const sent = [];
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};
  session._mediaModeActive = true;

  session._onMessage({ data: JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'Thanks for watching, see you next time.'
  }) });
  assert.equal(sent.some(message => message.type === 'response.create'), false);

  session._onMessage({ data: JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'Jarvis, soat nechchi?'
  }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.filter(message => message.type === 'response.create').length, 1);

  session._onMessage({ data: JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'Could you open Chrome, please?'
  }) });
  assert.equal(sent.filter(message => message.type === 'response.create').length, 2);
});

test('authoritative Uzbek STT replaces unsupported Realtime auto-detection', async () => {
  const session = new RealtimeSession({
    transcribeUzbek: async pcm => {
      assert.ok(pcm.length > 0);
      return { text: 'Telegramni yop', confidence: 0.93 };
    }
  });
  const sent = [];
  const transcripts = [];
  session.ready = true;
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};
  session.duplex.process = audio => ({ send: true, audio, reason: 'voice', residualRms: 1000, correlation: 0 });
  session.on('user_transcript', text => transcripts.push(text));

  session.feedAudio(Buffer.alloc(3200, 1));
  session._onMessage({ data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });
  session.feedAudio(Buffer.alloc(6400, 2));
  session._onMessage({ data: JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }) });
  session._onMessage({ data: JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'bad-audio-item',
    transcript: "Telegram'ını yap."
  }) });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(transcripts, ['Telegramni yop']);
  assert.ok(sent.some(message => message.type === 'conversation.item.delete' && message.item_id === 'bad-audio-item'));
  assert.ok(sent.some(message => message.type === 'conversation.item.create' && message.item.content[0].text === 'Telegramni yop'));
  assert.equal(sent.filter(message => message.type === 'response.create').length, 1);
});

test('native transcript recovers a turn when authoritative Uzbek STT returns no match', async () => {
  const session = new RealtimeSession({ transcribeUzbek: async () => ({ text: '', confidence: 0 }) });
  session.ws = { send: () => {} };
  session._flushPlayback = () => {};
  const accepted = [];
  session.on('user_transcript', text => accepted.push(text));
  session._beginAuthoritativeTranscription({ chunks: [Buffer.alloc(3200)] });
  session._pendingAuthoritativeTurn.native = { text: 'Safari och', itemId: 'native-2' };
  session._finalizeAuthoritativeTurn();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(accepted, ['Safari och']);
});

test('a confident native transcript responds without waiting for authoritative STT', async () => {
  let resolveAuthoritative;
  const session = new RealtimeSession({
    transcribeUzbek: () => new Promise(resolve => { resolveAuthoritative = resolve; }),
    fastActionRunner: async () => ({ status: 'ok', message: 'Bajarildi' })
  });
  session.ready = true;
  session.ws = { send: () => {} };
  session._flushPlayback = () => {};
  const accepted = [];
  const telemetry = [];
  session.on('user_transcript', text => accepted.push(text));
  session.on('telemetry', (type, data) => telemetry.push(type));

  session._beginAuthoritativeTranscription({ chunks: [Buffer.alloc(3200)] });
  session._onMessage({ data: JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'native-fast', transcript: "Xo'p, Chrome dasturini och"
  }) });

  // Authoritative Azure STT hali javob bermagan (Promise pending) --
  // shunga qaramay, native ishonchli bo'lgani uchun darhol qabul qilingan.
  assert.deepEqual(accepted, ["Xo'p, Chrome dasturini och"]);
  assert.equal(session._pendingAuthoritativeTurn, null);
  assert.ok(telemetry.includes('stt.native-fast-path'));

  // Authoritative kech kelsa ham -- ikkinchi/dublikat javob YARATILMAYDI.
  resolveAuthoritative({ text: 'boshqacha eshitilgan matn', confidence: 0.4 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(accepted, ["Xo'p, Chrome dasturini och"]);
  assert.ok(telemetry.includes('stt.authoritative.completed'));
});

test('a short or ambiguous native transcript still waits for authoritative STT', async () => {
  const session = new RealtimeSession({
    transcribeUzbek: async () => ({ text: 'Musiqani to\'xtat', confidence: 0.85 }),
    // "Musiqani to'xtat" bir vaqtning o'zida matchDirectFastAction
    // (media:spotify_stop) bilan mos keladi -- fastActionRunner
    // mock qilinmasa bu HAQIQIY AppleScript chaqiruvini ishga tushiradi.
    fastActionRunner: async () => ({ status: 'ok', message: 'Bajarildi' })
  });
  session.ready = true;
  session.ws = { send: () => {} };
  session._flushPlayback = () => {};
  const accepted = [];
  session.on('user_transcript', text => accepted.push(text));

  session._beginAuthoritativeTranscription({ chunks: [Buffer.alloc(3200)] });
  session._onMessage({ data: JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'native-short', transcript: 'Musiqani toxtat'
  }) });

  // Native 2 token -- fast-path chegarasidan past, hali qaror qilinmagan.
  assert.deepEqual(accepted, []);
  assert.notEqual(session._pendingAuthoritativeTurn, null);

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(accepted, ["Musiqani to'xtat"]);
});

test('contextual turns are grounded with screen and Obsidian before Realtime speaks', async () => {
  const calls = [];
  const session = new RealtimeSession({
    groundingProvider: async query => {
      calls.push(['grounding', query]);
      return 'EKRAN: Claude ichida bozorli.online loyihasi.\nOBSIDIAN: deploy bajarilgan.';
    },
    expertAnswer: async (question, callId, grounding) => {
      calls.push(['expert', question, grounding]);
      return 'Siz hozir bozorli.online loyihasining deploy holatini tekshiryapsiz.';
    }
  });
  const sent = [];
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};

  session._acceptTranscript('Men hozir qaysi loyiha ustida ishlayapman?');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls[0][0], 'grounding');
  assert.equal(calls[1][0], 'expert');
  assert.match(calls[1][2], /OBSIDIAN/);
  const responses = sent.filter(message => message.type === 'response.create');
  assert.equal(responses.length, 1);
  assert.match(responses[0].response.instructions, /bozorli\.online/);
  assert.doesNotMatch(responses[0].response.instructions, /biroz kuting|natijasini kut/i);
});

test('fast desktop actions do not enter the slower grounding path', () => {
  assert.equal(needsGroundedAnswer('Telegramni yop'), false);
  assert.equal(needsGroundedAnswer('Ekranda hozir nima bor?'), true);
  assert.equal(needsGroundedAnswer('Oldingi loyiha nega ishlamay qolgan?'), true);
  assert.equal(needsGroundedAnswer('Bugun shu ishlarni tugatishga ulguramanmi?'), true);
  assert.equal(needsContextGrounding('Nega Node event loop bloklanadi?'), false);
  assert.equal(needsExpertAnswer('Nega Node event loop bloklanadi?'), true);
  assert.equal(needsContextGrounding('Oldingi loyiha nega ishlamay qolgan?'), true);
});

test('generic reasoning skips grounding and carries recent conversation to expert', async () => {
  const calls = [];
  const session = new RealtimeSession({
    groundingProvider: async () => {
      calls.push(['grounding']);
      return 'keraksiz';
    },
    expertAnswer: async (question, callId, grounding) => {
      calls.push(['expert', question, grounding]);
      return 'Event loop sinxron ish bilan band bo‘lsa bloklanadi.';
    }
  });
  const sent = [];
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};
  session._rememberConversationTurn('Jarvis', 'Node.js haqida gaplashyapmiz.');

  session._acceptTranscript('Nega event loop bloklanadi?');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls.some(call => call[0] === 'grounding'), false);
  assert.equal(calls[0][0], 'expert');
  assert.match(calls[0][1], /Node\.js haqida gaplashyapmiz/);
  assert.match(calls[0][1], /Hozirgi savol: Nega event loop bloklanadi/);
  assert.equal(calls[0][2], '');
  const response = sent.find(message => message.type === 'response.create');
  assert.match(response.response.instructions, /Event loop/);
});

test('safe common voice commands map to deterministic fast actions', () => {
  assert.equal(matchDirectFastAction('Jarvis, Telegramni och'), 'open:telegram');
  assert.equal(matchDirectFastAction('Iltimos Chrome och'), 'open:chrome');
  assert.equal(matchDirectFastAction('ovozni balandlat'), 'volume:up');
  assert.equal(matchDirectFastAction('soat nechchi?'), 'info:time');
  assert.equal(matchDirectFastAction('skrinshot ol'), 'screenshot:full');
  assert.equal(matchDirectFastAction('Telegramni yop'), null);
  assert.equal(matchDirectFastAction('Chrome ochib email yubor'), null);
});

test('accepted direct command executes without waiting for model tool selection', async () => {
  const executed = [];
  const sent = [];
  const session = new RealtimeSession({
    fastActionRunner: async id => {
      executed.push(id);
      return { status: 'ok', message: 'Telegram ochildi' };
    }
  });
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};

  assert.equal(session._acceptTranscript('Telegramni och'), true);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(executed, ['open:telegram']);
  const responses = sent.filter(message => message.type === 'response.create');
  assert.equal(responses.length, 1);
  assert.match(responses[0].response.instructions, /allaqachon bajarildi/i);
  // Realtime audio tokenlari tez sarflanadi; 40 token "Hozir soat 20:20"
  // jumlasini ham o'rtasida kesgan edi.
  assert.ok(responses[0].response.max_output_tokens >= 256);
  assert.equal(sent.some(message => message.type === 'conversation.item.create' && message.item?.type === 'function_call_output'), false);
});

test('response completion exposes truncation reason and queued playback telemetry', () => {
  const session = new RealtimeSession();
  const events = [];
  session.on('telemetry', (type, data) => events.push({ type, data }));
  session.assistantSpeaking = true;
  session._playbackUntil = Date.now() + 250;

  session._onMessage({ data: JSON.stringify({
    type: 'response.done',
    response: { status: 'incomplete', status_details: { reason: 'max_output_tokens' } }
  }) });

  const completed = events.find(event => event.type === 'response.done');
  assert.equal(completed.data.status, 'incomplete');
  assert.equal(completed.data.reason, 'max_output_tokens');
  assert.ok(completed.data.audioQueuedUntilMs > 0);
});

test('server VAD cannot cancel playback without locally confirmed barge-in', () => {
  const session = new RealtimeSession();
  const sent = [];
  let flushed = 0;
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => { flushed++; };
  session.assistantSpeaking = true;

  session._onMessage({ data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });

  assert.equal(sent.some(message => message.type === 'response.cancel'), false);
  assert.equal(flushed, 0);

  session._bargeInEvidenceAt = Date.now();
  session._onMessage({ data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });

  assert.equal(sent.filter(message => message.type === 'response.cancel').length, 1);
  assert.equal(flushed, 1);
});

test('a newer accepted turn invalidates an older grounded answer', async () => {
  let release;
  const session = new RealtimeSession({
    groundingProvider: () => new Promise(resolve => { release = resolve; }),
    expertAnswer: async () => 'Eski javob.'
  });
  const sent = [];
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};

  session._acceptTranscript('Oldingi loyiha holati qanday?');
  session._acceptTranscript('Telegramni yop');
  release('OBSIDIAN: eski loyiha');
  await new Promise(resolve => setImmediate(resolve));

  const responses = sent.filter(message => message.type === 'response.create');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].response, undefined);
});