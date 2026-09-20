'use strict';

// Testlar jonli .env sozlamalariga bog'liq bo'lmasin.
process.env.REALTIME_BARGE_IN_CONFIRM_MS = '420';
process.env.REALTIME_VAD_SILENCE_MS = '180';
process.env.REALTIME_NORMAL_DUPLEX_HANGOVER_MS = '330';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const {
  RealtimeSession, needsGroundedAnswer, needsContextGrounding,
  needsExpertAnswer, needsBackgroundAgentTask, collectGrounding, matchDirectFastAction, buildSessionUpdate,
  loadInstructions, runFullAgent
} = require('../skills/realtime-voice');

test('voice instructions default to English, permit explicit translation, and require real task execution', () => {
  const instructions = loadInstructions();
  assert.match(instructions, /English is the default response language/i);
  assert.match(instructions, /explicit request to translate into a named language/i);
  assert.match(instructions, /Do not automatically switch to Uzbek, Russian, or any other language/i);
  assert.doesNotMatch(instructions, /Reply naturally in that same language/i);
  assert.match(instructions, /Talk like an attentive, capable person/i);
  assert.match(instructions, /Start speaking the first useful answer as soon as it is ready/i);
  assert.match(instructions, /ACTION FIRST/i);
  assert.match(instructions, /call the tool instead of merely explaining/i);
  assert.match(instructions, /never claim success until the tool returns a successful result/i);
  assert.match(instructions, /confirmation requirements/i);
  assert.match(instructions, /without requiring the user to say Jarvis again/i);
  assert.match(instructions, /preserve context/i);
  assert.match(instructions, /what is that\?/i);
  assert.match(instructions, /call see_screen silently before answering/i);
  assert.match(instructions, /never guess an object from background audio/i);
  assert.doesNotMatch(instructions, /cinematic machine-intelligence persona/i);
});

test('an acknowledgement after an assistant reply remains a realtime turn', () => {
  const session = new RealtimeSession();
  const sent = [];
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};
  session._rememberConversationTurn('Jarvis', 'Deploy tugadi. Davom etaymi?');

  assert.equal(session._acceptTranscript('Ha'), true);
  const response = sent.find(message => message.type === 'response.create');
  assert.ok(response);
  assert.match(response.response.instructions, /natural English by default/i);
  assert.match(response.response.instructions, /only when the user explicitly requested that named language/i);
});

test('transcript gate keeps generic conversation and reasoning on the low-latency Realtime route', async () => {
  const questions = [];
  const spoken = [];
  const session = new RealtimeSession({
    fastActionRunner: async id => ({ status: 'ok', message: id === 'info:time' ? 'It is 23:09.' : 'Done.' }),
    expertAnswer: async question => { questions.push(question); return 'Expert answer.'; },
    speakText: async text => { spoken.push(text); }
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
    transcript: "Agent B is first. Let's look for Agent B."
  }) });
  assert.equal(sent.some(message => message.type === 'response.create'), false);

  session._onMessage({ data: JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'What time is it?'
  }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.filter(message => message.type === 'response.create').length, 0);

  session._onMessage({ data: JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'How are you today?'
  }) });
  await new Promise(resolve => setImmediate(resolve));
  const realtimeResponses = sent.filter(message => message.type === 'response.create');
  assert.equal(realtimeResponses.length, 1);
  assert.equal(realtimeResponses[0].response.tool_choice, 'auto');
  assert.match(realtimeResponses[0].response.instructions, /latest turn/i);
  assert.match(realtimeResponses[0].response.instructions, /natural English by default/i);
  assert.match(realtimeResponses[0].response.instructions, /never cut a sentence short/i);
  assert.equal(questions.length, 0);
  assert.equal(spoken[0], 'It is 23:09.');

  session._onMessage({ data: JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'Analyze why this architecture is better and explain the tradeoffs.'
  }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(questions.length, 0);
  assert.equal(sent.filter(message => message.type === 'response.create').length, 2);
});

test('contextual questions start a realtime reply while grounding and expert work run in parallel', async () => {
  let releaseGrounding;
  let expertCalls = 0;
  const session = new RealtimeSession({
    groundingProvider: () => new Promise(resolve => { releaseGrounding = resolve; }),
    expertAnswer: async () => { expertCalls++; return 'Verified project status.'; }
  });
  const sent = [];
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};

  session._acceptTranscript('What was the status of that project?');
  await new Promise(resolve => setImmediate(resolve));

  const response = sent.find(message => message.type === 'response.create');
  assert.ok(response);
  assert.equal(response.response.tool_choice, 'auto');
  assert.equal(expertCalls, 0);

  releaseGrounding('Project context.');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(expertCalls, 1);
  assert.equal(sent.filter(message => message.type === 'response.create').length, 1);

  session._onMessage({ data: JSON.stringify({ type: 'response.created', response: { id: 'live-1' } }) });
  session._onMessage({ data: JSON.stringify({ type: 'response.done', response: { status: 'completed' } }) });
  await new Promise(resolve => setImmediate(resolve));

  const followUp = sent.filter(message => message.type === 'response.create').at(-1);
  assert.match(followUp.response.instructions, /Verified project status/);
});

test('explicit complex action starts a background agent while realtime immediately acknowledges it', async () => {
  let releaseTask;
  const calls = [];
  const session = new RealtimeSession({
    backgroundAgentRunner: (description, sessionKey, onProgress) => {
      calls.push({ description, sessionKey });
      onProgress('1/2 step in progress');
      return new Promise(resolve => { releaseTask = resolve; });
    }
  });
  const sent = [];
  const events = [];
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};
  session.on('tool_call', (description, callId) => events.push(['start', description, callId]));
  session.on('tool_result', (result, callId) => events.push(['done', result, callId]));

  assert.equal(needsBackgroundAgentTask('Fix the project build error and run the tests'), true);
  assert.equal(needsBackgroundAgentTask('How do I fix the project build error?'), false);
  session._acceptTranscript('Fix the project build error and run the tests');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.filter(message => message.type === 'response.create').length, 1);
  assert.equal(sent[0].response.tool_choice, 'none');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sessionKey, /^agent:main:voice-background-/);
  assert.equal(events[0][0], 'start');

  releaseTask('Build fixed and tests passed.');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-1)[0], 'done');
  assert.equal(sent.filter(message => message.type === 'response.create').length, 1);

  session._onMessage({ data: JSON.stringify({ type: 'response.done', response: { status: 'completed' } }) });
  await new Promise(resolve => setImmediate(resolve));
  const followUp = sent.filter(message => message.type === 'response.create').at(-1);
  assert.match(followUp.response.instructions, /Build fixed and tests passed/);
});

test('YouTube search is a direct realtime route and never invokes deep-think', async () => {
  const communicationIntents = [];
  const expertQuestions = [];
  const spoken = [];
  const session = new RealtimeSession({
    communicationRunner: async intent => {
      communicationIntents.push(intent);
      return { status: 'ok', message: 'YouTube qidiruvi ochildi.' };
    },
    expertAnswer: async question => { expertQuestions.push(question); return 'Expert answer.'; },
    speakText: async text => { spoken.push(text); }
  });
  session.ws = { send: () => {} };
  session._flushPlayback = () => {};

  assert.equal(session._acceptTranscript('YouTube da lofi hip hop qidir'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(communicationIntents, [{ kind: 'youtube-search', query: 'lofi hip hop' }]);
  assert.deepEqual(expertQuestions, []);
  assert.deepEqual(spoken, ['YouTube qidiruvi ochildi.']);
});

test('realtime response emits provider, first-content, and playback timing milestones once per turn', () => {
  const session = new RealtimeSession();
  const sent = [];
  const telemetry = [];
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session.on('telemetry', (type, data) => telemetry.push({ type, data }));

  session._acceptTranscript('How are you today?');
  session._onMessage({ data: JSON.stringify({ type: 'response.created', response: { id: 'response-1' } }) });
  session._onMessage({ data: JSON.stringify({ type: 'response.audio_transcript.delta', delta: 'Doing' }) });
  session._onMessage({ data: JSON.stringify({ type: 'response.audio_transcript.delta', delta: ' well.' }) });
  session._playChunk = () => {};
  session._onMessage({ data: JSON.stringify({ type: 'response.audio.delta', delta: Buffer.from('one').toString('base64') }) });
  session._onMessage({ data: JSON.stringify({ type: 'response.audio.delta', delta: Buffer.from('two').toString('base64') }) });
  session.playProc = { stdin: { writable: true, write: () => true } };
  session.duplex.queuePlayback = () => {};
  session._writePlayback(Buffer.alloc(480));
  session._writePlayback(Buffer.alloc(480));

  assert.equal(sent.filter(message => message.type === 'response.create').length, 1);
  for (const type of [
    'provider.request.sent', 'provider.response.created', 'assistant.text.first',
    'assistant.audio.first', 'playback.started'
  ]) {
    assert.equal(telemetry.filter(event => event.type === type).length, 1, type);
  }
  assert.equal(telemetry.find(event => event.type === 'provider.response.created').data.responseId, 'response-1');
});

test('session becomes ready only after provider acknowledges session.update', () => {
  const session = new RealtimeSession();
  let ready = 0;
  let provider = '';
  session.provider = { id: 'voice-live' };
  session.on('ready', () => ready++);
  session.on('provider', event => { provider = event.id; });

  assert.equal(session.ready, false);
  session._onMessage({ data: JSON.stringify({ type: 'session.updated' }) });
  session._onMessage({ data: JSON.stringify({ type: 'session.updated' }) });

  assert.equal(session.ready, true);
  assert.equal(ready, 1);
  assert.equal(provider, 'voice-live');
});

test('GA v1 output audio and transcript events use the existing playback pipeline', () => {
  const session = new RealtimeSession();
  const played = [];
  session._playChunk = chunk => played.push(Buffer.from(chunk));

  session._onMessage({ data: JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Hello.' }) });
  session._onMessage({ data: JSON.stringify({ type: 'response.output_audio.delta', delta: Buffer.from('pcm').toString('base64') }) });

  assert.equal(session.assistantTranscript, 'Hello.');
  assert.equal(session.assistantSpeaking, true);
  assert.deepEqual(played, [Buffer.from('pcm')]);
});

test('confirmed server speech_started pauses playback; the accepted turn then cancels the response and flushes once', () => {
  const session = new RealtimeSession();
  const sent = [];
  const signals = [];
  let flushes = 0;
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session.playProc = { kill: signal => signals.push(signal) };
  session.assistantSpeaking = true;
  session._realtimeResponseActive = true;
  session._bargeInEvidenceAt = Date.now();
  session._flushPlayback = () => { flushes++; };

  session._onMessage({ data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });
  session._onMessage({ data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });

  assert.deepEqual(signals, ['SIGSTOP']);
  assert.equal(sent.some(message => message.type === 'response.cancel'), false);
  assert.equal(flushes, 0);

  session._commitBargeIn('accepted');
  assert.deepEqual(sent.filter(message => message.type === 'response.cancel'), [{ type: 'response.cancel' }]);
  assert.equal(flushes, 1);
  session.close();
});

test('server speech_started without local barge-in evidence preserves playback', () => {
  const session = new RealtimeSession();
  const sent = [];
  let flushes = 0;
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session.assistantSpeaking = true;
  session._bargeInEvidenceAt = 0;
  session._flushPlayback = () => { flushes++; };

  session._onMessage({ data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });

  assert.equal(sent.some(message => message.type === 'response.cancel'), false);
  assert.equal(flushes, 0);
});

test('Fn is a hands-free conversation trigger and release does not force VAD finalization', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'jarvis_daemon.js'), 'utf8');
  const realtimeSource = fs.readFileSync(path.join(__dirname, '..', 'skills', 'realtime-voice', 'index.js'), 'utf8');

  assert.match(daemonSource, /triggerVoice\('⌨️ Fn hands-free conversation'\)/);
  assert.match(daemonSource, /Fn qo'yib yuborilishi suhbat turnini yopmaydi/);
  assert.match(daemonSource, /restartFromFn = true/);
  assert.match(daemonSource, /Fn har doim yangi suhbatni boshlash tugmasi bo'lishi kerak/);
  assert.doesNotMatch(daemonSource, /finishPushToTalkTurn/);
  assert.doesNotMatch(realtimeSource, /finishPushToTalkTurn/);
});

test('daemon does not arm the idle timeout while provider VAD reports active speech', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'jarvis_daemon.js'), 'utf8');

  assert.match(daemonSource, /let userSpeaking = false/);
  assert.match(daemonSource, /if \(userSpeaking\) return;/);
  assert.match(daemonSource, /session\.on\('user_speaking', \(\) => \{\s*userSpeaking = true;/);
  assert.match(daemonSource, /session\.on\('user_speech_stopped', \(\) => \{\s*userSpeaking = false;/);
});

test('daemon recovers when provider VAD never emits speech_stopped', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'jarvis_daemon.js'), 'utf8');

  assert.match(daemonSource, /const REALTIME_MAX_USER_SPEECH_MS = Math\.max\(30000,/);
  assert.match(daemonSource, /let userSpeechStartedAt = 0;/);
  assert.match(daemonSource, /userSpeaking && Date\.now\(\) - userSpeechStartedAt >= REALTIME_MAX_USER_SPEECH_MS/);
  assert.match(daemonSource, /finishRealtimeSession\('VAD speech timeout'\)/);
});

test('direct Azure Realtime session payload uses the nested GA audio schema', () => {
  const event = buildSessionUpdate({ id: 'azure-realtime', voice: 'cedar' }, {
    startMediaAware: false,
    instructions: 'Test',
    tools: []
  });

  assert.equal(event.session.type, 'realtime');
  assert.deepEqual(event.session.output_modalities, ['audio']);
  assert.deepEqual(event.session.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(event.session.audio.input.turn_detection.silence_duration_ms, 180);
  assert.equal(event.session.audio.output.voice, 'cedar');
  assert.equal(event.session.modalities, undefined);
  assert.equal(event.session.input_audio_format, undefined);
});

test('media-aware sessions retain the conservative VAD silence window', () => {
  const event = buildSessionUpdate({ id: 'azure-realtime', voice: 'cedar' }, {
    startMediaAware: true,
    instructions: 'Test',
    tools: []
  });

  assert.equal(event.session.audio.input.turn_detection.silence_duration_ms, 750);
});

test('Fn hands-free session accepts media-background follow-up turns', async () => {
  const sent = [];
  const session = new RealtimeSession({
    explicitUserSession: true,
    speakText: async () => {}
  });
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};
  session._mediaModeActive = true;

  assert.equal(session._acceptTranscript('Hello there.'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session._acceptTranscript('I have a plan for you.'), true);
  assert.equal(sent.filter(message => message.type === 'response.create').length, 2);
});

test('confirmed wake lets only the first meaningful media-background turn through', async () => {
  const sent = [];
  const session = new RealtimeSession({
    explicitUserTrigger: true,
    addressedWakeTrigger: true,
    speakText: async () => {}
  });
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};
  session._mediaModeActive = true;

  assert.equal(session._acceptTranscript('Jarvis, hello how are you?'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session._explicitUserTurnPending, false);
  assert.equal(session._acceptTranscript('Passive background dialogue.'), false);
  assert.equal(sent.filter(message => message.type === 'response.create').length, 1);
});

test('addressed wake transcript strips the wake phrase and routes the inline command once', async () => {
  const sent = [];
  const accepted = [];
  const actions = [];
  const session = new RealtimeSession({
    addressedWakeTrigger: true,
    fastActionRunner: async id => { actions.push(id); return { status: 'ok', message: 'Safari opened' }; },
    speakText: async () => {}
  });
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};
  session.on('user_transcript', text => accepted.push(text));

  assert.equal(session._acceptTranscript('Jarvis, open Safari please'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(accepted, ['open safari please']);
  assert.deepEqual(actions, ['open:safari']);
  assert.equal(sent.filter(message => message.type === 'response.create').length, 0);
});

test('wake-only transcript is suppressed without persisting an empty user turn', () => {
  const session = new RealtimeSession({ addressedWakeTrigger: true });
  const suppressed = [];
  session.ws = { send() {} };
  session._flushPlayback = () => {};
  session.on('turn_suppressed', (reason) => suppressed.push(reason));
  assert.equal(session._acceptTranscript('Hey Jarvis'), false);
  assert.deepEqual(suppressed, ['wake-only']);
});

test('wake suffix preserves and accepts the command before Jarvis', async () => {
  const sent = [];
  const accepted = [];
  const session = new RealtimeSession({ addressedWakeTrigger: true });
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};
  session.on('user_transcript', text => accepted.push(text));

  assert.equal(session._acceptTranscript('What the heck, Jarvis?'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(accepted, ['what the heck']);
  assert.equal(sent.filter(message => message.type === 'response.create').length, 1);
});

test('duplex uses a low-latency normal hangover and retains a conservative media profile', () => {
  const session = new RealtimeSession();
  assert.equal(session.duplex.hangoverMs, 330);
  session.ws = { send() {} };
  session._setMediaLikelyPlaying();
  assert.ok(session.duplex.hangoverMs >= 900);
});

test('run_task starts the full agent with configured credentials instead of crashing', async () => {
  let invocation;
  const fakeSpawn = (command, args, options) => {
    invocation = { command, args, options };
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from('Task completed successfully.'));
      proc.emit('close', 0, null);
    });
    return proc;
  };

  const result = await runFullAgent('Open the requested song', 'agent:main:test-task', null, fakeSpawn);

  assert.equal(result, 'Task completed successfully.');
  assert.equal(invocation.command, 'openclaw');
  assert.deepEqual(invocation.args, [
    'agent', '--session-key', 'agent:main:test-task',
    '--message', '[Language policy: Reply only in natural English. Never answer in Uzbek or imitate an Uzbek accent.]\n\nOpen the requested song', '--agent', 'main'
  ]);
  assert.ok(Object.hasOwn(invocation.options.env, 'AZURE_OPENAI_KEY'));
  assert.equal(invocation.options.env.JARVIS_PROJECT_DIR.endsWith('OPEN_CREW_JARVIS'), true);
  assert.equal(invocation.options.timeout, 300000);
});

test('recall_memory tool returns hybrid memory results to the realtime conversation', async () => {
  const sent = [];
  const calls = [];
  const session = new RealtimeSession({
    memoryProvider: {
      recallMemory: async (query, limit) => {
        calls.push({ query, limit });
        return { status: 'ok', results: [{ source: 'recent-turns', title: 'Deploy task', content: 'Release completed successfully.' }] };
      }
    }
  });
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  await session._handleRecallMemory({ call_id: 'recall-1', arguments: JSON.stringify({ query: 'that deploy' }) });
  assert.deepEqual(calls, [{ query: 'that deploy', limit: 6 }]);
  const output = sent.find(message => message.type === 'conversation.item.create');
  assert.match(output.item.output, /Release completed successfully/);
  assert.equal(sent.at(-1).type, 'response.create');
});

test('optional external TTS failure falls back to realtime read-only playback', async () => {
  const session = new RealtimeSession({
    speakText: async () => { throw new Error('tts unavailable'); }
  });
  const sent = [];
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};

  await session._deliverSpokenAnswer('Prepared Astra answer.');

  const response = sent.find(message => message.type === 'response.create');
  assert.match(response.response.instructions, /Prepared Astra answer/);
  assert.match(response.response.instructions, /Add, remove, and rewrite nothing/);
});

test('high-impact tool is blocked until explicit one-shot confirmation', async () => {
  const actions = [];
  const spoken = [];
  const session = new RealtimeSession({
    fastActionRunner: async id => { actions.push(id); return { status: 'ok', message: 'Done.' }; },
    speakText: async text => { spoken.push(text); }
  });
  const sent = [];
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};
  const call = { name: 'fast_action', call_id: 'danger-1', arguments: JSON.stringify({ id: 'system:empty_trash' }) };

  await session._handleFunctionCall(call);
  assert.deepEqual(actions, []);
  assert.match(sent.find(message => message.item?.call_id === 'danger-1').item.output, /CONFIRMATION REQUIRED/);

  assert.equal(session._acceptTranscript('confirm'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actions, ['system:empty_trash']);
  assert.equal(spoken.includes('Cancelled.'), false);
});

test('confirmation state cannot leak across realtime sessions', async () => {
  const firstActions = [];
  const secondActions = [];
  const makeSession = actions => {
    const session = new RealtimeSession({
      fastActionRunner: async id => { actions.push(id); return { status: 'ok', message: 'Done.' }; },
      speakText: async () => {}
    });
    session.ws = { send() {} };
    session._flushPlayback = () => {};
    return session;
  };
  const first = makeSession(firstActions);
  const second = makeSession(secondActions);
  const dangerous = { name: 'fast_action', call_id: 'danger', arguments: JSON.stringify({ id: 'system:empty_trash' }) };

  await first._handleFunctionCall(dangerous);
  await second._handleFunctionCall({ ...dangerous, call_id: 'danger-2' });
  first._acceptTranscript('confirm');
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(firstActions, ['system:empty_trash']);
  assert.deepEqual(secondActions, []);

  second._acceptTranscript('confirm');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(secondActions, ['system:empty_trash']);
});

test('injectable authoritative recovery can replace a native transcript', async () => {
  const session = new RealtimeSession({
    authoritativeTranscribe: async pcm => {
      assert.ok(pcm.length > 0);
      return { text: 'Telegramni yop', confidence: 0.93 };
    },
    fastActionRunner: async () => ({ status: 'ok', message: 'Telegram yopildi' }),
    speakText: async () => {}
  });
  const sent = [];
  const transcripts = [];
  session.ready = true;
  session.assistantSpeaking = true;
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};
  session.duplex.process = audio => ({ send: true, audio, reason: 'barge-in', residualRms: 1000, correlation: 0 });
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
  assert.match(sent.find(message => message.type === 'response.create').response.instructions, /natural English by default/i);
});

test('wake recovery selects an Uzbek direct action over a wrong native transcript', async () => {
  const actions = [];
  const transcripts = [];
  const session = new RealtimeSession({
    authoritativeTranscribe: async () => ({ text: 'Chrome ni och', confidence: 0.94 }),
    fastActionRunner: async id => { actions.push(id); return { status: 'ok', message: 'Chrome ochildi' }; },
    speakText: async () => {}
  });
  session.ws = { send() {} };
  session._flushPlayback = () => {};
  session.on('user_transcript', text => transcripts.push(text));

  session._beginAuthoritativeTranscription({ chunks: [Buffer.alloc(6400, 2)] });
  session._pendingAuthoritativeTurn.native = { text: 'From Nodge.', itemId: 'wrong-native' };
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(transcripts, ['Chrome ni och']);
  assert.deepEqual(actions, ['open:chrome']);
});

test('wake first turn waits for authoritative STT despite a confident wrong native transcript', async () => {
  let finishAuthoritative;
  const accepted = [];
  const session = new RealtimeSession({
    requireAuthoritativeFirstTurn: true,
    authoritativeTranscribe: () => new Promise(resolve => { finishAuthoritative = resolve; })
  });
  session.ws = { send() {} };
  session._flushPlayback = () => {};
  session.on('user_transcript', text => accepted.push(text));

  session._beginAuthoritativeTranscription({ chunks: [Buffer.alloc(6400, 2)] });
  session._onMessage({ data: JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'wrong-native', transcript: 'open the telegram hey jarvis chrome notch'
  }) });
  assert.deepEqual(accepted, []);

  finishAuthoritative({ text: 'Chrome ni och', confidence: 0.94 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(accepted, ['Chrome ni och']);
});

test('short unambiguous local actions use native STT without waiting for Uzbek STT', async () => {
  let finishAuthoritative;
  const actions = [];
  const events = [];
  const session = new RealtimeSession({
    authoritativeTranscribe: () => new Promise(resolve => { finishAuthoritative = resolve; }),
    fastActionRunner: async id => { actions.push(id); return { status: 'ok', message: 'Bajarildi' }; },
    speakText: async () => {}
  });
  session.ws = { send: () => {} };
  session._flushPlayback = () => {};
  session.on('telemetry', (type, data) => events.push({ type, data }));

  session._beginAuthoritativeTranscription({ chunks: [Buffer.alloc(3200)] });
  session._pendingAuthoritativeTurn.native = { text: 'Safari och', itemId: 'native-fast-action' };
  session._onMessage({ data: JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'Safari och',
    item_id: 'native-fast-action'
  }) });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(actions, ['open:safari']);
  assert.equal(events.find(event => event.type === 'stt.native-fast-path')?.data.reason, 'direct-fast-action');
  assert.equal(session._pendingAuthoritativeTurn, null);

  finishAuthoritative({ text: 'Safari och', confidence: 0.95 });
  await new Promise(resolve => setImmediate(resolve));
});

test('native transcript recovers a turn when authoritative STT returns no match', async () => {
  const session = new RealtimeSession({ authoritativeTranscribe: async () => ({ text: '', confidence: 0 }) });
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
    authoritativeTranscribe: () => new Promise(resolve => { resolveAuthoritative = resolve; }),
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
    authoritativeTranscribe: async () => ({ text: 'Musiqani to\'xtat', confidence: 0.85 }),
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

test('contextual turns speak immediately and deliver grounded verification as a follow-up', async () => {
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
  assert.doesNotMatch(responses[0].response.instructions, /bozorli\.online/);
  assert.doesNotMatch(responses[0].response.instructions, /biroz kuting|natijasini kut/i);

  session._onMessage({ data: JSON.stringify({ type: 'response.done', response: { status: 'completed' } }) });
  await new Promise(resolve => setImmediate(resolve));
  const followUp = sent.filter(message => message.type === 'response.create').at(-1);
  assert.match(followUp.response.instructions, /bozorli\.online/);
});

test('grounding falls back to local Obsidian search when semantic search fails', async () => {
  const grounding = await collectGrounding('Oldingi topdim loyihasi qanday edi?', {
    memory: {
      semanticSearch: async () => ({ status: 'error', message: 'embedding unavailable' }),
      searchMemory: query => query === 'topdim' ? {
        status: 'ok',
        results: [{ file: '2026-09-01.md', date: '2026-09-01', matches: [{ text: 'Topdim loyihasi deploy qilindi.' }] }],
        structured: []
      } : { status: 'ok', results: [], structured: [] },
      readProfile: () => ''
    }
  });

  assert.match(grounding, /Qidiruv muvaffaqiyatli bajarildi/);
  assert.match(grounding, /Topdim loyihasi deploy qilindi/);
});

test('profile memory is included for questions about what Jarvis remembers', async () => {
  const grounding = await collectGrounding('Men haqimda nimalarni eslaysan?', {
    memory: {
      semanticSearch: async () => ({ status: 'empty', results: [] }),
      searchMemory: () => ({ status: 'ok', results: [], structured: [] }),
      readProfile: () => 'Foydalanuvchi o‘zbek tilida qisqa javoblarni yoqtiradi.'
    }
  });

  assert.match(grounding, /FOYDALANUVCHI PROFILI/);
  assert.match(grounding, /o‘zbek tilida qisqa javoblarni yoqtiradi/);
  assert.doesNotMatch(grounding, /mos yozuv topilmadi/);
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

test('generic reasoning skips grounding and streams through Realtime', async () => {
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
  assert.equal(calls.some(call => call[0] === 'expert'), false);
  const response = sent.find(message => message.type === 'response.create');
  assert.equal(response.response.tool_choice, 'auto');
  assert.match(response.response.instructions, /latest turn/i);
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
    },
    speakText: async text => { spoken.push(text); }
  });
  const spoken = [];
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};

  assert.equal(session._acceptTranscript('Telegramni och'), true);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(executed, ['open:telegram']);
  const responses = sent.filter(message => message.type === 'response.create');
  assert.equal(responses.length, 0);
  assert.deepEqual(spoken, ['Telegram ochildi']);
  assert.equal(sent.some(message => message.type === 'conversation.item.create' && message.item?.type === 'function_call_output'), false);
});

test('response completion exposes truncation reason and queued playback telemetry', () => {
  const session = new RealtimeSession();
  const events = [];
  const completed = [];
  session.on('telemetry', (type, data) => events.push({ type, data }));
  session.on('turn_done', data => completed.push(data));
  session.assistantSpeaking = true;
  session._playbackUntil = Date.now() + 250;

  session._onMessage({ data: JSON.stringify({
    type: 'response.done',
    response: { status: 'incomplete', status_details: { reason: 'max_output_tokens' } }
  }) });

  const responseDone = events.find(event => event.type === 'response.done');
  assert.equal(responseDone.data.status, 'incomplete');
  assert.equal(responseDone.data.reason, 'max_output_tokens');
  assert.ok(responseDone.data.audioQueuedUntilMs > 0);
  assert.deepEqual(completed, [{ status: 'incomplete', reason: 'max_output_tokens', interrupted: false }]);
});

test('response completion reports completed status explicitly', () => {
  const session = new RealtimeSession();
  const completed = [];
  session.on('turn_done', data => completed.push(data));

  session._onMessage({ data: JSON.stringify({
    type: 'response.done',
    response: { status: 'completed' }
  }) });

  assert.deepEqual(completed, [{ status: 'completed', reason: '', interrupted: false }]);
});

test('completed provider response remains marked interrupted after confirmed barge-in', () => {
  const session = new RealtimeSession();
  const completed = [];
  session.ws = { send() {} };
  session._flushPlayback = () => {};
  session.assistantSpeaking = true;
  session._bargeInEvidenceAt = Date.now();
  session.on('turn_done', data => completed.push(data));

  session._onMessage({ data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });
  session._commitBargeIn('accepted');
  session._onMessage({ data: JSON.stringify({
    type: 'response.done',
    response: { status: 'completed' }
  }) });

  assert.deepEqual(completed, [{ status: 'completed', reason: '', interrupted: true }]);
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
  session._realtimeResponseActive = true;
  session._onMessage({ data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });
  assert.equal(sent.some(message => message.type === 'response.cancel'), false);
  assert.ok(session._duck);

  session._commitBargeIn('accepted');
  assert.equal(sent.filter(message => message.type === 'response.cancel').length, 1);
  assert.equal(flushed, 1);
  session.close();
});

test('provider VAD acknowledgement does not cancel an already locally interrupted response twice', () => {
  const session = new RealtimeSession();
  const sent = [];
  let flushed = 0;
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => { flushed++; };
  session.assistantSpeaking = true;
  session._bargeInEvidenceAt = Date.now();
  session._responseInterrupted = true;

  session._onMessage({ data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });

  assert.equal(sent.some(message => message.type === 'response.cancel'), false);
  assert.equal(flushed, 0);
});

test('playback requires sustained local speech before forwarding barge-in audio', () => {
  const session = new RealtimeSession();
  const sent = [];
  session.ready = true;
  session.assistantSpeaking = true;
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._externalPlayProc = { kill() {} };
  let flushed = 0;
  session._flushPlayback = () => {
    flushed++;
    session._resetBargeInCandidate();
  };
  let processed = 0;
  session.duplex.process = audio => {
    processed++;
    return { send: true, audio, reason: 'barge-in', residualRms: 900, correlation: 0 };
  };

  const chunk = Buffer.alloc(3200, 1); // 100ms at 16kHz PCM16
  session.feedAudio(chunk);

  assert.equal(processed, 1);
  assert.equal(sent.some(message => message.type === 'input_audio_buffer.append'), false);
  assert.equal(session._bargeInEvidenceAt, 0);

  session.feedAudio(chunk);
  session.feedAudio(chunk);
  session.feedAudio(chunk);
  session.feedAudio(chunk);

  const appended = sent.filter(message => message.type === 'input_audio_buffer.append');
  assert.equal(processed, 5);
  assert.equal(appended.length, 1);
  assert.equal(Buffer.from(appended[0].audio, 'base64').length, 24000);
  // Barge-in tasdiqlanganda karnay pauza qilinadi; javob transkript tekshirilgunicha bekor qilinmaydi.
  assert.ok(session._duck);
  assert.equal(sent.filter(message => message.type === 'response.cancel').length, 0);
  assert.equal(flushed, 0);
  assert.ok(session._bargeInEvidenceAt > 0);
  session.close();
});

test('a playback-noise chunk resets an unconfirmed barge-in candidate', () => {
  const session = new RealtimeSession();
  const sent = [];
  session.ready = true;
  session.assistantSpeaking = true;
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  const results = ['barge-in', 'playback-noise', 'playback-noise', 'barge-in'];
  session.duplex.process = audio => {
    const reason = results.shift();
    return { send: reason === 'barge-in', audio, reason, residualRms: 900, correlation: 0 };
  };
  const chunk = Buffer.alloc(3200, 1); // 100ms; playback noise exceeds the 80ms gap allowance

  for (let i = 0; i < 4; i++) session.feedAudio(chunk);

  assert.equal(sent.some(message => message.type === 'input_audio_buffer.append'), false);
  assert.equal(session._bargeInEvidenceAt, 0);
});

test('a brief energy dip does not lose a natural barge-in onset', () => {
  const session = new RealtimeSession();
  const sent = [];
  session.ready = true;
  session.assistantSpeaking = true;
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => session._resetBargeInCandidate();
  const results = ['barge-in', 'playback-noise', 'barge-in', 'barge-in'];
  session.duplex.process = audio => {
    const reason = results.shift();
    return { send: reason === 'barge-in', audio, reason, residualRms: 900, correlation: 0 };
  };

  const speechChunk = Buffer.alloc(1920, 1); // 60ms at 16kHz PCM16
  const dipChunk = Buffer.alloc(1280, 1); // 40ms, below max gap
  session.feedAudio(speechChunk);
  session.feedAudio(dipChunk);
  session.feedAudio(Buffer.alloc(3840, 1)); // 120ms
  session.feedAudio(Buffer.alloc(7680, 1)); // 240ms; accumulated active speech reaches 420ms

  assert.ok(session._duck);
  assert.equal(sent.filter(message => message.type === 'input_audio_buffer.append').length, 1);
  assert.ok(session._bargeInEvidenceAt > 0);
  session.close();
});

test('external Azure TTS PCM is queued as playback reference', () => {
  const session = new RealtimeSession();
  const queued = [];
  session.playProc = { stdin: { writable: true, write: chunk => { queued.push(Buffer.from(chunk)); return true; } } };
  const pcm = Buffer.alloc(2400, 7);

  assert.equal(session._writePlayback(pcm), true);
  assert.equal(session.duplex.snapshot().referenceMs, 50);
  assert.deepEqual(queued, [pcm]);
});

test('a newer accepted turn invalidates an older grounded answer', async () => {
  let release;
  const session = new RealtimeSession({
    groundingProvider: () => new Promise(resolve => { release = resolve; }),
    expertAnswer: async () => 'Eski javob.',
    fastActionRunner: async () => ({ status: 'ok', message: 'Telegram ochildi' })
  });
  const sent = [];
  session.ws = { send: raw => sent.push(JSON.parse(raw)) };
  session._flushPlayback = () => {};

  session._acceptTranscript('Oldingi loyiha holati qanday?');
  await new Promise(resolve => setImmediate(resolve));
  session._acceptTranscript('Telegramni och');
  release('OBSIDIAN: eski loyiha');
  await new Promise(resolve => setImmediate(resolve));

  const responses = sent.filter(message => message.type === 'response.create');
  assert.equal(responses.length, 2);
  assert.match(responses.at(-1).response.instructions, /Telegram ochildi/);
  assert.doesNotMatch(responses.map(response => response.response.instructions).join('\n'), /Eski javob/);
});