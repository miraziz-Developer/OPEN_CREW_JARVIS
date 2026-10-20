#!/usr/bin/env node
/**
 * REALTIME VOICE — multilingual low-latency voice pipeline.
 *
 * Gemini Live (primary, native audio) or Azure Voice Live / Realtime (fallback)
 * handle STT, VAD, conversation and speech directly.
 * Complex/grounded questions use the tiered Grok/GPT-5.6 Sol reasoning path and are spoken by
 * the same Realtime session, avoiding a second STT/TTS provider round-trip.
 *
 * Complex multi-step tasks (browser, files, screen) are handed to the full
 * agent (gpt-6-astra with every skill) through the `run_task` function, so no
 * capability is lost while ordinary conversation becomes much faster.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const EventEmitter = require('events');
const WebSocketClient = require('ws');
const { DuplexVoiceEngine, rms } = require('../../core/duplex-voice-engine');
const { personaInstructions } = require('../../core/persona');
const { PcmPlaybackBuffer } = require('../../core/pcm-playback-buffer');
const { classifyUserTurn, isRepeatedResponse, isStopIntent } = require('../../core/voice-turn-policy');
const { chooseTranscript, authoritativeTimeoutMs, nativeIsConfident } = require('../../core/stt-recovery');
const { loadCalibration, resolveCalibratedNumber, resolveBargeInResidual } = require('../../core/audio-calibration');
const { ConversationContext } = require('../../core/conversation-context');
const { ActionSafetyPolicy } = require('../../core/action-safety-policy');
const { recordHighRiskCompletion } = require('../../core/autonomous-action-audit');
const { buildVoiceProviders } = require('../../core/voice-provider');
const { createAgentBridge, needsPersistentExecution } = require('../../core/agent-bridge');
const { verifyActionResult, actionResultText } = require('../../core/action-result');
const { ActionFailureCorpus, sanitizeVerifierFailure } = require('../../core/action-failure-corpus');
const { createSkillPlatform } = require('../platform');

const { PROJECT_DIR } = require('../../core/paths');
const { fastThinkingArgs, agentPolicyPreamble } = require('../../core/agent-bridge');
const { sharedUndo, fileOps, captureSetting } = require('../../core/undo');
const { ambientBlock } = require('../../core/ambient-context');
const execFileAsync = promisify(execFile);
let ENV = '';
try { ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
function env(k, def) {
  if (process.env[k] !== undefined) return process.env[k];
  const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : def;
}
const ENV_VALUES = Object.fromEntries(ENV.split(/\r?\n/).map(line => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)).filter(Boolean).map(match => [match[1], match[2].trim()]));
const AUDIO_CALIBRATION = loadCalibration(path.join(PROJECT_DIR, '.run', 'audio-calibration.json'));

const VOICE_PROVIDERS = buildVoiceProviders(env);
const OPENCLAW_AGENT_TIMEOUT_MS = Math.max(30000, parseInt(env('OPENCLAW_AGENT_TIMEOUT_MS'), 10) || 300000);
const AGENT_LONG_TASK_NOTICE_MS = Math.min(
  OPENCLAW_AGENT_TIMEOUT_MS - 10000,
  Math.max(10000, parseInt(env('AGENT_LONG_TASK_NOTICE_MS'), 10) || OPENCLAW_AGENT_TIMEOUT_MS - 30000)
);
const VOICE_AGENT_HANDOFF_MS = Math.max(30000, parseInt(env('VOICE_AGENT_HANDOFF_MS'), 10) || 60000);
const VOICE_AGENT_BRIDGE = createAgentBridge({ projectDir: PROJECT_DIR, env, azureOpenAiKey: env('AZURE_OPENAI_KEY'), skillPlatform: createSkillPlatform({ projectDir: PROJECT_DIR, env }), runtime: {} });

// Whether media (video/music) is still playing. This used to live only inside one
// RealtimeSession object, but every Fn/hotword trigger creates a NEW session (the
// previous one ends after 20 s of silence). A video started in one conversation was
// therefore forgotten by the next: _mediaModeActive restarted at false while the
// video kept playing. Confirmed in real logs: video subtitles and outros (Korean,
// Turkish, Japanese) were repeatedly transcribed as "the user spoke" because the
// new session started with the low threshold (0.6). Persisting the state in a file
// carries it across sessions.
const MEDIA_STATE_FILE = path.join(PROJECT_DIR, '.media-playing-state.json');
const MEDIA_STATE_TTL_MS = 40 * 60 * 1000; // considered stale after 40 minutes (videos/songs rarely run longer)
function saveMediaState() {
  fs.promises.writeFile(MEDIA_STATE_FILE, JSON.stringify({ active: true, setAt: Date.now() })).catch(() => {});
}
async function isMediaRecentlyLikelyPlaying() {
  try {
    const s = JSON.parse(await fs.promises.readFile(MEDIA_STATE_FILE, 'utf8'));
    return s.active && (Date.now() - s.setAt) < MEDIA_STATE_TTL_MS;
  } catch (e) { return false; }
}

// SYSTEM-LEVEL detection of playing media. The file state above only works when
// JARVIS itself opened the video or music; if the user opened YouTube, the system
// had no idea. Real logs showed the consequence: the microphone picked up the
// video and transcribed it as the user speaking (a Turkish YouTube outro got in).
//
// macOS provides a precise signal: an app playing media (Chrome, Spotify, ...)
// holds a "Playing audio" power assertion. Verified: JARVIS's OWN voice (afplay)
// does NOT create that assertion, so our own speech cannot trigger it.
function checkSystemAudioPlaying() {
  return new Promise((resolve) => {
    try {
      const p = spawn('pmset', ['-g', 'assertions']);
      let out = '';
      p.stdout.on('data', d => out += d);
      p.on('error', () => resolve(null));
      p.on('close', () => resolve(/named: "Playing audio"/.test(out)));
      setTimeout(() => { try { p.kill(); } catch (e) {} resolve(null); }, 3000);
    } catch (e) { resolve(null); }
  });
}
// Among the OpenAI realtime voices, `cedar` and `marin` are the recommended newest
// generation. cedar was chosen for JARVIS as a clearer, calm male tone; switch it
// in .env for A/B tests.
const VOICE_STYLE = env('JARVIS_VOICE_STYLE', 'cinematic-robot');
// Empty lets the Realtime provider detect the language for multilingual turns.
const TRANSCRIPTION_LANGUAGE = env('REALTIME_TRANSCRIPTION_LANGUAGE', '');
const TRANSCRIPTION_MODEL = env('REALTIME_TRANSCRIPTION_MODEL', 'gpt-4o-transcribe');
const CONVERSATION_STYLE_INSTRUCTIONS = "Respond to the user's latest turn in natural English by default. Do not switch languages because of the user's language, accent, isolated foreign words, quoted text, transcription errors, or background audio. Translate into or speak in another language only when the user explicitly requested that named language; otherwise answer in English. Stay in character (composed, economical, dry wit only when it lands naturally) and sound unforced, with natural wording and varied sentence length. Use complete sentences, always finish the thought, and never cut a sentence short; be concise for simple turns, but include enough detail when the question needs it. If the user requested an action, use the appropriate available tool instead of only describing or promising the action, and never claim completion before a successful tool result. Never invent missing facts, and do not use markdown.";
// Speculative response: the server starts answering as soon as speech ends (like the Azure
// playground) while JARVIS checks the transcript and accepts or cancels it. Audio and tool calls are held until then.
// 'explicit' (default): the realtime model answers ordinary questions itself; the slow ask_expert path is used
// only when deep analysis is explicitly requested. 'always' = old behaviour (serious questions always go to ask_expert, ~10+ s).
const EXPERT_ROUTING = env('JARVIS_EXPERT_ROUTING', 'explicit');
const SESSION_PREFIX_PADDING_MS = parseInt(env('AZURE_VOICELIVE_SESSION_PREFIX_PADDING_MS') || env('AZURE_VOICELIVE_WAKE_PREFIX_PADDING_MS') || '80', 10);
const GROUNDING_FOLLOWUP_MAX_MS = parseInt(env('GROUNDING_FOLLOWUP_MAX_MS'), 10) || 15000;
const NATIVE_BARGE_IN_RMS = parseInt(env('REALTIME_NATIVE_BARGE_IN_RMS'), 10) || 450;
const NATIVE_MIC_MUTE_GRACE_MS = 150;
const NATIVE_BARGE_IN_CONFIRM_MS = parseInt(env('REALTIME_NATIVE_BARGE_IN_CONFIRM_MS'), 10) || 250;
const NATIVE_PREROLL_BYTES = 24000 * 2 * 1.2;
const STOP_QUIET_MS = 6000;
// Always-listening: while idle, the local energy gate sends only speech (+ the preceding 450 ms) to the cloud.
const IDLE_GATE_MIN_RMS = parseInt(env('ALWAYS_LISTEN_MIN_RMS'), 10) || 140;
const IDLE_GATE_HANGOVER_MS = parseInt(env('ALWAYS_LISTEN_HANGOVER_MS'), 10) || 900;
const IDLE_GATE_PREROLL_BYTES = 24000 * 2 * 0.45;
const BARGE_IN_VERIFY_TIMEOUT_MS = parseInt(env('REALTIME_BARGE_IN_VERIFY_MS'), 10) || 3500;
const TRAILING_SILENCE_MAX_MS = parseInt(env('REALTIME_TRAILING_SILENCE_MAX_MS'), 10) || 2500;
const SPECULATIVE_RESPONSE = env('REALTIME_SPECULATIVE_RESPONSE', 'true') !== 'false';
const SPECULATIVE_DECISION_TIMEOUT_MS = parseInt(env('REALTIME_SPECULATIVE_TIMEOUT_MS'), 10) || 4000;
// Azure Speech transcription inside Voice Live takes ~0.2 s (gpt-4o-transcribe ~1 s), measured.
// The azure-realtime fallback accepts only OpenAI models.
const VOICE_LIVE_TRANSCRIPTION_MODEL = env('REALTIME_VOICE_LIVE_TRANSCRIPTION_MODEL', 'azure-speech');
// How long the microphone keeps waiting after JARVIS finishes speaking (room
// acoustics / speaker tail). In real use 500 ms proved too short: JARVIS heard
// its own voice again.
const MIC_MUTE_GRACE_MS = parseInt(env('MIC_MUTE_GRACE_MS'), 10) || 650;
const NORMAL_VAD_THRESHOLD = parseFloat(env('REALTIME_VAD_THRESHOLD')) || 0.55;
const MEDIA_VAD_THRESHOLD = parseFloat(env('REALTIME_MEDIA_VAD_THRESHOLD')) || 0.72;
// In an ordinary Fn/hotword conversation the turn should close quickly. 180 ms
// does not cut normal breathing pauses inside a sentence and starts the first
// answer sooner than the previous 220 ms profile; media is protected by its own
// conservative profile.
const NORMAL_VAD_SILENCE_MS = parseInt(env('REALTIME_VAD_SILENCE_MS'), 10) || 180;
const MEDIA_VAD_SILENCE_MS = parseInt(env('REALTIME_MEDIA_VAD_SILENCE_MS'), 10) || 750;
// In Realtime, the output token budget covers text and audio together. Live
// telemetry showed even 7-13 word answers being cut by a 160-token
// `max_output_tokens`. Brevity is enforced by the prompt/policy; the technical
// limit must never cut a finished sentence in half.
// 1024 was too loose: answers dragged on and ended with filler like "let me know if you have more questions".
const REALTIME_MAX_RESPONSE_TOKENS = parseInt(env('REALTIME_MAX_RESPONSE_TOKENS'), 10) || 500;
// Realtime audio tokens are consumed much faster than text tokens. 40 tokens
// cut even a short confirmation like "It is 20:20 now" in half. Fast-action
// replies are short, but use a separate safe limit so their audio plays in full.
const REALTIME_FAST_ACTION_MAX_RESPONSE_TOKENS = parseInt(env('REALTIME_FAST_ACTION_MAX_RESPONSE_TOKENS'), 10) || 256;
// Realtime audio chunks can arrive unevenly over the network. Playing audio
// immediately starves the sox pipe now and then, leaving silence mid-sentence.
// A small initial buffer absorbs that jitter.
const PLAYBACK_PREBUFFER_MS = Math.max(0, parseInt(env('REALTIME_PLAYBACK_PREBUFFER_MS', '40'), 10) || 0);
const PLAYBACK_MAX_WAIT_MS = Math.max(0, parseInt(env('REALTIME_PLAYBACK_MAX_WAIT_MS', '80'), 10) || 0);
const DUPLEX_ECHO_THRESHOLD = parseFloat(env('DUPLEX_ECHO_THRESHOLD')) || 0.72;
const DUPLEX_BARGE_IN_RMS = resolveBargeInResidual(ENV_VALUES, AUDIO_CALIBRATION, 900);
const DUPLEX_NOISE_FLOOR = resolveCalibratedNumber('DUPLEX_NOISE_FLOOR', ENV_VALUES, AUDIO_CALIBRATION, 80);
const DUPLEX_NOISE_MULTIPLIER = resolveCalibratedNumber('DUPLEX_NOISE_MULTIPLIER', ENV_VALUES, AUDIO_CALIBRATION, 2.4);
// Boosts the speech the local duplex engine sends when the Mac microphone is
// quiet. Echo/noise decisions stay on the raw signal, so the preamp does not make
// JARVIS more likely to mistake its own voice for a barge-in.
const REALTIME_INPUT_GAIN = Math.max(1, Math.min(8, resolveCalibratedNumber('REALTIME_INPUT_GAIN', ENV_VALUES, AUDIO_CALIBRATION, 3)));
// If the local gate stops sending audio before the silence the server VAD waits
// for, the provider never emits speech_stopped and the turn stays open until the
// idle timeout. Add one daemon audio step (150 ms) on top of the media VAD window.
// Normal dialogue uses its own shorter hangover; otherwise a 900 ms local gate
// would cancel out the 300 ms server VAD optimisation.
const NORMAL_DUPLEX_HANGOVER_MS = Math.max(
  parseInt(env('REALTIME_NORMAL_DUPLEX_HANGOVER_MS'), 10) || 330,
  NORMAL_VAD_SILENCE_MS + 150
);
const MEDIA_DUPLEX_HANGOVER_MS = Math.max(
  parseInt(env('DUPLEX_HANGOVER_MS'), 10) || 900,
  MEDIA_VAD_SILENCE_MS + 150
);
const DUPLEX_MAX_ECHO_LAG_MS = resolveCalibratedNumber('DUPLEX_MAX_ECHO_LAG_MS', ENV_VALUES, AUDIO_CALIBRATION, 180);
// A single loud echo residual must not interrupt Jarvis. Hold candidate audio
// locally until near-end speech remains continuous for this long, then replay
// the complete candidate to server VAD so the user's first syllable is kept.
const BARGE_IN_CONFIRM_MS = parseInt(env('REALTIME_BARGE_IN_CONFIRM_MS'), 10) || 420;
// A consonant or a very short pause at the start of natural speech can briefly
// lower the energy. Keep the candidate in a small window; a long gap resets it
// because it is likely separate echo or noise.
const BARGE_IN_MAX_GAP_MS = parseInt(env('REALTIME_BARGE_IN_MAX_GAP_MS'), 10) || 80;

const IN_RATE = 16000;   // rate of the jarvis_daemon.js microphone stream
const OUT_RATE = 24000;  // rate the Realtime API expects and returns

// ── 16 kHz → 24 kHz linear interpolation (real time, without spawning sox) ──
function resample16to24(pcm16) {
  const inSamples = pcm16.length / 2;
  const outSamples = Math.floor(inSamples * OUT_RATE / IN_RATE);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcPos = i * IN_RATE / OUT_RATE;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, inSamples - 1);
    const frac = srcPos - idx0;
    const s0 = pcm16.readInt16LE(Math.min(idx0, inSamples - 1) * 2);
    const s1 = pcm16.readInt16LE(idx1 * 2);
    const s = Math.round(s0 + (s1 - s0) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  return out;
}

function buildSessionUpdate(provider, options) {
  // Allow session-level tuning via env vars so behavior can match Playground
  // Never let the server cut a reply itself: room echo passing server VAD used to cut answers mid-way (20% turn_detected in logs).
  // Real barge-in is confirmed by the local echo filter (duplex).
  const SESSION_INTERRUPT = (env('AZURE_VOICELIVE_INTERRUPT_RESPONSE') || 'false') === 'true';

  const speculative = Boolean(options.speculative) && provider.id === 'voice-live' && !options.startMediaAware;
  const turnDetection = options.startMediaAware
    ? { type: 'server_vad', threshold: MEDIA_VAD_THRESHOLD, silence_duration_ms: MEDIA_VAD_SILENCE_MS, prefix_padding_ms: SESSION_PREFIX_PADDING_MS, create_response: false, interrupt_response: SESSION_INTERRUPT }
    : { type: 'server_vad', threshold: NORMAL_VAD_THRESHOLD, silence_duration_ms: NORMAL_VAD_SILENCE_MS, prefix_padding_ms: SESSION_PREFIX_PADDING_MS, create_response: speculative, interrupt_response: SESSION_INTERRUPT };
  const transcription = {
    model: provider.id === 'voice-live' ? VOICE_LIVE_TRANSCRIPTION_MODEL : TRANSCRIPTION_MODEL,
    ...(TRANSCRIPTION_LANGUAGE ? { language: TRANSCRIPTION_LANGUAGE } : {})
  };
  const common = {
    // Always append the style guide to the session: `instructions` in response.create REPLACES the session
    // instructions (character, capabilities, tool rules) for that one response.
    instructions: options.instructions + '\n\n' + CONVERSATION_STYLE_INSTRUCTIONS,
    tools: options.tools,
    tool_choice: 'auto'
  };

  if (provider.id === 'azure-realtime') {
    try {
      const { inf } = require('../../core/log');
      const providerId = provider && provider.id ? provider.id : 'unknown-provider';
      const voiceName = provider && provider.voice ? provider.voice : (env('AZURE_VOICELIVE_VOICE') || env('AZURE_SPEECH_VOICE') || 'unknown-voice');
      inf(`[realtime-voice] session.update -> provider=${providerId}, voice=${voiceName}, prefix=${SESSION_PREFIX_PADDING_MS}ms, silence=${options.startMediaAware ? MEDIA_VAD_SILENCE_MS : NORMAL_VAD_SILENCE_MS}ms`);
    } catch (e) {}
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        ...common,
        output_modalities: ['audio'],
        audio: {
          input: { format: { type: 'audio/pcm', rate: 24000 }, transcription, turn_detection: turnDetection },
          output: { format: { type: 'audio/pcm', rate: 24000 }, voice: provider.voice }
        },
        max_output_tokens: REALTIME_MAX_RESPONSE_TOKENS
      }
    };
  }

  return {
    type: 'session.update',
    session: {
      ...common,
      modalities: ['text', 'audio'],
      voice: provider.voice,
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      max_response_output_tokens: REALTIME_MAX_RESPONSE_TOKENS,
      turn_detection: turnDetection,
      input_audio_transcription: transcription,
      // As in the Azure playground: server echo cancellation and deep noise suppression,
      // so JARVIS does not hear its own voice and interrupt itself.
      ...(provider.id === 'voice-live' ? {
        input_audio_echo_cancellation: { type: 'server_echo_cancellation' },
        input_audio_noise_reduction: { type: 'azure_deep_noise_suppression' }
      } : {})
    }
  };
}

// A short summary of what the user did in the last few hours, injected BEFORE the
// conversation starts. Previously every conversation began from a blank page: when
// the user said "continue that", JARVIS had to ask what they meant. Now it starts
// already informed.
const RECENT_CONTEXT_HOURS = parseFloat(env('RECENT_CONTEXT_HOURS')) || 2;
const RECENT_CONTEXT_MAX_BLOCKS = 8;

function recentContextBlock() {
  try {
    const mem = require('../memory');
    const now = new Date();
    const items = [];
    // Right after midnight (e.g. 00:15) yesterday's file may still hold recent
    // entries, so both days are read.
    for (let dayBack = 0; dayBack <= 1; dayBack++) {
      const d = new Date(now); d.setDate(d.getDate() - dayBack);
      const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
      const fp = path.join(mem.MEMORY_DIR, y + '-' + mo + '-' + da + '.md');
      if (!fs.existsSync(fp)) continue;
      const content = fs.readFileSync(fp, 'utf8');
      for (const block of content.split(/^---$/m)) {
        const m = block.match(/^## (\d{2}):(\d{2}) — (.+)$/m);
        if (!m) continue;
        const bt = new Date(d); bt.setHours(+m[1], +m[2], 0, 0);
        const ageH = (now - bt) / 3600000;
        if (ageH < 0 || ageH > RECENT_CONTEXT_HOURS) continue;
        const body = block.replace(/^## .+$/m, '').replace(/\*\*(?:Tags|Teglar):\*\*.*$/m, '').trim();
        if (body) items.push({ t: bt, line: m[1] + ':' + m[2] + ' — ' + m[3] + ': ' + body.replace(/\s+/g, ' ').slice(0, 220) });
      }
    }
    if (!items.length) return '';
    items.sort((a, b) => a.t - b.t);
    return "\n\nRECENT ACTIVITY (what the user did in the last few hours; you ALREADY " +
      "know this, do not ask again; when they say \"continue that\" or \"that task\", resolve it from this list):\n" +
      items.slice(-RECENT_CONTEXT_MAX_BLOCKS).map(i => '- ' + i.line).join('\n') + '\n\n';
  } catch (e) { return ''; }
}

// USER PROFILE (Jarvis/Profile/User.md). daily-synthesis appends a new dated
// section every day (it does not merge), so the file grows without bound. This
// profile used to be absent from live voice conversations entirely (a real
// finding), so JARVIS never used anything it had learned about the user. Now the
// hand-written "Habits" section (stable) plus the most recent automatically
// learned-pattern sections (size-capped) are included. The previous cap
// (3 sections / 2000 chars) hid most of a real profile (e.g. 14 KB), so the
// model only "knew" it after calling recall_memory; now much more is visible
// automatically.
const PROFILE_SUMMARY_MAX_SECTIONS = parseInt(env('PROFILE_SUMMARY_MAX_SECTIONS'), 10) || 10;
const PROFILE_SUMMARY_MAX_CHARS = parseInt(env('PROFILE_SUMMARY_MAX_CHARS'), 10) || 6000;

function profileSummaryBlock() {
  try {
    const profile = require('../memory').readProfile();
    if (profile.status !== 'ok' || !profile.content) return '';
    const sections = profile.content.split(/^## /m).slice(1);
    if (!sections.length) return '';
    const isDailyPattern = s => /^(?:O['ʼ`]?rganilgan naqshlar|Learned patterns)\s*—\s*\d{4}/i.test(s.trim());
    const stable = sections.filter(s => !isDailyPattern(s));
    const recent = sections.filter(isDailyPattern).slice(-PROFILE_SUMMARY_MAX_SECTIONS);
    const combined = [...stable, ...recent].map(s => '## ' + s.trim()).join('\n\n').slice(0, PROFILE_SUMMARY_MAX_CHARS);
    if (!combined) return '';
    return "\n\nUSER PROFILE (habits and patterns learned over time; this is real, " +
      "verified information; use it, but do not add meta-comments like \"according to my profile\"):\n" +
      combined + '\n\n';
  } catch (e) { return ''; }
}

// Brief awareness of open missions at session start (the bridge sees both sides).
// Live self-knowledge, built from the tools and workers that actually exist (never stale).
function selfKnowledgeBlock() {
  try {
    const tools = buildTools().map(t => t.name);
    const has = n => tools.includes(n);
    const exists = rel => fs.existsSync(path.join(PROJECT_DIR, rel));
    const can = [];
    if (has('web_open')) can.push('open/play/search web pages instantly');
    if (has('file_op')) can.push('move/copy/write/trash files (undoable)');
    if (has('undo_last')) can.push('undo your last file or volume change');
    if (has('start_mission')) can.push('run long autonomous missions in the background (hours/days)');
    if (has('see_screen')) can.push('look at the screen on request');
    if (has('recall_memory')) can.push('search long-term memory');
    let phoneConnected = false;
    try { phoneConnected = execFileSync('pgrep', ['-x', 'iPhone Mirroring'], { timeout: 2000 }).toString().trim().length > 0; } catch (e) { phoneConnected = false; }
    if (phoneConnected) can.push('see and control the user\'s connected iPhone (tap, type, open apps) via run_task');
    const workers = ['babyagi:.venv-babyagi', 'autogpt:.venv-autogpt', 'browser:.venv-workers', 'interpreter:.venv-workers'].filter(w => exists(w.split(':')[1])).map(w => w.split(':')[0]);
    const cannot = [];
    if (!exists('.google-tokens.json')) cannot.push('read Gmail or Calendar (Google is not connected yet)');
    if (!phoneConnected) cannot.push('control the phone right now (iPhone Mirroring is not connected — it needs the phone unlocked nearby once)');
    cannot.push('see the screen continuously (only on request or ambient app name)');
    return '\n\nYOUR REAL ABILITIES RIGHT NOW (generated from the live system; do not claim more): ' + can.join('; ') + '.' +
      (workers.length ? ' Mission workers installed: ' + workers.join(', ') + '.' : '') +
      ' You currently CANNOT: ' + cannot.join('; ') + '. If asked for something outside this, say so plainly.\n';
  } catch (e) { return ''; }
}

function missionsBlock() {
  try {
    const dir = path.join(PROJECT_DIR, '.run', 'missions', 'missions');
    const open = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const mission = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        const recentlyDone = mission.status === 'completed' && Date.now() - (mission.completedAt || 0) < 12 * 3600000;
        if (recentlyDone || ['planning', 'running', 'paused', 'awaiting_approval', 'blocked'].includes(mission.status)) open.push(mission);
      } catch (e) {}
    }
    if (!open.length) return '';
    open.sort((a, b) => a.n - b.n);
    const lines = open.slice(-4).map(m => {
      const done = (m.tasks || []).filter(t => t.status === 'done').length;
      const extra = m.status === 'awaiting_approval' && m.pendingApproval ? ` — waiting for approval: ${m.pendingApproval.reason}` : '';
      const outcome = m.status === 'completed' && m.result ? ` — result: ${String(m.result).slice(0, 120)}` : '';
      return `Mission ${m.n} [${m.status}] ${String(m.goal).slice(0, 90)} (${done}/${(m.tasks || []).length} tasks)${extra}${outcome}`;
    });
    return '\n\nBACKGROUND MISSIONS RIGHT NOW (mention only when relevant or asked):\n' + lines.join('\n') + '\n';
  } catch (e) { return ''; }
}

function loadInstructions() {
  return (
    "You are Jarvis, the user's realtime voice assistant. English is the default response language: reply in natural English regardless of the language, accent, isolated foreign words, quoted text, transcription errors, or background audio in the user's speech. Do not automatically switch to Uzbek, Russian, or any other language. An explicit request to translate into a named language, or to speak or respond in a named language, is the only exception; fulfill that requested translation or language conversation, then return to English unless the user explicitly asks to continue in that language. " +
    personaInstructions(env) +
    "Talk like an attentive, capable person: direct, context-aware, and unforced. Never claim to be human. Use natural contractions, varied sentence length, and brief conversational reactions when they fit; avoid canned assistant phrases and robotic repetition. Prefer concise, colloquial spoken wording over formal written prose; say the useful thing first and stop when the answer is complete. " +
    "Match the answer length to the need: keep simple replies short, but give enough detail to fully answer a real question. Do not force every reply into one sentence and never cut a thought short. Start speaking the first useful answer as soon as it is ready; reason silently, do not narrate thinking, and do not delay a simple answer for extra polish. " +
    "Keep delivery natural and responsive to the session voice instructions; never add a literal metallic or synthetic effect. " +
    "Never add unnecessary greetings, preambles, status narration, markdown, or unsolicited suggestions. Do not say 'certainly', 'let me', or 'one moment' before acting. " +
    "CAPABILITY: you are the voice of a full personal assistant, so never say you cannot do something and never ask the user for information you can look up. " +
    "Through run_task you can operate the user's calendar and email (read, create, send), contacts, Telegram and other messaging, reminders and to-do tasks, " +
    "web research and browsing, files, code and terminal work, apps and the visible screen, maps and the 3D globe, and daily summaries. " +
    "For 'my day', 'what did I do', or 'what is going on' call recall_memory first (add run_task for calendar or email when relevant). " +
    "When a person is named without an address or number, let run_task resolve the contact instead of asking. " +
    "For 'send', 'text', or 'email someone', call run_task right away with the user's words; it finds the contact and drafts the message, and, because the user has granted full autonomy, it sends without asking for confirmation. " +
    "Ask only when a required detail truly cannot be looked up, once and briefly. If a task fails because an integration is not connected, " +
    "name that integration in one sentence and say how to fix it. " +
    "MISSIONS: you are the always-on voice bridge between the user and a team of autonomous background agents. Never make the user wait for a long job: " +
    "for any large or long-running goal (many steps, research, building or fixing a project, 'until it is done', hours or days) call start_mission immediately, " +
    "confirm in one short sentence, and keep talking. The user may hand you several goals, so start each as its own mission and keep them all in view. " +
    "Report a mission's progress only when asked or when an announcement arrives; use mission_status before answering anything about background work. " +
    "When a mission needs approval, say plainly what it wants to do and ask; on yes call mission_control approve, on no call reject. " +
    "A single quick job of a few minutes still uses run_task or fast_action. " +
    "ACTION FIRST: when the user asks you to do something and an available tool can do it, call the tool instead of merely explaining how to do it or promising to do it. " +
    "Never start run_task or a mission from a garbled, half-heard or vague request (e.g. 'start your other class', 'let's start the work'): ask one short question instead, because the speech recognizer mishears. Use web_open for play/search/open-site requests (seconds); use file_op for simple file move/rename/create/save/delete (undoable; say 'undo' handling via undo_last); use fast_action for a supported one-step computer action; use manage_tasks for viewing, adding, completing, or removing daily to-do tasks in Obsidian; use run_task for browser interaction, files, coding, forms, or multi-step work; " +
    "use see_screen for visible screen content, recall_memory whenever a question is about the user's own life, work, projects, people or past and the answer is not already visible above, and ask_expert only when the user explicitly asks for deep, long analysis (never for ordinary questions). Treat short deictic questions such as 'what is that?', 'what's this?', 'bu nima?', or 'shu nima?' as screen questions whenever a screen could be the referent: call see_screen silently before answering. Describe only what the screen evidence shows; never guess an object from background audio, a transcript fragment, or an unrelated conversation. " +
    "Call fast tools silently and speak only their result. For a long run_task, one brief acknowledgement is acceptable, but never claim success until the tool returns a successful result. If a tool fails or only partially completes the work, say that plainly. " +
    "Independent run_task calls may run in parallel; report each result when it finishes. The user has granted full autonomy: never ask the user to confirm anything or to say a confirmation word — do the work and report the result. If a tool result ever says CONFIRMATION REQUIRED, tell the user briefly once and wait. " +
    "MEMORY: treat recent activity and the user profile below as facts you already remember. If the user asks to play their favorite music or mentions a personal preference found in the profile, immediately use the appropriate tool (such as web_open with youtube_play) rather than asking what their favorite is. Use remembered facts naturally without mentioning memory files. " +
    "Resolve references such as 'that task' from recent context; if ambiguity could cause a wrong action, ask one concise clarification. " +
    "During the same live session, treat each new utterance as a natural follow-up without requiring the user to say Jarvis again; preserve context and resolve short follow-ups such as 'yana-chi?' or 'what about tomorrow?'. " +
    "Never invent a remembered fact. Adapt subtly to urgency or mood audible in the user's voice without explicitly commenting on emotion." +
    selfKnowledgeBlock() + missionsBlock() + ambientBlock(path.join(PROJECT_DIR, '.run', 'ambient-context.json')) + recentContextBlock() + profileSummaryBlock()
  );
}

function prepareSpokenAnswer(answer) {
  return String(answer || '').trim();
}

// Tools are rebuilt on every connection (not static), so newly learned entries in
// the fast-actions list (see skills/fast-actions) are visible to the very next
// conversation without restarting the daemon.
function buildTools() {
  let fastActionIds = [];
  let fastActionsDoc = '';
  try {
    const fa = require('../fast-actions');
    const actions = fa.loadActions();
    fastActionIds = actions.map(a => a.id);
    fastActionsDoc = actions.map(a => a.id + ' — ' + (a.en || a.uz)).join('; ');
  } catch (e) {}

  const tools = [{
    type: 'function',
    name: 'run_task',
    description: "Call this when the computer needs a COMPLEX, multi-step action (browsing, clicking, filling forms, " +
      "analysing the screen, working with files or code, remembering/recalling, the task list, " +
      "searching the web, phone-related actions, etc.). Phone requests (a WhatsApp message, Instagram, opening an app, something on the phone screen) also go through `run_task`: it really controls the paired iPhone, so never say you cannot do it. " +
      "For a simple one-step action (open an app or a site, volume, " +
      "screenshot, time/date/battery) use `fast_action` INSTEAD; it is MUCH FASTER. " +
      "A fully capable assistant runs the task INDEPENDENTLY in the background (without blocking other tasks) and returns " +
      "the result as text when done. Call it several times for several independent tasks; they " +
      "run in parallel.",
    parameters: {
      type: 'object',
      properties: { description: { type: 'string', description: "The exact task to perform, in the user's own words" } },
      required: ['description']
    }
  }, {
    type: 'function',
    name: 'note_pronunciation',
    description: "When the user corrects a misunderstanding (e.g. \"no, I said ...\", " +
      "\"I didn't say ..., I said ...\", or a similar correction), call this IMMEDIATELY without saying anything " +
      "(the call is silent and only writes to memory). It keeps the same word from being " +
      "misheard again next time.",
    parameters: {
      type: 'object',
      properties: {
        misheard: { type: 'string', description: 'The word or phrase you misheard or misunderstood' },
        actual: { type: 'string', description: 'What the user actually said (after the correction)' }
      },
      required: ['misheard', 'actual']
    }
  }];

  // SEEING THE SCREEN during a live conversation: the image is added straight to this
  // conversation (tested against the real endpoint: gpt-realtime-2.1 accepts images and
  // describes them accurately). Previously the only way was `run_task` and a separate
  // vision model, 15-20 seconds; this takes ~1 second and the model "sees" the screen
  // while it answers.
  tools.push({
    type: 'function',
    name: 'see_screen',
    description: "Call this when you need to SEE what is on screen right now; the image is shown " +
      "to you directly and you analyse it yourself. When: the user asks something visual such as \"bu nima\", \"shu xato nima\", " +
      "\"what is that\", \"what's this\", \"what's on my screen\", \"read this to me\", \"what does it say here\", " +
      "or when screen context is needed to understand them. This is MUCH FASTER than `run_task`; " +
      "NEVER use run_task just to look at the screen. Note: this only " +
      "LOOKS; it never clicks or changes anything. To act on the screen you need `run_task`. " +
      "IMPORTANT: say NOTHING before calling it (no \"let me look\", \"one moment\"); call it silently and, " +
      "once you have seen the image, give the answer DIRECTLY. Do not guess object names without image evidence; never infer from background audio or a text fragment. Such filler adds several seconds of " +
      "delay and keeps the user waiting for nothing.",
    parameters: { type: 'object', properties: {}, required: [] }
  });

  // Semantic search over the ENTIRE history. The "recent activity" block in the
  // instructions only covers the last few hours ("what were you just doing"). This
  // tool has no time limit: it finds things from yesterday, last week or last year,
  // and matches by meaning even when the words differ.
  tools.push({
    type: 'function',
    name: 'recall_memory',
    description: "Search the user's full remembered history and profile — call this WHENEVER a question is about the user's own life, work, projects, people, preferences, or past, and the answer is not already visible in the context above. " +
      "This covers explicit references (\"o'sha loyiha\", \"avval nima degandik\", \"eslaysanmi\") AND plain factual questions about the user (\"what am I working on\", \"what's my email\", \"do you know my resume\", \"who is X to me\") — do not wait for the user to say \"remember\" or \"search your memory\"; call it yourself. " +
      "Searches by MEANING across the entire history (yesterday or a year ago), matches even when wording differs. Fast (~1s) — call it without hesitating rather than guessing or saying you don't know. " +
      "Not needed for the last few hours of activity — that is already in the \"RECENT ACTIVITY\" list above. " +
      "IMPORTANT: say NOTHING before calling it (no \"let me remember\", \"let me think\"); " +
      "call it silently and, once you see the result, give the answer DIRECTLY. When recalling something, " +
      "briefly mention when it happened (e.g. \"last Tuesday\", \"on August 13\"); it builds trust.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: "What to recall: a topic, name or question, in the user's own words" } },
      required: ['query']
    }
  });

  tools.push({
    type: 'function',
    name: 'save_memory',
    description: "Save a new personal fact, preference, rule, or piece of information about the user into long-term memory (Obsidian). " +
      "Call this WHENEVER the user says 'remember this', 'eslab qol', 'save in your memory', 'eslab qolishingni xohlayman', or shares a permanent preference/fact. " +
      "Takes effect immediately in milliseconds without delay.",
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: "The clear, standalone fact to remember (e.g. 'Favorite music is Billie Jean by Michael Jackson' or 'User's dream car is Porsche 911 GT3 RS')" },
        category: { type: 'string', description: "Optional category, e.g. preference, work, personal, contact" }
      },
      required: ['fact']
    }
  });

  // Fast access to the daily task list (Obsidian DailyTasks.md)
  tools.push({
    type: 'function',
    name: 'manage_tasks',
    description: "Fast access (<50 ms) to the user's daily task list in the Obsidian vault (DailyTasks.md). " +
      "When: the user asks for today's tasks (action: 'list'), wants to add a task (action: 'add', text: '...'), " +
      "marks a task done (action: 'complete', text: '...'), or removes one (action: 'remove', text: '...'). " +
      "NEVER use run_task for tasks; call manage_tasks directly.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'complete', 'remove'], description: 'Amal turi' },
        text: { type: 'string', description: 'Task text (for add, complete, remove)' }
      },
      required: ['action']
    }
  });

  // Route SERIOUS QUESTIONS TO A STRONGER MODEL. The realtime model is optimised for
  // voice: fast and natural in short conversation, but slow and wordy in multi-step
  // reasoning. Complex reasoning therefore does not stay in the realtime audio model;
  // the primary Responses API model is better optimised for it.
  tools.push({
    type: 'function',
    name: 'ask_expert',
    description: EXPERT_ROUTING === 'always'
      ? "Call this when the user asks something that GENUINELY needs thinking: analysis, advice, comparison, " +
        "planning, cause and effect, calculation. Pass the FULL question with the needed context. " +
        "When the answer returns, read it back almost unchanged, in a natural tone. Not needed for ordinary conversation. " +
        "Say nothing before calling it."
      : "SLOW (many seconds). Call ONLY when the user explicitly asks for deep, careful or long analysis, a detailed plan, " +
        "or a full comparison. NEVER call it for ordinary conversation, explanations, opinions, advice, or quick reasoning — " +
        "answer those yourself right away. Give the FULL question with all needed context (the expert cannot see the conversation). " +
        "Read the result back naturally without rewriting it.",
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: 'The full question plus all needed context (the expert cannot see the conversation)' } },
      required: ['question']
    }
  });

  // Long-running, goal-driven autonomous missions (hours or days); they never block the voice conversation.
  tools.push({
    type: 'function',
    name: 'start_mission',
    description: "Use for a BIG or LONG goal that needs many steps and may take minutes, hours or days: research everything about X, " +
      "build or fix a project end to end, keep working until something is achieved, organise a lot of files, monitor and report. " +
      "It returns instantly and an autonomous agent team (computer agent, code interpreter, web browser, screen worker) works in " +
      "the background until the goal is verifiably achieved, asking the user only for risky steps. You can start several missions. " +
      "For a single quick job (a few minutes) use run_task instead. After starting, answer in one short sentence and stay available.",
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: "The full goal in the user's words with every constraint and the definition of done" },
        hours: { type: 'number', description: 'Optional time budget in hours (default 72)' }
      },
      required: ['goal']
    }
  });
  tools.push({
    type: 'function',
    name: 'mission_status',
    description: "Progress of the user's background missions: what is running, how far along, what is blocked or waiting for approval. " +
      "Call silently when the user asks how it is going, what you are working on, or about a specific mission number.",
    parameters: { type: 'object', properties: { mission: { type: 'string', description: 'Optional mission number' } } }
  });
  tools.push({
    type: 'function',
    name: 'mission_control',
    description: "Control a background MISSION (use this, not cancel_task, whenever the user says pause, stop, hold, resume, cancel or approve about a mission, a goal, or the background work): pause, resume (also unblocks a stalled one), cancel, approve or reject a step that is " +
      "waiting for permission, or add a note/instruction. If only one mission matches, the number may be omitted.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['pause', 'resume', 'cancel', 'approve', 'reject', 'note'] },
        mission: { type: 'string', description: 'Mission number' },
        text: { type: 'string', description: 'For note: the instruction to add' }
      },
      required: ['action']
    }
  });

  tools.push({
    type: 'function',
    name: 'standing_approval',
    description: "Manage standing permissions so the user is not asked every time for a repeated outward action, within a daily limit and expiry. " +
      "grant: only when the user explicitly says you may keep doing something without asking (for example 'you can apply to matching jobs up to 10 a day for a week'); " +
      "the system then asks the user to say confirm. Scopes: job-applications, recruiter-messages, external-messages. " +
      "Payments, deletions, passwords and permission changes can never be covered. list: show active ones. revoke: cancel one by id or all.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['grant', 'list', 'revoke'] },
        scopes: { type: 'array', items: { type: 'string', enum: ['job-applications', 'recruiter-messages', 'external-messages'] } },
        per_day: { type: 'number', description: 'Maximum approved tasks per day (default 10)' },
        days: { type: 'number', description: 'How many days it stays valid (default 7)' },
        id: { type: 'string', description: 'For revoke: the permission id or all' }
      },
      required: ['action']
    }
  });

  tools.push({
    type: 'function',
    name: 'cancel_task',
    description: "ONLY for quick run_task jobs running right now (\"stop that task\"). If the user means a background mission or long goal, call mission_control instead. " +
      "When the user asks to STOP the task in progress (\"stop\", \"cancel\", \"never mind\", \"to'xtat\", \"bekor qil\", " +
      "\"kerak emas\"), call this immediately. Every running `run_task` task is stopped. " +
      "It is fine to call it when nothing is running; it just reports that there was nothing to stop.",
    parameters: { type: 'object', properties: {}, required: [] }
  });

  tools.push({
    type: 'function',
    name: 'web_open',
    description: "INSTANT web actions (1-3 seconds, no agent): play a song/video on YouTube (youtube_play), YouTube search, Google search, Maps search (maps), 3D satellite globe / Earth (globe), or open a URL. " +
      "ALWAYS prefer this over run_task for 'play X', 'search for X', 'open site X', 'show X on the globe/map'. Use run_task only if the page needs clicking, logging in or forms.",
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['youtube_play', 'youtube_search', 'google', 'maps', 'globe', 'url'] },
        query: { type: 'string', description: 'search text, city/location, or song/video name' },
        url: { type: 'string', description: 'for kind=url only' }
      },
      required: ['kind']
    }
  });

  tools.push({
    type: 'function',
    name: 'close_app',
    description: "INSTANT (under ~1s): quit any named application by its exact name (e.g. 'Telegram', 'Visual Studio Code', 'Spotify'). " +
      "Always use this instead of describing manual steps to the user — you can close apps directly. Tries a graceful quit, force-closes if it does not respond.",
    parameters: { type: 'object', properties: { name: { type: 'string', description: "the app's name as the user said it" } }, required: ['name'] }
  });
  tools.push({
    type: 'function',
    name: 'file_op',
    description: "Instant, UNDOABLE file operations inside the user's home folder: mkdir, move (also rename), copy, write (text), trash (delete = move to Trash). " +
      "Use for simple 'move/rename/create/save/delete this file' requests instead of run_task. Anything outside ~ or in Library/.ssh is refused.",
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['mkdir', 'move', 'copy', 'write', 'trash'] },
        path: { type: 'string' }, dest: { type: 'string', description: 'for move/copy' }, content: { type: 'string', description: 'for write' }
      },
      required: ['op', 'path']
    }
  });
  tools.push({
    type: 'function',
    name: 'undo_last',
    description: "Take back the assistant's own last file operation or volume change. Call when the user says undo, take that back, revert, or 'no, put it back'.",
    parameters: { type: 'object', properties: {}, required: [] }
  });

  if (fastActionIds.length) {
    tools.push({
      type: 'function',
      name: 'fast_action',
      // The full list of all 115 actions used to be spelled out here as "id — note",
      // and the very same ids were repeated in the enum below, so the list was sent
      // twice and ~1500 tokens were reprocessed on every answer. The ids are
      // self-explanatory ("open:chrome", "volume:up", "info:battery"), so the enum is
      // enough; this description only names the kinds of actions.
      description: "For FAST, SIMPLE one-step actions: opening apps (open:*), opening sites (web:*), " +
        "volume (volume:*), system actions (system:*), screenshots (screenshot:*), " +
        "Music/Spotify control (media:*), and info queries: time/date/battery/Wi-Fi/disk (info:*). " +
        "Much FASTER than `run_task` (no full agent is started); whenever a matching action exists, " +
        "ALWAYS prefer it over run_task. The exact list is in the enum of the `id` field below.",
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', ...(fastActionIds.length ? { enum: fastActionIds } : {}), description: 'Action id to run (from the list)' } },
        required: ['id']
      }
    });
  }

  return tools;
}

const RUN_TASK_TIMEOUT_MS = OPENCLAW_AGENT_TIMEOUT_MS;

// Each call runs in its own isolated session, so several tasks can truly run in
// parallel without corrupting each other's context (with one shared session,
// two processes writing at once could clobber each other's results).
// onProc hands the started process back to the caller so it can be stopped
// later (when the user says "stop") or cleaned up when the conversation ends.
function runFullAgent(description, sessionKey, onProc, spawnAgent = spawn, onProgress, bridge = VOICE_AGENT_BRIDGE) {
  if (bridge !== VOICE_AGENT_BRIDGE || spawnAgent !== spawn) {
    return new Promise((resolve) => {
      const proc = spawnAgent('openclaw', ['agent', '--session-key', sessionKey, '--message', '[Language policy: Reply only in natural English. Never answer in Uzbek or imitate an Uzbek accent.]\n' + agentPolicyPreamble() + '\n\n' + description, '--agent', 'main', ...fastThinkingArgs(description)], { cwd: PROJECT_DIR, env: { ...process.env, AZURE_OPENAI_KEY: env('AZURE_OPENAI_KEY'), JARVIS_PROJECT_DIR: PROJECT_DIR }, timeout: RUN_TASK_TIMEOUT_MS });
      if (typeof onProc === 'function') onProc(proc);
      let out = ''; proc.stdout.on('data', d => out += d);
      proc.on('close', () => resolve(out.trim() || "Sorry, I couldn't do that."));
      proc.on('error', () => resolve('An error occurred.'));
    });
  }
  return bridge.askAgent(description, sessionKey, { source: 'voice-run-task', persistent: needsPersistentExecution(description), onProgress, onLongRunning: onProgress });
  /* Legacy spawn lifecycle intentionally retained below for compatibility reference. */
  /* c8 ignore start */
  return new Promise((resolve) => {
    const englishOnly = '[Language policy: Reply only in natural English. Never answer in Uzbek or imitate an Uzbek accent.]\n' + agentPolicyPreamble() + '\n\n';
    const proc = spawnAgent('openclaw', ['agent', '--session-key', sessionKey, '--message', englishOnly + description, '--agent', 'main', ...fastThinkingArgs(description)], {
      cwd: PROJECT_DIR,
      env: { ...process.env, AZURE_OPENAI_KEY: env('AZURE_OPENAI_KEY'), JARVIS_PROJECT_DIR: PROJECT_DIR },
      timeout: RUN_TASK_TIMEOUT_MS
    });
    const task = {
      id: TASK_CHECKPOINTS.createId(description, sessionKey), sessionKey,
      request: String(description || '').slice(0, 8000), status: 'running',
      createdAt: new Date().toISOString()
    };
    TASK_CHECKPOINTS.save(task);
    const noticeTimer = setTimeout(() => {
      if (task.status !== 'running') return;
      task.longRunningNoticeAt = new Date().toISOString();
      TASK_CHECKPOINTS.save(task);
      onProgress?.('This is taking longer than expected. Would you like me to keep going, or give you what I have so far?');
    }, AGENT_LONG_TASK_NOTICE_MS);
    noticeTimer.unref?.();
    if (typeof onProc === 'function') onProc(proc);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', () => {});
    proc.on('close', (code, signal) => {
      clearTimeout(noticeTimer);
      const clean = out.split('\n').filter(l => !l.includes('Waiting') && !l.includes('◒') && l.trim()).join('\n').trim();
      // The user stopped it on purpose; that is not an error.
      if (proc._jarvisCancelled) {
        task.status = 'cancelled'; task.finishedAt = new Date().toISOString(); TASK_CHECKPOINTS.save(task);
        resolve('Task stopped.'); return;
      }
      // Timeout: the process was killed with SIGTERM, so the collected text is
      // PARTIAL. It used to be returned as the full result, which reported
      // half-finished work as "done".
      if (signal === 'SIGTERM' && proc.killed) {
        task.status = 'partial'; task.finishedAt = new Date().toISOString(); task.result = clean.slice(0, 12000); TASK_CHECKPOINTS.save(task);
        const mins = Math.round(RUN_TASK_TIMEOUT_MS / 60000);
        resolve(clean
          ? 'The task did not finish within ' + mins + ' minutes and was stopped. Completed so far: ' + clean
          : 'The task did not finish within ' + mins + ' minutes and was stopped; no result was produced.');
        return;
      }
      task.status = code === 0 && clean ? 'completed' : 'failed';
      task.finishedAt = new Date().toISOString();
      task.result = clean.slice(0, 12000);
      TASK_CHECKPOINTS.save(task);
      resolve(clean || "Sorry, I couldn't do that.");
    });
    proc.on('error', () => {
      clearTimeout(noticeTimer);
      task.status = 'failed'; task.finishedAt = new Date().toISOString(); task.error = 'OpenClaw spawn failed'; TASK_CHECKPOINTS.save(task);
      resolve('An error occurred.');
    });
  });
  /* c8 ignore stop */
}

// Strong agent used only for thinking/analysis. It takes no action on the computer
// and uses its own session, so it never pollutes the live conversation context.
function askExpert(question, callId, grounding = '') {
  return new Promise((resolve) => {
    const prompt = "Answer the following question in concise, natural spoken English. Avoid preambles, summaries, and repetition. " +
      "The supplied Jarvis context is trusted internal information: use it naturally, but never mention a context file. " +
      "If information is missing, do not present a guess as fact.\n\n" +
      (grounding ? "JARVIS CONTEXT:\n" + grounding + "\n\n" : '') +
      "USER QUESTION:\n" + question;
    const proc = spawn('openclaw', ['agent', '--session-key', 'agent:main:jarvis-expert-' + callId,
      '--message', prompt, '--agent', 'main'], {
      cwd: PROJECT_DIR,
      env: { ...process.env, AZURE_OPENAI_KEY: env('AZURE_OPENAI_KEY'), JARVIS_PROJECT_DIR: PROJECT_DIR },
      timeout: 45000
    });
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      const clean = out.split('\n').filter(l => !l.includes('Waiting') && !l.includes('◒') && l.trim()).join('\n').trim();
      resolve(clean || "I couldn't prepare a reliable answer right now.");
    });
    proc.on('error', () => resolve("I couldn't reach the reasoning service."));
  });
}

// Greetings, the time or a one-step desktop action stay on the fast Realtime path.
// Questions about the past, projects, the screen, or that need reasons/plans/analysis
// take the deterministic RAG path instead, independent of whether the model "feels like"
// calling a tool.
function needsContextGrounding(text) {
  const value = String(text || '').toLowerCase();
  const action = /\b(open|close|click|type|write|send|launch|search|play|stop|pause|resume|och|yop|bos|yoz|yubor|o'chir|ochir|ishga tushir|qidir|qo'y|qo‘y|to'xtat|toxtat)\b/i.test(value);
  if (action && !/[?]|\b(why|how|advice|analy[sz]e|explain|nega|nima uchun|qanday qilib|maslahat|tahlil)\b/i.test(value)) return false;
  return /\b(obsidian|memory|remember|recall|earlier|previous|yesterday|last (?:week|month|time)|project|status|that (?:task|work|project)|what (?:was i|were we)|screen|on screen|looking at|watching|xotira|esla|eslaysan|oldin|avval|kecha|o'tgan|otgan|loyiha|holat|shu ish|bu ish|ishlarim|nima qilayotgan|nima ustida|ekran|ekranda|ko'rib turib|kuzat)\b/i.test(value);
}

function needsExpertAnswer(text) {
  const value = String(text || '').toLowerCase();
  return /\b(plan|strategy|analy[sz]e|analysis|advice|recommend|compare|tradeoffs?|difference|better|best|prefer|why|explain|calculate|estimate|evaluate|architecture|reja|tahlil|maslahat|taqqosla|solishtir|farqi|afzal|nega|nima uchun|qanday|qaysi|tushuntir|hisob|ulgur\w*)\b/i.test(value);
}

function needsGroundedAnswer(text) {
  return needsContextGrounding(text) || needsExpertAnswer(text);
}

// Musing, guessing or asking for advice ("I think I should...", "maybe", "what if") is not a command; do not start a task.
const HEDGED_UTTERANCE = /^(?:(?:well|so|hmm+|um+|uh+|okay|ok)[,.]?\s+)*(?:i\s+(?:think|guess|suppose|wonder|feel like|might|may|could|should|would|was thinking|am thinking|'m thinking|'m not sure|don'?t know)|i'm\s+(?:thinking|not sure|wondering)|maybe|perhaps|what if|should i|do you think|would it be|it might be|it would be|just thinking)\b/i;

// The confirmation prompt states WHAT is being confirmed (the user confirms exactly that).
function confirmationPrompt(description, assessment = {}) {
  const what = String(description || '').replace(/\s+/g, ' ').trim().slice(0, 110).replace(/[.!?\s]+$/, '');
  const lead = assessment.destructive ? 'That is destructive or hard to undo'
    : assessment.externalSideEffect ? 'That sends something outside this machine'
      : 'That needs your approval';
  return `${lead}: ${what}. Say confirm to proceed, or cancel.`;
}

// Long-horizon goals ("...until it's done", "hours", "end to end") go to the model (start_mission), not the quick background-agent path.
const LONG_HORIZON = /\b(?:until (?:it(?:'s| is)?|you|the)|keep (?:working|going|trying|at it)|don'?t stop|for (?:hours|days)|overnight|all day|as long as it takes|end[- ]to[- ]end|from scratch|whole (?:project|system|thing)|tugaguncha|to['‘’]?xtamasdan|soatlab|kunlab|maqsadga yetguncha|butun loyiha)\b/i;

function needsBackgroundAgentTask(text) {
  const value = String(text || '').trim();
  if (HEDGED_UTTERANCE.test(value)) return false;
  if (LONG_HORIZON.test(value)) return false;
  if (!value) return false;
  // Polite commands are often transcribed as questions ("Can you install
  // Word?", "Could you check my last five emails?"). A blanket `?` check
  // incorrectly left those actions with the speech model, which then claimed
  // it could not operate the computer. Keep genuine how/why questions in the
  // conversational route, but execute explicit capability requests.
  const politeActionRequest = /^(?:(?:jarvis|please|iltimos)[, ]+)*(?:can|could|would|will)\s+you\b/i.test(value);
  const informationQuestion = /\b(?:why|how|what|which|should i|advice|explain|nega|qanday|nima|qaysi|maslahat|tushuntir)\b/i.test(value);
  if (informationQuestion || (/\?/.test(value) && !politeActionRequest)) return false;
  const action = /\b(?:open|close|quit|click|type|write|create|edit|update|fix|debug|build|test|install|configure|deploy|run|start|launch|search|research|check|read|list|summarize|capture|take|send|upload|download|fill|submit|set|och|yop|bos|yoz|yarat|tahrir|yangila|tuzat|tekshir|o'q|oqi|ro'yxat|royxat|xulosa|suratga ol|skrinshot ol|o'rnat|ornat|sozla|ishga tushir|qidir|izla|yubor|yukla|to'ldir|jo'nat|jonat|bajar)\b/i.test(value);
  const work = value.length >= 12 || /\b(?:file|code|project|browser|form|email|report|website|app|fayl|kod|loyiha|brauzer|forma|hisobot|sayt|dastur)\b/i.test(value);
  return action && work;
}

// A capability refusal from the action agent is not a completed or verified result.
// Reading it back through Realtime would speak exactly the "I can't; do it manually"
// answer the user must never hear.
function isUnverifiedAgentResult(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  return /\b(?:i (?:can(?:not|'t|’t)|am unable to|could(?: not|n't|n’t))|unable to|cannot directly|can(?:not|'t|’t) directly|do it (?:yourself|manually)|you(?:'ll| will) need to)\b/i.test(value)
    || /\b(?:qila olmayman|bajara olmadim|qo['‘’]?limdan kelmaydi|o['‘’]?zingiz (?:qiling|bajaring))\b/i.test(value)
    || /^(?:error|failed)\b/i.test(value);
}

// Conservative router that runs the most common safe, unambiguous desktop commands
// without waiting for the Realtime model to pick a tool. Commands with context or
// potential for harm ("close", "delete", sending or writing files) are deliberately
// excluded and stay with the agent.
const DIRECT_APP_ALIASES = {
  safari: 'open:safari', chrome: 'open:chrome', xrom: 'open:chrome', telegram: 'open:telegram',
  spotify: 'open:spotify', vscode: 'open:vscode', 'vs code': 'open:vscode', cursor: 'open:cursor',
  claude: 'open:claude', notion: 'open:notion', obsidian: 'open:obsidian', terminal: 'open:terminal',
  finder: 'open:finder', calendar: 'open:calendar', kalendar: 'open:calendar', mail: 'open:mail',
  pochta: 'open:mail', notes: 'open:notes', eslatmalar: 'open:notes', reminders: 'open:reminders',
  music: 'open:music', musiqa: 'open:music', calculator: 'open:calculator', kalkulyator: 'open:calculator',
  settings: 'open:settings', sozlamalar: 'open:settings', photos: 'open:photos', rasmlar: 'open:photos'
};

const DIRECT_WEB_ALIASES = {
  youtube: 'web:youtube', yutub: 'web:youtube', gmail: 'web:gmail', google: 'web:google',
  github: 'web:github', instagram: 'web:instagram', linkedin: 'web:linkedin',
  wikipedia: 'web:wikipedia', chatgpt: 'web:chatgpt', 'google drive': 'web:gdrive',
  'google docs': 'web:gdocs', 'google calendar': 'web:gcalendar', translate: 'web:translate'
};

function normalizeDirectCommand(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’‘`ʻ]/g, "'")
    .replace(/[^a-z0-9à-ž' ]/gi, ' ')
    .replace(/\b(jarvis|jaris|jarus|javis|please|iltimos|marhamat)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchDirectFastAction(text) {
  const value = normalizeDirectCommand(text);
  if (!value || value.length > 80) return null;

  const simple = value.replace(/\b(ni|da|dan)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const openMatch = simple.match(/^(?:(.+?)\s+(?:ni\s*)?(?:och|ishga tushir)|(?:och|ishga tushir)\s+(.+?))$/i);
  if (openMatch) {
    const target = (openMatch[1] || openMatch[2] || '').replace(/(?:ni)$/i, '').trim();
    if (DIRECT_APP_ALIASES[target]) return DIRECT_APP_ALIASES[target];
    if (DIRECT_WEB_ALIASES[target]) return DIRECT_WEB_ALIASES[target];
  }

  const englishOpen = value.match(/^(?:open|launch|start) (.+)$/i);
  if (englishOpen) {
    const target = englishOpen[1].replace(/\b(?:app|application|website|site)\b/g, '').trim();
    if (DIRECT_APP_ALIASES[target]) return DIRECT_APP_ALIASES[target];
    if (DIRECT_WEB_ALIASES[target]) return DIRECT_WEB_ALIASES[target];
  }

  const volMatch = value.match(/^(?:(?:(?:set|turn|change|put)\s+)?(?:the\s+|a\s+)?(?:system\s+)?volume\s+(?:to\s+)?(\d+)(?:\s*(?:percent|%))?|(\d+)\s*(?:percent|%)\s+volume|(?:ovoz|ovozni)\s*(?:darajasini\s*)?(\d+)(?:\s*(?:foiz|%|ga|ta))?(?:\s*(?:qil|qo['']y|sozla|tushir|ko['']tar))?)$/i);
  if (volMatch) {
    const level = Math.min(100, Math.max(0, parseInt(volMatch[1] || volMatch[2] || volMatch[3], 10)));
    return `volume:${level}`;
  }

  if (/^(?:ovoz|volume)(?:ni)?\s+(?:balandlat|ko'tar|oshir)$/.test(value)) return 'volume:up';
  if (/^(?:ovoz|volume)(?:ni)?\s+(?:pasaytir|kamaytir)$/.test(value)) return 'volume:down';
  if (/^(?:(?:ovoz|volume)(?:ni)?\s+(?:o'chir|ochir|mute)|mute)$/.test(value)) return 'volume:mute';
  if (/^(?:(?:ovoz|volume)(?:ni)?\s+(?:yoq|qaytar|unmute)|unmute)$/.test(value)) return 'volume:unmute';
  if (/^(?:max volume|volume max|maximum volume|ovozni maksimal qil)$/.test(value)) return 'volume:max';
  if (/^(?:min volume|volume min|minimum volume|ovozni minimal qil)$/.test(value)) return 'volume:min';

  if (/^(?:soat|vaqt)(?:\s+nechchi|\s+necha|ni ayt)?$/.test(value)) return 'info:time';
  if (/^(?:bugun(?:gi)?\s+)?sana(?:\s+nima|ni ayt)?$/.test(value)) return 'info:date';
  if (/^(?:batareya|batareya darajasi)(?:\s+qancha|ni ayt)?$/.test(value)) return 'info:battery';
  if (/^(?:wifi|wi fi)(?:\s+nomi|\s+qaysi)?$/.test(value)) return 'info:wifi';
  if (/^(?:skrinshot|screenshot)(?:\s+ol|\s+qil)?$/.test(value)) return 'screenshot:full';
  if (/^(?:what(?:'s| is) the time|what time is it|tell me the time|time)$/.test(value)) return 'info:time';
  if (/^(?:what(?:'s| is) the date|what date is it|tell me the date|date)$/.test(value)) return 'info:date';
  if (/^(?:what(?:'s| is) the battery(?: level)?|battery(?: level)?)$/.test(value)) return 'info:battery';
  if (/^(?:take (?:a )?screenshot|capture (?:the )?screen)$/.test(value)) return 'screenshot:full';
  if (/^(?:turn (?:the )?volume up|increase (?:the )?volume)$/.test(value)) return 'volume:up';
  if (/^(?:turn (?:the )?volume down|decrease (?:the )?volume)$/.test(value)) return 'volume:down';
  if (/^(?:mute|mute (?:the )?(?:audio|volume))$/.test(value)) return 'volume:mute';
  if (/^(?:unmute|unmute (?:the )?(?:audio|volume))$/.test(value)) return 'volume:unmute';

  if (/^(?:musiqa|music|spotify)(?:ni)?\s+(?:to'xtat|pauza qil)$/.test(value)) return 'media:spotify_stop';
  if (/^(?:keyingi|navbatdagi)\s+(?:qo'shiq|musiqa)$/.test(value)) return 'media:spotify_next';
  if (/^(?:oldingi)\s+(?:qo'shiq|musiqa)$/.test(value)) return 'media:spotify_prev';

  if (/^(?:combat mode|protocol combat|protocol alpha|jang rejimi)$/i.test(value)) return 'protocol:combat';
  if (/^(?:standby mode|normal mode|protocol normal|oddiy rejim)$/i.test(value)) return 'protocol:standby';
  if (/^(?:lock(?:down)?(?: protocol)?|lock the system|tizimni qulfla|ekranni qulfla)$/i.test(value)) return 'protocol:lockdown';
  if (/^(?:focus mode|protocol focus|fokus rejimi)$/i.test(value)) return 'protocol:focus';

  if (/^(?:bugungi\s+)?vazifalar(?:im)?(?:\s+nimalar|\s+ro'yxati|\s+qanday)?$/i.test(value)) return 'tasks:list';
  if (/^(?:what(?:'s| are) my tasks|list (?:my )?tasks|tasks)$/i.test(value)) return 'tasks:list';
  if (/^(?:kunlik\s+)?vazifalar(?:ni)?\s+(?:ayt|ko'rsat|o'qi)$/i.test(value)) return 'tasks:list';

  if (/^(?:git\s+status|git\s+holati|git(?:da)?\s+nima\s+o'zgardi|git\s+tekshir)$/i.test(value)) return 'dev:git_status';
  if (/^(?:dasturlash\s+muhiti|kod\s+yozish\s+rejimi|start\s+coding|coding\s+mode|workspace\s+coding)$/i.test(value)) return 'workspace:coding';

  const startWorkMatch = value.match(/^(?:let['']?s\s+start\s+(?:the\s+)?work|start\s+(?:the\s+)?work|start\s+working|ishni\s+boshlaymiz|ishga\s+kirishamiz|ish\s+rejimini\s+yoq|work\s+mode)(?:\s+(?:on\s+)?(.+))?$/i);
  if (startWorkMatch) {
    const targetProj = (startWorkMatch[1] || '').trim();
    return targetProj ? `workspace:start_work:${targetProj}` : 'workspace:start_work';
  }

  const openProjMatch = value.match(/^(?:open\s+project|loyihani\s+och|proyektni\s+och|project\s+och)\s+(.+)$/i);
  if (openProjMatch) {
    const targetProj = openProjMatch[1].trim();
    return `workspace:open_project:${targetProj}`;
  }

  if (/^(?:tizim\s+holati|diagnostika|system\s+diagnostics|system\s+health)$/i.test(value)) return 'info:diagnostics';

  return null;
}

async function collectGrounding(query, options = {}) {
  const blocks = [];
  try {
    const screen = require('../screen-monitor').loadState();
    if (screen.lastSummary) {
      const ageMinutes = screen.lastTrigger ? Math.max(0, Math.round((Date.now() - screen.lastTrigger) / 60000)) : null;
      blocks.push('LATEST SCREEN OBSERVATION' + (ageMinutes === null ? '' : ' (' + ageMinutes + ' minutes ago)') + ':\n' +
        String(screen.lastSummary).replace(/\s+/g, ' ').slice(0, 2400));
    }
  } catch (e) {}
  try {
    const mac = require('../../core/macos-context').collectMacOSContext();
    const current = [mac?.app, mac?.window?.title, mac?.browser?.title, mac?.browser?.url].filter(Boolean).join(' | ');
    if (current) blocks.push('JORIY MACOS KONTEKSTI:\n' + current.slice(0, 900));
  } catch (e) {}
  const memory = options.memory || require('../memory');
  const memoryBlocks = [];
  const profileIntent = /\b(men haqimda|profil|odatim|yoqtir|afzal ko'r|afzal kor|nimalarni esla|meni esla)\b/i.test(String(query || ''));
  if (profileIntent) {
    try {
      const profile = String(memory.readProfile() || '').trim();
      if (profile) memoryBlocks.push('USER PROFILE:\n' + profile.replace(/\s+/g, ' ').slice(0, 2400));
    } catch (e) {}
  }
  try {
    const result = await memory.semanticSearch(query, 6);
    if (result.status === 'ok' && Array.isArray(result.results) && result.results.length) {
      memoryBlocks.push('SEMANTIK MOS YOZUVLAR:\n' + result.results.map(item =>
        '[' + item.date + ' ' + item.time + '] ' + item.topic + ': ' +
        String(item.snippet || '').replace(/\s+/g, ' ').slice(0, 650)
      ).join('\n---\n'));
    }
  } catch (e) {}
  if (!memoryBlocks.some(block => block.startsWith('SEMANTIK'))) {
    try {
      const terms = String(query || '').toLocaleLowerCase('uz-UZ').split(/[^\p{L}\p{N}.-]+/u)
        .filter(term => term.length > 3 && !/^(haqida|qanday|nima|nimalarni|qaysi|uchun|bilan|eslaysan|xotiradan)$/.test(term))
        .slice(0, 5);
      const found = [];
      const seen = new Set();
      for (const term of terms) {
        const result = memory.searchMemory(term, 3);
        for (const item of [...(result.results || []), ...(result.structured || [])]) {
          const key = item.id || item.file || JSON.stringify(item);
          if (!seen.has(key)) { seen.add(key); found.push(item); }
          if (found.length >= 6) break;
        }
        if (found.length >= 6) break;
      }
      if (found.length) memoryBlocks.push('MATCHING ENTRIES FROM LOCAL SEARCH:\n' + found.map(item => {
        if (item.matches) return '[' + (item.date || item.file) + '] ' + item.matches.map(match => match.text).join(' | ');
        return '[' + (item.layer || 'xotira') + '] ' + (item.title || '') + ': ' + String(item.content || '').slice(0, 650);
      }).join('\n---\n'));
    } catch (e) {}
  }
  blocks.push('OBSIDIAN MEMORY STATUS:\n' + (memoryBlocks.length
    ? 'Search completed successfully. Use the entries below:\n' + memoryBlocks.join('\n\n')
    : 'Search completed, but no entry matches the question. Do not say memory is unavailable; say no matching entry was found.'));
  return blocks.join('\n\n').slice(0, 7500);
}

class RealtimeSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.playProc = null;
    this.assistantSpeaking = false;
    this._speakEndedAt = 0;
    this._playbackUntil = 0;
    this._lastAudioQueuedAt = 0;
    this._bargeInEvidenceAt = 0;
    this._bargeInCandidate = [];
    this._bargeInCandidateMs = 0;
    this._bargeInGapMs = 0;
    this._bargeInConfirmed = false;
    this._externalPlaybackCancelled = false;
    this.userTranscript = '';
    this.assistantTranscript = '';
    this._lastAssistantTranscript = '';
    this._suppressCurrentResponse = false;
    this._spec = null;
    this._serverSpeechOpen = false;
    this._wakeRequired = Boolean(options.wakeRequired);
    this._autoResponseOn = !this._wakeRequired;
    this._idlePreroll = [];
    this._idlePrerollBytes = 0;
    this._idleHangMs = 0;
    this._idleFloor = 60;
    this._wakeSyncTimer = this._wakeRequired ? setInterval(() => this._syncAutoResponse(), 3000) : null;
    if (this._wakeSyncTimer?.unref) this._wakeSyncTimer.unref();
    this._dropStaleAudio = false;
    this._duck = null;
    this._quietUntil = 0;
    this._nativeAec = false;
    this._nativePreRoll = [];
    this._nativePreRollBytes = 0;
    this._noBargeInUntil = 0;
    this._gateStats = { sent: 0, dropped: 0, maxResidual: 0, since: Date.now() };
    this._trailingSilenceMs = 0;
    this._specClearing = false;
    this._specQueue = [];
    this._specTimer = null;
    this._specClearTimer = null;
    this._firstTextObserved = false;
    this._firstAudioObserved = false;
    this._playbackStartedForTurn = false;
    this._pendingFnArgs = {};
    this.provider = null;
    this._providerIndex = -1;
    this._connecting = false;
    this._mediaModeActive = false;
    // An Fn hands-free conversation by itself confirms the user is addressing
    // JARVIS for the whole session. Follow-up turns need no language marker even
    // while media is playing; echo/noise/ack filters still apply. A wake-word
    // trigger, as before, only grants a one-time bypass for the first meaningful turn.
    this._explicitUserSession = Boolean(options.explicitUserSession);
    this._explicitUserTurnPending = Boolean(options.explicitUserTrigger);
    this._addressedWakePending = Boolean(options.addressedWakeTrigger);
    this._wakeRequiredOption = Boolean(options.wakeRequired);
    this._initialTranscript = String(options.initialTranscript || '').trim();
    // Native Realtime transcription is accepted immediately. The legacy
    // authoritative hook remains injectable only for isolated recovery tests;
    // production no longer supplies it or waits on a second STT call.
    this._authoritativeTranscribe = typeof options.authoritativeTranscribe === 'function'
      ? options.authoritativeTranscribe : null;
    this._requireAuthoritativeFirstTurn = Boolean(options.requireAuthoritativeFirstTurn);
    this._sttPreRoll = [];
    this._sttPreRollBytes = 0;
    this._sttTurn = null;
    this._pendingAuthoritativeTurn = null;
    this._groundingProvider = typeof options.groundingProvider === 'function'
      ? options.groundingProvider : collectGrounding;
    this._expertAnswer = typeof options.expertAnswer === 'function'
      ? options.expertAnswer : askExpert;
    // Optional fallback synthesizer for tests/special deployments. Production
    // English speech stays on one Realtime voice to minimize response latency.
    this._speakText = typeof options.speakText === 'function'
      ? options.speakText : null;
    this._undoStack = options.undoStack || sharedUndo;
    this._closeApp = typeof options.closeApp === 'function' ? options.closeApp : name => require('../../core/app-actions').closeApp(name);
    this._webOpener = typeof options.webOpener === 'function' ? options.webOpener : args => require('../../core/web-actions').openWeb(args);
    this._fastActionRunner = typeof options.fastActionRunner === 'function'
      ? options.fastActionRunner : require('../fast-actions').runFastAction;
    this._communicationRunner = typeof options.communicationRunner === 'function'
      ? options.communicationRunner
      : intent => require('../communications').searchYouTube(intent.query);
    this._memoryProvider = options.memoryProvider || require('../memory');
    this._missions = options.missions || null;
    this._conversationContext = options.conversationContext || new ConversationContext();
    this._actionSafety = options.actionSafetyPolicy || new ActionSafetyPolicy({
      confirmationTtlMs: options.actionConfirmationTtlMs,
      fullAutonomyProvider: options.fullAutonomyProvider
    });
    this._auditHighRiskCompletion = options.auditHighRiskCompletion || recordHighRiskCompletion;
    this._pendingConfirmedAction = null;
    this._groundedTurnSerial = 0;
    // Grounded/reasoning worker never owns the live voice turn. It prepares a
    // verified follow-up while Realtime keeps the conversation responsive.
    this._backgroundResearch = null;
    this._backgroundTaskResults = [];
    this._backgroundAgentRunner = typeof options.backgroundAgentRunner === 'function'
      ? options.backgroundAgentRunner
      : (description, sessionKey, onProgress) => VOICE_AGENT_BRIDGE.askAgent(description +
        '\n\nReturn the final result as one JSON object only: {"status":"completed|failed|blocked","actions":[{"description":"...","status":"completed|failed|skipped"}],"verification":{"passed":true|false,"method":"..."},"evidence":[{"type":"accessibility|dom|api-response|command-exit|file-stat|process-state|screenshot|test-report","value":"concrete observed value","exitCode":0}],"summary":"brief user-facing result","error":null}. Set verification.passed=true only after independently observing the requested end state. Plain claims and text-only evidence are not verification.', sessionKey, {
        source: 'voice-background-agent', persistent: true, onProgress, onLongRunning: onProgress
      });
    this._actionResultVerifier = typeof options.actionResultVerifier === 'function' ? options.actionResultVerifier : verifyActionResult;
    this._actionFailureCorpus = options.actionFailureCorpus || new ActionFailureCorpus({
      file: process.env.JARVIS_TEST === '1' ? null : path.join(PROJECT_DIR, '.run', 'action-failures.json')
    });
    this._realtimeResponseActive = false;
    this._recentConversation = [];
    // run_task processes currently running (call_id -> {proc, description}).
    // Needed for two things: (1) stopping them when the user says "stop", and
    // (2) cleaning up leftovers when the conversation ends; they used to keep
    // running in the background after the conversation closed.
    this._runningTasks = new Map();
    this.duplex = new DuplexVoiceEngine({
      sampleRate: OUT_RATE, echoThreshold: DUPLEX_ECHO_THRESHOLD,
      bargeInResidual: DUPLEX_BARGE_IN_RMS, noiseFloor: DUPLEX_NOISE_FLOOR,
      noiseMultiplier: DUPLEX_NOISE_MULTIPLIER, hangoverMs: NORMAL_DUPLEX_HANGOVER_MS,
      maxEchoLagMs: DUPLEX_MAX_ECHO_LAG_MS,
      maxGain: REALTIME_INPUT_GAIN
    });
  }

  // Stops running tasks and returns how many were stopped.
  cancelRunningTasks() {
    let n = 0;
    for (const [, t] of this._runningTasks) {
      if (t.background) continue;
      try { t.proc._jarvisCancelled = true; t.proc.kill('SIGTERM'); n++; } catch (e) {}
    }
    for (const [id, task] of this._runningTasks) if (!task.background) this._runningTasks.delete(id);
    return n;
  }

  connect() {
    if (!VOICE_PROVIDERS.length) {
      this.emit('error', new Error('No realtime voice provider configured (GEMINI_API_KEY, AZURE_VOICELIVE_* or AZURE_REALTIME_*)'));
      return;
    }
    this._startPlayback();
    this._connectProvider(0);
  }

  _connectProvider(index) {
    const provider = VOICE_PROVIDERS[index];
    if (!provider || this.closed) {
      this._connecting = false;
      this.emit('error', new Error('All realtime voice providers failed'));
      return;
    }
    this._providerIndex = index;
    this.provider = provider;
    this._connecting = true;
    const socket = typeof provider.createSocket === 'function'
      ? provider.createSocket()
      : new WebSocketClient(provider.url, { headers: provider.headers, handshakeTimeout: 10000 });
    this.ws = socket;

    // If the previous (now finished) conversation started video or music that is
    // not stale yet, the NEW conversation also starts with the higher threshold;
    // see the note on MEDIA_STATE_FILE.
    const startMediaAware = this._mediaModeActive;
    isMediaRecentlyLikelyPlaying().then(playing => {
      if (playing === true && !this.closed) this._setMediaLikelyPlaying();
    }).catch(() => {});
    // The file state can be stale, or the user may have opened a video themselves.
    // Check the system signal in parallel without delaying the connection.
    checkSystemAudioPlaying().then(playing => {
      if (playing === true && !this.closed) this._setMediaLikelyPlaying();
    }).catch(() => {});

    this.ws.addEventListener('open', () => {
      this._connecting = false;
      this.ws.send(JSON.stringify(buildSessionUpdate(provider, {
        startMediaAware: this._mediaModeActive,
        speculative: SPECULATIVE_RESPONSE && !this._authoritativeTranscribe && !this._wakeRequired,
        instructions: loadInstructions(),
        tools: buildTools()
      })));
    });

    this.ws.addEventListener('message', (ev) => this._onMessage(ev));
    this.ws.addEventListener('error', (ev) => {
      if (this.ws !== socket) return;
      // Node's ErrorEvent .message/.error properties are often non-enumerable, so
      // JSON.stringify(ev) just produced "{}" and showed nothing. Read the
      // properties directly.
      const reason = ev?.error?.message || ev?.message || ev?.error?.code || ev?.type || 'unknown (possibly a ws close race)';
      if (!this.ready && index + 1 < VOICE_PROVIDERS.length) {
        this.emit('telemetry', 'provider.fallback', { from: provider.id, to: VOICE_PROVIDERS[index + 1].id, reason });
        try { this.ws.close(); } catch (_) {}
        this._connectProvider(index + 1);
        return;
      }
      this.emit('error', new Error(provider.id + ' WebSocket error: ' + reason));
    });
    this.ws.addEventListener('close', () => {
      if (this.ws !== socket) return;
      this.closed = true;
      this.cancelRunningTasks();
      this._stopPlayback();
      this.emit('close');
    });
  }

  _onMessage(ev) {
    if (this.closed) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }

    switch (msg.type) {
      case 'session.updated':
        if (!this.ready) {
          this.ready = true;
          this.emit('provider', { id: this.provider?.id || 'unknown' });
          this.emit('ready');
          if (this._initialTranscript) {
            const initial = this._initialTranscript;
            this._initialTranscript = '';
            this._acceptTranscript(initial, { source: 'wake-stt', replaceAudioItem: true });
          }
        }
        break;
      case 'input_audio_buffer.speech_started':
        // The server is never allowed to interrupt on its own: if room echo passes
        // server VAD, a finished answer must not be cut mid-way. Barge in manually
        // only when the local duplex gate recently confirmed audio strong enough
        // not to be echo residue.
        const confirmedBargeIn = this.assistantSpeaking &&
          Date.now() - this._bargeInEvidenceAt <= 1200;
        if (confirmedBargeIn && !this._responseInterrupted && !this._duck) {
          this._beginDuck();
          this.emit('telemetry', 'barge_in.confirmed', {});
        } else if (confirmedBargeIn) {
          // The local duplex gate already cut playback. Accept the provider VAD
          // lifecycle event, but do not repeat response.cancel/flush and race a
          // new playback process.
          this.emit('telemetry', 'barge_in.provider_acknowledged', {});
        } else if (this.assistantSpeaking) {
          this.emit('telemetry', 'barge_in.ignored', { reason: 'no-local-speech-evidence' });
        }
        if (this._authoritativeTranscribe) {
          this._sttTurn = { chunks: this._sttPreRoll.splice(0), bytes: this._sttPreRollBytes };
          this._sttPreRollBytes = 0;
        }
        this._serverSpeechOpen = true;
        this._trailingSilenceMs = 0;
        this.emit('user_speaking');
        this.emit('telemetry', 'vad.speech_started', {});
        break;
      case 'input_audio_buffer.speech_stopped':
        this._serverSpeechOpen = false;
        this.emit('telemetry', 'vad.speech_stopped', {});
        this._beginSpeculative();
        if (this._authoritativeTranscribe && this._sttTurn) {
          this._beginAuthoritativeTranscription(this._sttTurn);
          this._sttTurn = null;
        }
        this.emit('user_speech_stopped');
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        if (this._authoritativeTranscribe && this._pendingAuthoritativeTurn) {
          const pending = this._pendingAuthoritativeTurn;
          pending.native = {
            text: msg.transcript || '',
            itemId: msg.item_id || msg.item?.id || ''
          };
          // Start immediately, without waiting for the authoritative Azure STT, when the
          // native transcript is accurate ENOUGH or the conservative local fast-action
          // matcher finds one unambiguous command.
          // The second condition targets natural two-token Uzbek commands such as "Safari och" or
          // "soat nechchi"; free-form short phrases do not pass it and still wait for uz-UZ STT.
          const nativeFastAction = matchDirectFastAction(pending.native.text);
          if (!pending.settled && !pending.requireAuthoritative && (nativeIsConfident(pending.native.text) || nativeFastAction)) {
            pending.settled = true;
            clearTimeout(pending.timer);
            this._pendingAuthoritativeTurn = null;
            const latencyMs = Date.now() - pending.startedAt;
            this.emit('telemetry', 'stt.native-fast-path', {
              durationMs: latencyMs,
              reason: nativeFastAction ? 'direct-fast-action' : 'high-confidence'
            });
            this._acceptTranscript(pending.native.text, { source: 'native-fast-path', sttLatencyMs: latencyMs });
          } else {
            this._finalizeAuthoritativeTurn();
          }
        } else {
          this._acceptTranscript(msg.transcript || '', { itemId: msg.item_id || msg.item?.id || '' });
        }
        break;
      }
      case 'response.created':
        this._responseInterrupted = false;
        this._dropStaleAudio = false;
        this._realtimeResponseActive = true;
        this._onSpeculativeResponseCreated();
        this.emit('telemetry', 'provider.response.created', {
          responseId: msg.response?.id || msg.response_id || null
        });
        break;
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta':
        if (!this._firstTextObserved && msg.delta) {
          this._firstTextObserved = true;
          this.emit('telemetry', 'assistant.text.first', {});
        }
        this.assistantTranscript += msg.delta || '';
        if (!this._suppressCurrentResponse && isRepeatedResponse(this.assistantTranscript, this._lastAssistantTranscript)) {
          this._suppressCurrentResponse = true;
          this.emit('turn_suppressed', 'duplicate-response', this.assistantTranscript);
          try { this.ws.send(JSON.stringify({ type: 'response.cancel' })); } catch (e) {}
          this._flushPlayback();
        }
        break;
      case 'response.audio.delta':
      case 'response.output_audio.delta':
        if (this._suppressCurrentResponse) break;
        // Late audio chunks of a reply cancelled by barge-in must not re-enable the speaking state.
        if (this._dropStaleAudio) break;
        if (this._spec?.state === 'held') { this._spec.held.push(msg.delta); break; }
        if (!this._firstAudioObserved) {
          this._firstAudioObserved = true;
          this.emit('telemetry', 'assistant.audio.first', {});
        }
        this.assistantSpeaking = true;
        this._syncAutoResponse();
        this._playChunk(Buffer.from(msg.delta, 'base64'));
        break;
      case 'response.function_call_arguments.delta':
        this._pendingFnArgs[msg.call_id] = (this._pendingFnArgs[msg.call_id] || '') + (msg.delta || '');
        break;
      case 'response.function_call_arguments.done':
        // Some Realtime versions send no full `arguments` in the `done` event, only
        // the earlier deltas. Without attaching the accumulated copy as a fallback,
        // the tool would run with empty parameters.
        if (!msg.arguments && this._pendingFnArgs[msg.call_id]) {
          msg.arguments = this._pendingFnArgs[msg.call_id];
        }
        delete this._pendingFnArgs[msg.call_id];
        if (this._suppressCurrentResponse && this._spec && ['cleared', 'discarded'].includes(this._spec.state)) break;
        if (this._spec?.state === 'held') { this._spec.calls.push(msg); break; }
        this._handleFunctionCall(msg);
        break;
      case 'response.done': {
        const responseStatus = msg.response?.status || 'unknown';
        const responseReason = msg.response?.status_details?.reason || '';
        const interrupted = this._responseInterrupted === true;
        // If a short reply never reached the prebuffer threshold, flush the remaining
        // PCM to the speaker as soon as the server ends the stream.
        this.playbackBuffer?.finish();
        // The next response must build its own jitter buffer again. This does not
        // touch audio already written into sox.
        this.playbackBuffer?.reset();
        this.assistantSpeaking = false;
        this._syncAutoResponse();
        this._resetBargeInCandidate();
        // response.done means the server finished sending; the speaker may still be
        // playing queued PCM. feedAudio() also checks _playbackUntil, so JARVIS does
        // not hear the rest of its own voice as the user.
        this._speakEndedAt = Math.max(Date.now(), this._playbackUntil);
        this.emit('telemetry', 'response.done', {
          status: responseStatus,
          reason: responseReason,
          audioQueuedUntilMs: Math.max(0, this._playbackUntil - Date.now())
        });
        this.emit('response_status', {
          status: responseStatus,
          reason: responseReason,
          interrupted,
          hasAssistantTranscript: Boolean(this.assistantTranscript.trim())
        });
        if (!this._suppressCurrentResponse && this.assistantTranscript.trim() && this._spec?.state === 'held') {
          this._spec.doneInfo = { transcript: this.assistantTranscript.trim(), status: responseStatus, reason: responseReason };
        } else if (!this._suppressCurrentResponse && this.assistantTranscript.trim()) {
          this.emit('assistant_transcript', this.assistantTranscript.trim(), {
            status: responseStatus,
            reason: responseReason
          });
          this._lastAssistantTranscript = this.assistantTranscript.trim();
          this._rememberConversationTurn('Jarvis', this.assistantTranscript.trim());
        }
        this.assistantTranscript = '';
        this._suppressCurrentResponse = false;
        this._realtimeResponseActive = false;
        this._onSpeculativeResponseDone();
        // During barge-in, a cancelled response.done can arrive after the new speech
        // turn has opened. A status-less event would falsely mark that new turn
        // completed in the daemon.
        this.emit('turn_done', { status: responseStatus, reason: responseReason, interrupted });
        this._deliverReadyBackgroundResearch();
        this._deliverReadyBackgroundWork();
        this._responseInterrupted = false;
        break;
        }
      case 'error': {
        const errMsg = msg.error?.message || JSON.stringify(msg);
        if (!this.ready && this._providerIndex + 1 < VOICE_PROVIDERS.length) {
          const failedProvider = this.provider?.id || 'unknown';
          const nextIndex = this._providerIndex + 1;
          this.emit('telemetry', 'provider.fallback', {
            from: failedProvider, to: VOICE_PROVIDERS[nextIndex].id, reason: errMsg
          });
          const failedSocket = this.ws;
          this._connectProvider(nextIndex);
          try { failedSocket.close(); } catch (_) {}
          break;
        }
        // These are not real errors: cancelling exactly as a reply finishes, or two
        // responses requested at once, are natural races in the Realtime API.
        // They are skipped silently to keep the console clean.
        const benign = /no active response|already has an active response|already active|already cancelled|cannot cancel/i.test(errMsg);
        if (!benign) this.emit('error', new Error(errMsg));
        break;
      }
    }
  }

  _correctTranscript(text) {
    return String(text || '').trim().replace(/\s+/g, ' ');
  }

  _rememberConversationTurn(role, text) {
    const clean = String(text || '').trim().replace(/\s+/g, ' ');
    if (!clean) return;
    this._recentConversation.push({ role, text: clean.slice(0, 500) });
    if (this._recentConversation.length > 6) this._recentConversation.splice(0, this._recentConversation.length - 6);
    this._conversationContext.observe(role, clean);
  }

  _questionWithRecentContext(question) {
    const previous = this._recentConversation.slice(0, -1);
    if (!previous.length) return question;
    return 'Recent conversation:\n' + previous.map(turn => turn.role + ': ' + turn.text).join('\n') +
      '\n\nCurrent question: ' + question;
  }

  _acceptTranscript(text, options = {}) {
    this.userTranscript = this._correctTranscript(text);
    if (this._addressedWakePending) {
      const addressed = require('../../core/wake-word-policy').extractAddressedCommand(this.userTranscript);
      if (addressed) this.userTranscript = addressed.command;
      this._addressedWakePending = false;
      if (!this.userTranscript) {
        this._discardSpeculative();
        if (this._duck) this._resumeBargeIn('wake-only');
        this.emit('turn_suppressed', 'wake-only', text);
        return false;
      }
    }
    // Always-listening: outside the conversation window only speech that starts or ends with "Jarvis" is accepted.
    // Other room talk is silently dropped and also deleted from the server-side conversation context (privacy).
    if (this._wakeRequired && !this._explicitUserSession && !this._conversationContext.isActive()) {
      const addressed = require('../../core/wake-word-policy').extractAddressedCommand(this.userTranscript);
      if (!addressed) {
        this._discardSpeculative();
        this._deleteItem(options.itemId);
        this.emit('turn_suppressed', 'no-wake', '');
        this.userTranscript = '';
        return false;
      }
      this.userTranscript = addressed.command;
      if (!this.userTranscript) {
        this._discardSpeculative();
        this._deleteItem(options.itemId);
        this._conversationContext.touch();
        this._syncAutoResponse();
        this.emit('turn_suppressed', 'wake-only', '');
        return false;
      }
      this._conversationContext.touch();
    }
    const confirmation = this._actionSafety.handleUtterance(this.userTranscript);
    if (confirmation.matched) {
      this._discardSpeculative();
      if (this._duck) this._commitBargeIn('confirmation');
      const pending = this._pendingConfirmedAction;
      this._pendingConfirmedAction = null;
      this.emit('user_transcript', this.userTranscript);
      this._rememberConversationTurn('User', this.userTranscript);
      this.emit('telemetry', confirmation.confirmed ? 'safety.confirmed' : 'safety.rejected', {});
      if (confirmation.confirmed && pending) pending();
      else this._deliverSpokenAnswer('Cancelled.');
      return true;
    }
    // "Boldi", "kerak emas", "aha okay okay", "stop": if JARVIS is speaking, stop and listen again (no reply).
    if (this._isSpeakingNow() && isStopIntent(this.userTranscript)) {
      this._stopSpeakingByUser('stop-command');
      this.emit('turn_suppressed', 'stop-command', this.userTranscript);
      this.userTranscript = '';
      return false;
    }
    const policy = classifyUserTurn(this.userTranscript, {
      lastAssistant: this._lastAssistantTranscript,
      mediaMode: this._mediaModeActive,
      explicitUserTrigger: this._explicitUserSession || this._explicitUserTurnPending,
      conversationActive: this._conversationContext.isActive()
    });
    if (!policy.accept) {
      this.emit('turn_suppressed', policy.reason, this.userTranscript);
      // If it was paused by echo or a meaningless utterance, JARVIS resumes its reply.
      if (this._duck) this._resumeBargeIn(policy.reason);
      const speculativeInFlight = Boolean(this._spec && ['expected', 'held'].includes(this._spec.state));
      this._discardSpeculative();
      // A rejected turn (echo/noise) must not cancel the real answer JARVIS is speaking
      // or cut playback; exactly that caused stuttering and mid-sentence cuts.
      if (!speculativeInFlight && !this.assistantSpeaking) {
        try { this.ws.send(JSON.stringify({ type: 'response.cancel' })); } catch (e) {}
        this._flushPlayback();
      }
      this.userTranscript = '';
      return false;
    }

    // Genuine user speech: now cancel the paused reply completely.
    if (this._duck) this._commitBargeIn('accepted');
    this._explicitUserTurnPending = false;
    this._firstTextObserved = false;
    this._firstAudioObserved = false;
    this._playbackStartedForTurn = false;

    this.emit('telemetry', 'stt.final', {
      transcript: this.userTranscript,
      authoritative: Boolean(options.replaceAudioItem),
      source: options.source || (options.replaceAudioItem ? 'authoritative' : 'native'),
      sttLatencyMs: options.sttLatencyMs
    });

    if (options.replaceAudioItem) {
      if (options.itemId) {
        try { this.ws.send(JSON.stringify({ type: 'conversation.item.delete', item_id: options.itemId })); } catch (e) {}
      }
      try {
        this.ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message', role: 'user',
            content: [{ type: 'input_text', text: this.userTranscript }]
          }
        }));
      } catch (e) {}
    }

    this.emit('user_transcript', this.userTranscript);
    this._rememberConversationTurn('User', this.userTranscript);
    // Any newly accepted turn makes the previous grounded answer still being
    // prepared in the background stale. Otherwise, after the user moved on, the
    // old answer could suddenly be spoken.
    const turnSerial = ++this._groundedTurnSerial;
    const communicationIntent = require('../communications').parseCommunicationIntent(this.userTranscript);
    if (communicationIntent?.kind === 'youtube-search') {
      this._discardSpeculative();
      this.emit('telemetry', 'router.decision', { route: 'direct-communication', action: communicationIntent.kind });
      this._runCommunicationIntent(communicationIntent);
      return true;
    }
    const directAction = matchDirectFastAction(this.userTranscript);
    if (directAction) {
      this._discardSpeculative();
      this.emit('telemetry', 'router.decision', { route: 'direct-fast-action', action: directAction });
      this._runDirectFastAction(directAction);
      return true;
    }
    if (needsBackgroundAgentTask(this.userTranscript)) {
      this._discardSpeculative();
      const authorization = this._actionSafety.authorize({ kind: 'task', description: this.userTranscript });
      if (!authorization.allowed) {
        this._pendingConfirmedAction = () => this._startBackgroundAgentTask(this.userTranscript);
        this.emit('telemetry', 'safety.confirmation_required', { risk: authorization.assessment.risk, kind: 'task' });
        this._deliverSpokenAnswer(confirmationPrompt(this.userTranscript, authorization.assessment));
        return true;
      }
      this.emit('telemetry', 'router.decision', { route: 'realtime-with-background-agent' });
      // Do not let the speech model improvise an acknowledgement here. In
      // production it sometimes ignored the acknowledgement instruction and
      // said "I can't; do it manually" while the real agent was already
      // working. Stay silent and speak only the agent's verified result.
      this._startBackgroundAgentTask(this.userTranscript, authorization.assessment);
      return true;
    }
    const reference = this._conversationContext.resolve(this.userTranscript);
    // Live voice must never wait for memory/reasoning. Realtime answers the
    // user immediately; a grounded worker verifies the context in parallel
    // and can provide a follow-up after the current spoken turn is complete.
    if (needsContextGrounding(this.userTranscript) || reference.resolved) {
      this.emit('telemetry', 'router.decision', { route: 'realtime-with-background-grounding' });
      if (!this._adoptSpeculative(options)) this._respondWithRealtimeConversation();
      this._startBackgroundGrounding(this.userTranscript, turnSerial);
      return true;
    }
    // Keep conversation and tool selection inside the same Realtime session.
    // This preserves run_task for complex computer work without another model
    // or TTS round-trip; deterministic fast actions/Astra routes run above.
    this.emit('telemetry', 'router.decision', { route: 'realtime-conversation' });
    if (!this._adoptSpeculative(options)) this._respondWithRealtimeConversation();
    return true;
  }

  _respondWithRealtimeConversation() {
    return this._sendResponseCreate({
      max_output_tokens: REALTIME_MAX_RESPONSE_TOKENS,
      tool_choice: 'auto'
    });
  }

  _startBackgroundAgentTask(description, assessment) {
    const callId = 'background-agent-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const sessionKey = 'agent:main:voice-background-' + callId;
    this.emit('tool_call', 'background_agent: ' + description, callId);
    this.emit('telemetry', 'background_agent.started', { callId, persistent: true });
    Promise.resolve()
      .then(() => this._backgroundAgentRunner(description, sessionKey, text => {
        this.emit('telemetry', 'background_agent.progress', { callId, progress: String(text || '').slice(0, 500) });
      }, { persistent: true }))
      .then(async result => {
        const verified = this._actionResultVerifier(result);
        const output = actionResultText(verified);
        this.emit('tool_result', JSON.stringify(verified), callId);
        if (verified.verification?.passed !== true || isUnverifiedAgentResult(output)) {
          try {
            this._actionFailureCorpus.record({
              kind: 'verifier', input: sanitizeVerifierFailure(verified), expected: false,
              reason: 'background-agent-unverified'
            });
          } catch (_) {}
          this.emit('telemetry', 'background_agent.failed', { callId, reason: 'unverified-result' });
          return;
        }
        if (assessment) await this._auditHighRiskCompletion(assessment, { source: 'voice-background-agent', requestId: callId });
        this.emit('telemetry', 'background_agent.completed', { callId, ok: true });
        this._backgroundTaskResults.push({ answer: output.slice(0, 7000) });
        this._deliverReadyBackgroundWork();
      })
      .catch(error => {
        const output = 'Error: ' + String(error?.message || error || 'background task failed').slice(0, 500);
        this.emit('tool_result', output, callId);
        this.emit('telemetry', 'background_agent.failed', { callId });
      });
  }

  _startBackgroundGrounding(question, serial) {
    const startedAt = Date.now();
    this.emit('context_hydration_started', question);
    Promise.resolve().then(async () => {
      let grounding = '';
      try { grounding = await this._groundingProvider(question); } catch (e) {}
      const continuation = this._conversationContext.grounding(question);
      if (continuation) grounding = continuation + '\n\n' + grounding;
      if (this.closed || serial !== this._groundedTurnSerial) return;

      let answer = '';
      try { answer = await this._expertAnswer(this._questionWithRecentContext(question), 'background-' + Date.now(), grounding); } catch (e) {}
      if (this.closed || serial !== this._groundedTurnSerial) return;
      answer = prepareSpokenAnswer(answer);
      if (!answer) return;
      // A late background answer (measured: 48 s) must not start speaking after the conversation has moved on.
      if (Date.now() - startedAt > GROUNDING_FOLLOWUP_MAX_MS) {
        this.emit('telemetry', 'grounding.follow_up.dropped', { durationMs: Date.now() - startedAt });
        return;
      }
      this._backgroundResearch = { serial, question, answer: answer.slice(0, 7000) };
      this.emit('context_hydration_done', { question, groundingBytes: grounding.length, answer });
      this.emit('telemetry', 'grounding.completed', { durationMs: Date.now() - startedAt, groundingBytes: grounding.length, background: true });
      this._deliverReadyBackgroundResearch();
    }).catch(() => {});
  }

  async _deliverReadyBackgroundResearch() {
    if (Date.now() < this._quietUntil) return;
    const work = this._backgroundResearch;
    if (!work || this.closed || work.serial !== this._groundedTurnSerial || this._realtimeResponseActive || this.assistantSpeaking) return;
    this._backgroundResearch = null;
    this.emit('telemetry', 'grounding.follow_up.delivered', {});
    await this._deliverSpokenAnswer(work.answer);
  }

  async _deliverReadyBackgroundWork() {
    if (Date.now() < this._quietUntil) return;
    if (this.closed || this._realtimeResponseActive || this.assistantSpeaking || !this._backgroundTaskResults.length) return;
    const work = this._backgroundTaskResults.shift();
    await this._deliverSpokenAnswer(work.answer);
    this._deliverReadyBackgroundWork();
  }

  // While speaking, the server must not create responses (room echo must not become a "new turn");
  // while silent it is on, for fast speculative replies.
  _deleteItem(itemId) {
    if (!itemId) return;
    try { this.ws.send(JSON.stringify({ type: 'conversation.item.delete', item_id: itemId })); } catch (e) {}
  }

  // Outside the conversation window, idle time sends only speech to the server (energy + preceding 450 ms + hangover).
  _idleGateActive() {
    return this._wakeRequired && !this._explicitUserSession && !this.assistantSpeaking && !this._duck
      && !this._serverSpeechOpen && !this._conversationContext.isActive();
  }

  _idleGate(audio) {
    const level = rms(audio);
    const chunkMs = audio.length / 48;
    const threshold = Math.max(IDLE_GATE_MIN_RMS, this._idleFloor * 3.5);
    if (level >= threshold) {
      const opening = this._idleHangMs <= 0;
      this._idleHangMs = IDLE_GATE_HANGOVER_MS;
      const lead = opening ? this._idlePreroll.splice(0) : [];
      this._idlePrerollBytes = 0;
      return { send: true, audio: lead.length ? Buffer.concat([...lead, audio]) : audio, reason: 'speech', residualRms: level, correlation: 0, speechThresholdRms: Math.round(threshold) };
    }
    if (this._idleHangMs > 0) {
      this._idleHangMs -= chunkMs;
      return { send: true, audio, reason: 'hangover', residualRms: level, correlation: 0, speechThresholdRms: Math.round(threshold) };
    }
    this._idleFloor = this._idleFloor * 0.97 + Math.min(level, Math.max(this._idleFloor * 2, 80)) * 0.03;
    this._idlePreroll.push(Buffer.from(audio));
    this._idlePrerollBytes += audio.length;
    while (this._idlePrerollBytes > IDLE_GATE_PREROLL_BYTES && this._idlePreroll.length > 1) this._idlePrerollBytes -= this._idlePreroll.shift().length;
    return { send: false, audio, reason: 'idle-quiet', residualRms: level, correlation: 0, speechThresholdRms: Math.round(threshold) };
  }

  _syncAutoResponse() {
    if (!this._speculativeEnabled()) return;
    const want = !this.assistantSpeaking && (!this._wakeRequired || this._explicitUserSession || this._conversationContext.isActive());
    if (this._autoResponseOn === want) return;
    this._autoResponseOn = want;
    try {
      this.ws.send(JSON.stringify({
        type: 'session.update',
        session: { turn_detection: { type: 'server_vad', threshold: NORMAL_VAD_THRESHOLD, silence_duration_ms: NORMAL_VAD_SILENCE_MS, prefix_padding_ms: SESSION_PREFIX_PADDING_MS, create_response: want, interrupt_response: false } }
      }));
    } catch (e) {}
  }

  // Mission tools: file write/read, returning within milliseconds.
  _handleMissionTool(msg) {
    let args = {};
    try { args = JSON.parse(msg.arguments || '{}'); } catch (e) {}
    let output;
    try {
      if (!this._missions) output = 'Missions are not available in this session.';
      else if (msg.name === 'start_mission') output = this._missions.start(String(args.goal || ''), { hours: args.hours });
      else if (msg.name === 'mission_status') output = this._missions.status(args.mission);
      else if (msg.name === 'standing_approval') output = this._standingApproval(args);
      else output = this._missions.control(args.mission, String(args.action || ''), { text: args.text });
    } catch (error) { output = 'Mission error: ' + String(error.message || error).slice(0, 200); }
    this.emit('telemetry', 'mission.tool', { name: msg.name });
    try {
      this.ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: msg.call_id, output: String(output).slice(0, 1500) } }));
      this._sendResponseCreate();
    } catch (e) {}
  }

  // Standing approvals: listing and revoking are immediate; GRANTING happens only after the user says "confirm" aloud (enforced in code).
  _standingApproval(args) {
    if (args.action === 'list') return this._missions.listStanding();
    if (args.action === 'revoke') return this._missions.revokeStanding(args.id);
    const scopes = (Array.isArray(args.scopes) ? args.scopes : []).filter(scope => this._missions.standingScopes.includes(scope));
    if (!scopes.length) return 'Say which kind of permission: job applications, recruiter messages or external messages.';
    const perDay = Number(args.per_day) || 10;
    const days = Number(args.days) || 7;
    const summary = `Grant standing permission: ${scopes.join(', ')} up to ${perDay} per day for ${days} days without asking each time`;
    const authorization = this._actionSafety.authorize({ kind: 'task', description: `${summary} (permission change)` });
    this._pendingConfirmedAction = () => this._deliverSpokenAnswer(this._missions.grantStanding({ scopes, perDay, days }));
    if (!authorization.allowed) this._deliverSpokenAnswer(confirmationPrompt(summary, authorization.assessment));
    else this._pendingConfirmedAction();
    return 'Waiting for the user to say confirm; nothing is granted until then.';
  }

  // Queues a background mission result (done / blocked / needs approval) to be spoken when JARVIS is not talking.
  announce(text) {
    const clean = String(text || '').trim();
    if (!clean || this.closed) return false;
    this._backgroundTaskResults.push({ answer: clean.slice(0, 220) }); // spoken aloud: a short message, not long technical text
    this._deliverReadyBackgroundWork();
    return true;
  }

  _speculativeEnabled() {
    // Providers that answer on their own (Gemini Live) must always go through the
    // speculative hold, otherwise unvetted audio would play before the transcript filters run.
    if (this.provider?.autoResponds) return !this._authoritativeTranscribe;
    return SPECULATIVE_RESPONSE && this.provider?.id === 'voice-live' && !this._mediaModeActive && !this._authoritativeTranscribe;
  }

  _beginSpeculative() {
    // A speech_stopped that arrives while speaking (echo) must not open a new speculative reply.
    // When server auto-response is off (always-listening, outside the conversation window), no speculative reply is expected.
    const autoResponseExpected = this._autoResponseOn || this.provider?.autoResponds;
    if (!this._speculativeEnabled() || !autoResponseExpected || this.assistantSpeaking || this._realtimeResponseActive) return;
    clearTimeout(this._specTimer);
    this._spec = { state: 'expected', held: [], calls: [], doneInfo: null, created: false };
    const spec = this._spec;
    // If no transcript ever arrives, do not hold the audio forever: same as the old behaviour (no reply).
    this._specTimer = setTimeout(() => { if (this._spec === spec && ['expected', 'held'].includes(spec.state)) this._discardSpeculative(); }, SPECULATIVE_DECISION_TIMEOUT_MS);
    if (this._specTimer.unref) this._specTimer.unref();
  }

  _onSpeculativeResponseCreated() {
    const spec = this._spec;
    if (!spec) return;
    if (spec.state === 'expected') spec.state = 'held';
    else if (spec.state === 'adopted') spec.created = true;
    else if (spec.state === 'discarded') {
      spec.state = 'cleared';
      this._suppressCurrentResponse = true;
      this._specClearing = true;
      this._armSpecClearTimer();
      try { this.ws.send(JSON.stringify({ type: 'response.cancel' })); } catch (e) {}
    }
  }

  _onSpeculativeResponseDone() {
    if (this._specClearing) this._releaseSpecClearing();
    const spec = this._spec;
    if (spec && ['adopted', 'cleared'].includes(spec.state)) this._spec = null;
  }

  _armSpecClearTimer() {
    clearTimeout(this._specClearTimer);
    this._specClearTimer = setTimeout(() => this._releaseSpecClearing(), 700);
    if (this._specClearTimer.unref) this._specClearTimer.unref();
  }

  _releaseSpecClearing() {
    clearTimeout(this._specClearTimer);
    this._specClearing = false;
    const queued = this._specQueue.splice(0);
    for (const [response] of queued) this._sendResponseCreate(response);
  }

  // Cancels the speculative reply: held audio and tool calls are dropped.
  _discardSpeculative() {
    const spec = this._spec;
    if (!spec) return;
    clearTimeout(this._specTimer);
    if (spec.state === 'held') {
      spec.state = 'cleared';
      spec.held = []; spec.calls = []; spec.doneInfo = null;
      if (this._realtimeResponseActive) {
        this._suppressCurrentResponse = true;
        this._specClearing = true;
        this._armSpecClearTimer();
        try { this.ws.send(JSON.stringify({ type: 'response.cancel' })); } catch (e) {}
      } else {
        this._spec = null;
      }
    } else if (spec.state === 'expected') {
      spec.state = 'discarded';
      this._specClearing = true;
      this._armSpecClearTimer();
    }
  }

  // Returns true when the speculative reply was adopted and no separate response.create is needed.
  _adoptSpeculative(options = {}) {
    const spec = this._spec;
    if (!spec || !['expected', 'held'].includes(spec.state)) return false;
    if (options.replaceAudioItem) { this._discardSpeculative(); return false; }
    clearTimeout(this._specTimer);
    const wasHeld = spec.state === 'held';
    spec.state = 'adopted';
    this.emit('telemetry', 'speculative.adopted', { held: wasHeld, heldChunks: spec.held.length });
    if (wasHeld) {
      const chunks = spec.held.splice(0);
      if (chunks.length) {
        if (!this._firstAudioObserved) {
          this._firstAudioObserved = true;
          this.emit('telemetry', 'assistant.audio.first', {});
        }
        this.assistantSpeaking = true;
        this._syncAutoResponse();
        for (const delta of chunks) this._playChunk(Buffer.from(delta, 'base64'));
      }
      if (spec.doneInfo) {
        const info = spec.doneInfo;
        this.emit('assistant_transcript', info.transcript, { status: info.status, reason: info.reason });
        this._lastAssistantTranscript = info.transcript;
        this._rememberConversationTurn('Jarvis', info.transcript);
      }
      for (const call of spec.calls.splice(0)) this._handleFunctionCall(call);
      if (!this._realtimeResponseActive) this._spec = null;
    } else {
      // The reply does not exist yet: if it never arrives, request one the normal way to be safe.
      const timer = setTimeout(() => {
        if (this._spec === spec && !spec.created && !this._realtimeResponseActive && !this.closed) {
          this._spec = null;
          this._respondWithRealtimeConversation();
        }
      }, 2500);
      if (timer.unref) timer.unref();
    }
    return true;
  }

  _sendResponseCreate(response) {
    if (this._specClearing) { this._specQueue.push([response]); return true; }
    try {
      const message = { type: 'response.create' };
      if (response) message.response = response;
      this._realtimeResponseActive = true;
      this.ws.send(JSON.stringify(message));
      this.emit('telemetry', 'provider.request.sent', {
        toolChoice: response?.tool_choice || 'auto'
      });
      return true;
    } catch (e) { return false; }
  }

  async _runDirectFastAction(id) {
    const authorization = this._actionSafety.authorize({ kind: 'fast-action', id, description: id });
    if (!authorization.allowed) {
      this._pendingConfirmedAction = () => this._runDirectFastAction(id);
      this.emit('telemetry', 'safety.confirmation_required', { risk: authorization.assessment.risk, kind: 'fast-action' });
      await this._deliverSpokenAnswer(confirmationPrompt(`run ${id}`, authorization.assessment));
      return;
    }
    const callId = 'direct-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    this.emit('tool_call', 'fast_action: ' + id, callId);
    if (/^media:/.test(id)) this._setMediaLikelyPlaying();
    await captureSetting(id, { stack: this._undoStack });
    let result;
    try { result = await this._fastActionRunner(id); }
    catch (e) { result = { status: 'error', message: e.message }; }
    if (this.closed) return;
    const ok = result?.status === 'ok';
    if (ok) await this._auditHighRiskCompletion(authorization.assessment, { source: 'voice', requestId: callId });
    const output = (ok ? result?.message : ('Error: ' + (result?.message || 'action failed'))) || 'Done.';
    this.emit('tool_result', output, callId);
    this.emit('telemetry', 'fast_action.completed', { action: id, ok, direct: true });
    await this._deliverSpokenAnswer(output.slice(0, 500), { maxOutputTokens: REALTIME_FAST_ACTION_MAX_RESPONSE_TOKENS });
  }

  async _runCommunicationIntent(intent) {
    const callId = 'communication-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    this.emit('tool_call', 'communication: ' + intent.kind, callId);
    let result;
    try { result = await this._communicationRunner(intent); }
    catch (error) { result = { status: 'error', message: error.message }; }
    if (this.closed) return;
    const ok = result?.status === 'ok';
    const output = (ok ? result?.message : ('Error: ' + (result?.message || 'communication action failed'))) || 'Done.';
    this.emit('tool_result', output, callId);
    this.emit('telemetry', 'communication.completed', { action: intent.kind, ok, direct: true });
    await this._deliverSpokenAnswer(output.slice(0, 500), { maxOutputTokens: REALTIME_FAST_ACTION_MAX_RESPONSE_TOKENS });
  }

  async _respondWithGrounding(question, serial = ++this._groundedTurnSerial) {
    const startedAt = Date.now();
    this.emit('context_hydration_started', question);
    let grounding = '';
    try { grounding = await this._groundingProvider(question); } catch (e) {}
    const continuation = this._conversationContext.grounding(question);
    if (continuation) grounding = continuation + '\n\n' + grounding;
    if (this.closed || serial !== this._groundedTurnSerial) return;

    let answer = '';
    try { answer = await this._expertAnswer(this._questionWithRecentContext(question), 'auto-' + Date.now(), grounding); } catch (e) {}
    if (this.closed || serial !== this._groundedTurnSerial) return;
    answer = prepareSpokenAnswer(answer);
    if (!answer) answer = "I couldn't prepare a reliable answer right now.";
    this.emit('context_hydration_done', { question, groundingBytes: grounding.length, answer });
    this.emit('telemetry', 'grounding.completed', { durationMs: Date.now() - startedAt, groundingBytes: grounding.length });

    await this._deliverSpokenAnswer(answer.slice(0, 7000));
  }

  async _respondWithExpert(question, serial = ++this._groundedTurnSerial) {
    const startedAt = Date.now();
    let answer = '';
    try { answer = await this._expertAnswer(this._questionWithRecentContext(question), 'auto-' + Date.now(), ''); } catch (e) {}
    if (this.closed || serial !== this._groundedTurnSerial) return;
    answer = prepareSpokenAnswer(answer) || "I couldn't prepare a reliable answer right now.";
    this.emit('telemetry', 'expert.completed', { durationMs: Date.now() - startedAt });
    await this._deliverSpokenAnswer(answer.slice(0, 5000));
  }

  async _deliverSpokenAnswer(answer, options = {}) {
    const text = prepareSpokenAnswer(answer);
    if (!text || this.closed) return false;
    if (this._speakText) {
      const startedAt = Date.now();
      try {
        this._externalPlaybackCancelled = false;
        this.assistantSpeaking = true;
        await this._speakText(text, {
          onStart: (proc) => { this._externalPlayProc = proc || null; },
          onAudio: (pcm) => this._writePlayback(pcm),
          waitForPlayback: () => this._waitForPlayback()
        });
        if (this.closed || this._externalPlaybackCancelled) {
          this._externalPlaybackCancelled = false;
          return false;
        }
        this.assistantSpeaking = false;
        this._externalPlayProc = null;
        this._speakEndedAt = Date.now();
        this._lastAssistantTranscript = text;
        this._rememberConversationTurn('Jarvis', text);
        this.emit('assistant_transcript', text);
        this.emit('telemetry', 'tts.completed', { provider: 'azure-speech', durationMs: Date.now() - startedAt });
        this.emit('turn_done');
        return true;
      } catch (error) {
        this.assistantSpeaking = false;
        this._externalPlayProc = null;
        this._speakEndedAt = Date.now();
        if (this.closed || this._externalPlaybackCancelled) {
          this._externalPlaybackCancelled = false;
          return false;
        }
        this.emit('telemetry', 'tts.fallback', { provider: 'realtime', reason: error?.message || 'tts-error' });
      }
    }
    // If TTS fails, hand the prepared text to Realtime only to be read aloud;
    // it does not answer the question or rework the content.
    return this._sendResponseCreate({
      max_output_tokens: options.maxOutputTokens || REALTIME_MAX_RESPONSE_TOKENS,
      tool_choice: 'none',
      instructions: "Read the following prepared answer exactly as written, preserving its language. Use a warm, natural conversational voice with a calm pace, natural pauses, and varied cadence. Do not sound metallic, synthetic, theatrical, or like an announcer. Add, remove, and rewrite nothing. Do not translate it:\n\n" + text
    });
  }

  _beginAuthoritativeTranscription(turn) {
    // If the previous turn was left unfinished, the new turn replaces it; the
    // timeout keeps a stale callback from creating a reply.
    const pending = {
      id: Symbol('voice-turn'), native: null, result: null, settled: false,
      timer: null, startedAt: Date.now(), requireAuthoritative: this._requireAuthoritativeFirstTurn
    };
    this._requireAuthoritativeFirstTurn = false;
    this._pendingAuthoritativeTurn = pending;
    const pcm = Buffer.concat(turn.chunks || []);
    pending.timer = setTimeout(() => {
      if (this._pendingAuthoritativeTurn !== pending || pending.settled) return;
      if (pending.native?.text) {
        pending.settled = true;
        this._pendingAuthoritativeTurn = null;
        this.emit('telemetry', 'stt.recovery', { source: 'native-timeout', timeoutMs: Date.now() - pending.startedAt });
        this._acceptTranscript(pending.native.text, { source: 'native-timeout', sttLatencyMs: Date.now() - pending.startedAt });
      } else {
        this.emit('turn_suppressed', 'uzbek-stt-timeout', '');
        this.emit('telemetry', 'stt.timeout', { timeoutMs: Date.now() - pending.startedAt });
        this._pendingAuthoritativeTurn = null;
      }
    }, authoritativeTimeoutMs(pcm.length));

    Promise.resolve(this._authoritativeTranscribe(pcm)).then(result => {
      // If the native fast path already settled this turn (pending.settled), the
      // reply is no longer affected, but the authoritative result is still logged
      // to telemetry (useful for auditing fast-path decisions later). If a
      // DIFFERENT, later turn has started (neither settled nor current), this is a
      // genuinely stale callback and is ignored.
      if (this._pendingAuthoritativeTurn !== pending && !pending.settled) return;
      pending.result = result && typeof result === 'object' ? result : { text: String(result || '') };
      this.emit('telemetry', 'stt.authoritative.completed', {
        durationMs: Date.now() - pending.startedAt,
        confidence: pending.result.confidence,
        afterFastPath: pending.settled
      });
      if (!pending.settled) this._finalizeAuthoritativeTurn();
    }).catch(() => {
      if (this._pendingAuthoritativeTurn !== pending && !pending.settled) return;
      if (pending.settled) return;
      pending.result = { text: '' };
      this._finalizeAuthoritativeTurn();
    });
  }

  _finalizeAuthoritativeTurn() {
    const pending = this._pendingAuthoritativeTurn;
    if (!pending || pending.settled || !pending.result || !pending.native) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    this._pendingAuthoritativeTurn = null;
    const selected = chooseTranscript(pending.result, pending.native.text, {
      context: { lastAssistant: this._lastAssistantTranscript, mediaMode: this._mediaModeActive },
      preferAuthoritative: pending.requireAuthoritative
    });
    const latencyMs = Date.now() - pending.startedAt;
    this.emit('telemetry', 'stt.selection', {
      source: selected.source,
      authoritativeScore: selected.authoritative.score,
      nativeScore: selected.native.score,
      durationMs: latencyMs
    });
    this._acceptTranscript(selected.text, {
      replaceAudioItem: selected.source === 'authoritative',
      itemId: pending.native.itemId,
      source: selected.source,
      sttLatencyMs: latencyMs
    });
  }

  // Called INDEPENDENTLY (not awaited) for every call (see
  // 'response.function_call_arguments.done' in _onMessage), so several tasks
  // truly run in parallel. Each gets its own session_key, which guarantees they
  // never corrupt each other's context.
  async _handleFunctionCall(msg) {
    if (msg.name === 'note_pronunciation') { this._handleNotePronunciation(msg); return; }
    if (msg.name === 'manage_tasks') { this._handleManageTasks(msg); return; }
    if (msg.name === 'fast_action') { this._handleFastAction(msg); return; }
    if (msg.name === 'web_open') { this._handleWebOpen(msg); return; }
    if (msg.name === 'file_op' || msg.name === 'undo_last') { this._handleFileTool(msg); return; }
    if (msg.name === 'close_app') { this._handleCloseApp(msg); return; }
    if (msg.name === 'see_screen') { this._handleSeeScreen(msg); return; }
    if (msg.name === 'cancel_task') { this._handleCancelTask(msg); return; }
    if (msg.name === 'recall_memory') { this._handleRecallMemory(msg); return; }
    if (msg.name === 'save_memory') { this._handleSaveMemory(msg); return; }
    if (msg.name === 'ask_expert') { this._handleAskExpert(msg); return; }
    if (['start_mission', 'mission_status', 'mission_control', 'standing_approval'].includes(msg.name)) { this._handleMissionTool(msg); return; }
    if (msg.name !== 'run_task') return;
    let args = {};
    try { args = JSON.parse(msg.arguments || '{}'); } catch (e) {}
    const description = args.description || '';
    const authorization = this._actionSafety.authorize({ kind: 'task', description });
    if (!authorization.allowed) {
      this._pendingConfirmedAction = () => this._runConfirmedTask(description);
      this.emit('telemetry', 'safety.confirmation_required', { risk: authorization.assessment.risk, kind: 'task' });
      this._sendBlockedToolResult(msg.call_id);
      return;
    }
    const taskSessionKey = 'agent:main:jarvis-task-' + msg.call_id;
    this.emit('tool_call', description, msg.call_id);

    // IMPORTANT: the media check is applied IMMEDIATELY (while the task is still
    // running), not after it finishes, because a video often starts playing INSIDE
    // the task, before it completes (e.g. right after play is clicked). Applied
    // late, the video would already have played for seconds and been mistaken
    // for the user speaking (observed in real use).
    if (/video|musiqa|youtube|ijro|play|pauz|davom ettir|qo'shiq|klip/i.test(description)) {
      this._setMediaLikelyPlaying();
    }

    const persistent = needsPersistentExecution(description);
    this._runningTasks.set(msg.call_id, { description, background: false });
    let handoffTimer = setTimeout(() => {
      const task = this._runningTasks.get(msg.call_id);
      if (!task) return;
      task.background = true;
      this._sendTaskProgress(msg.call_id, 'I will continue this work in the background and notify you when it is complete.');
    }, VOICE_AGENT_HANDOFF_MS);
    handoffTimer.unref?.();
    const result = await runFullAgent(description, taskSessionKey, (proc) => {
      this._runningTasks.set(msg.call_id, { proc, description, background: false });
    }, spawn, progress => this._sendTaskProgress(msg.call_id, progress));
    clearTimeout(handoffTimer);
    this._runningTasks.delete(msg.call_id);
    this.emit('tool_result', result, msg.call_id);
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output: result.slice(0, 4000) }
      }));
      this._sendResponseCreate();
    } catch (e) {}
  }

  _sendTaskProgress(callId, progress) {
    this.emit('tool_progress', progress, callId);
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: String(progress).slice(0, 1000) }
      }));
      this._sendResponseCreate();
    } catch (e) {}
  }

  async _handleAskExpert(msg) {
    let args = {};
    try { args = JSON.parse(msg.arguments || '{}'); } catch (e) {}
    const question = String(args.question || '').trim();
    this.emit('tool_call', 'ask_expert: ' + question.slice(0, 160), msg.call_id);
    let grounding = '';
    if (question) {
      try { grounding = await this._groundingProvider(question); } catch (e) {}
    }
    const output = question
      ? await this._expertAnswer(question, msg.call_id, grounding)
      : "No question text was provided.";
    this.emit('tool_result', output.slice(0, 300), msg.call_id);
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output: output.slice(0, 5000) }
      }));
      this._sendResponseCreate();
    } catch (e) {}
  }

  // Semantic search across the whole memory history. The daemon keeps the index
  // fresh in the background, so this is a read only (~1 s); via run_task it
  // would take 15-25 s.
  async _handleRecallMemory(msg) {
    let args = {};
    try { args = JSON.parse(msg.arguments || '{}'); } catch (e) {}
    const query = args.query || '';
    this.emit('tool_call', 'recall_memory: ' + query, msg.call_id);
    let output;
    try {
      const r = await this._memoryProvider.recallMemory(query, 6);
      if (r.status === 'ok' && r.results && r.results.length) {
        output = r.results
          .map(x => '[' + (x.date || x.layer || x.source || 'memory') + '] ' + (x.title || x.topic || '') + ': ' + String(x.content || x.snippet || '').replace(/\s+/g, ' ').slice(0, 500))
          .join('\n---\n');
      } else {
        output = 'Nothing about this was found in memory.';
      }
    } catch (e) {
      output = 'Xotirani qidirib bo\'lmadi: ' + (e.message || '').slice(0, 150);
    }
    this.emit('tool_result', output.slice(0, 200), msg.call_id);
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output: output.slice(0, 4000) }
      }));
      this._sendResponseCreate();
    } catch (e) {}
  }

  async _handleSaveMemory(msg) {
    let args = {};
    try { args = JSON.parse(msg.arguments || '{}'); } catch (e) {}
    const fact = String(args.fact || '').trim();
    this.emit('tool_call', 'save_memory: ' + fact, msg.call_id);
    let output = 'Saved to memory.';
    try {
      if (fact && typeof this._memoryProvider?.writeMemory === 'function') {
        this._memoryProvider.writeMemory(args.category || 'User Preference', fact, ['user', 'voice'], {
          layer: 'user_profile',
          source: 'voice-user',
          confidence: 0.98
        });
        output = `Saved to memory: "${fact}".`;
      }
    } catch (e) {
      output = 'Could not save to memory: ' + (e.message || String(e)).slice(0, 150);
    }
    this.emit('tool_result', output.slice(0, 200), msg.call_id);
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output }
      }));
      this._sendResponseCreate();
    } catch (e) {}
  }

  async _handleManageTasks(msg) {
    let args = {};
    try { args = JSON.parse(msg.arguments || '{}'); } catch (e) {}
    const action = args.action || 'list';
    this.emit('tool_call', `manage_tasks: ${action} ${args.text || ''}`.trim(), msg.call_id);
    let output = '';
    try {
      const tasks = require('../tasks');
      if (action === 'list') {
        const list = tasks.listTasks().tasks;
        if (!list.length) {
          output = 'The task list for today is empty.';
        } else {
          const pending = list.filter(t => !t.done);
          const done = list.filter(t => t.done);
          output = `${list.length} tasks in total (${pending.length} pending, ${done.length} done):\n` +
            list.map(t => (t.done ? '✓ ' : '• ') + t.text).join('\n');
        }
      } else if (action === 'add') {
        const r = tasks.addTask(args.text);
        output = r.status === 'ok' ? `Task added: "${args.text}"` : (r.message || 'An error occurred');
      } else if (action === 'complete') {
        const r = tasks.completeTask(args.text);
        output = r.status === 'ok' ? `Task marked as done: "${r.completed}"` : (r.message || 'No pending task found');
      } else if (action === 'remove') {
        const r = tasks.removeTask(args.text);
        output = r.status === 'ok' ? `Task removed: "${args.text}"` : (r.message || 'Not found');
      }
    } catch (e) {
      output = 'Task list error: ' + e.message;
    }
    this.emit('tool_result', output.slice(0, 300), msg.call_id);
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output: output.slice(0, 4000) }
      }));
      this._sendResponseCreate();
    } catch (e) {}
  }

  // Kills running run_task processes as soon as the user says "stop". Before this,
  // a started task could not be stopped at all; you had to wait for it to finish
  // (up to 3 minutes).
  _handleCancelTask(msg) {
    this.emit('tool_call', 'cancel_task: running tasks', msg.call_id);
    const n = this.cancelRunningTasks();
    const output = n > 0 ? `Stopped ${n} task${n === 1 ? '' : 's'}.` : 'No task was running.';
    this.emit('tool_result', output, msg.call_id);
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output }
      }));
      this._sendResponseCreate();
    } catch (e) {}
  }

  // Unlike run_task this starts no heavy sub-agent; it only writes quickly to a
  // file (memory, no LLM call needed), so it runs directly and synchronously.
  _handleNotePronunciation(msg) {
    let args = {};
    try { args = JSON.parse(msg.arguments || '{}'); } catch (e) {}
    let result = 'ok';
    try { require('../memory').addPronunciationNote(args.misheard, args.actual); }
    catch (e) { result = 'error: ' + e.message; }
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output: result }
      }));
      // response.create is deliberately NOT called: this is not something to say to
      // the user, only an internal memory write (the tool description says so too).
    } catch (e) {}
  }

  // MUCH faster than run_task: no full agent (LLM reasoning chain) is started, a
  // system command runs directly (see skills/fast-actions). The "tool_call" and
  // "tool_result" events deliberately use the SAME names as run_task, so the
  // existing rtTaskStarted/rtTaskCompleted tracking in jarvis_daemon.js (the
  // dashboard's live-tasks panel) shows these too without extra wiring.
  async _handleCloseApp(msg) {
    let args = {};
    try { args = JSON.parse(msg.arguments || '{}'); } catch (e) {}
    this.emit('tool_call', 'close_app: ' + String(args.name || '').slice(0, 60), msg.call_id);
    let output;
    try { output = (await this._closeApp(args.name)).said; } catch (e) { output = 'Error: ' + e.message; }
    this.emit('tool_result', output, msg.call_id);
    try {
      this.ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: msg.call_id, output: output.slice(0, 300) } }));
      this._sendResponseCreate();
    } catch (e) {}
  }

  async _handleFileTool(msg) {
    let args = {};
    try { args = JSON.parse(msg.arguments || '{}'); } catch (e) {}
    this.emit('tool_call', msg.name + ': ' + (args.op || '') + ' ' + String(args.path || '').slice(0, 60), msg.call_id);
    let output;
    try {
      if (msg.name === 'undo_last') output = (await this._undoStack.undoLast()).message;
      else {
        const ops = fileOps({ stack: this._undoStack });
        const fn = { mkdir: () => ops.mkdir(args.path), move: () => ops.move(args.path, args.dest), copy: () => ops.copy(args.path, args.dest), write: () => ops.write(args.path, args.content), trash: () => ops.trash(args.path) }[args.op];
        if (!fn) throw new Error('unknown op');
        output = fn();
      }
    } catch (e) { output = 'Error: ' + e.message; }
    this.emit('tool_result', output, msg.call_id);
    try {
      this.ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: msg.call_id, output: output.slice(0, 500) } }));
      this._sendResponseCreate();
    } catch (e) {}
  }

  async _handleWebOpen(msg) {
    let args = {};
    try { args = JSON.parse(msg.arguments || '{}'); } catch (e) {}
    this.emit('tool_call', 'web_open: ' + (args.kind || '') + ' ' + String(args.query || args.url || '').slice(0, 60), msg.call_id);
    let output;
    try {
      const target = await this._webOpener(args);
      if (target.media) this._setMediaLikelyPlaying();
      output = target.said;
    } catch (e) { output = 'Error: ' + e.message + '. Fall back to run_task if still needed.'; }
    this.emit('tool_result', output, msg.call_id);
    try {
      this.ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: msg.call_id, output: output.slice(0, 500) } }));
      this._sendResponseCreate();
    } catch (e) {}
  }

  async _handleFastAction(msg) {
    let args = {};
    try { args = JSON.parse(msg.arguments || '{}'); } catch (e) {}
    const id = args.id || '';
    const authorization = this._actionSafety.authorize({ kind: 'fast-action', id, description: id });
    if (!authorization.allowed) {
      this._pendingConfirmedAction = () => this._runDirectFastAction(id);
      this.emit('telemetry', 'safety.confirmation_required', { risk: authorization.assessment.risk, kind: 'fast-action' });
      this._sendBlockedToolResult(msg.call_id);
      return;
    }
    this.emit('tool_call', 'fast_action: ' + id, msg.call_id);
    // Actions that play music or video also risk leaking into the microphone;
    // same protection as in run_task.
    if (/^media:/.test(id)) this._setMediaLikelyPlaying();
    await captureSetting(id, { stack: this._undoStack });
    let result;
    // This used to call the module directly, bypassing the injectable
    // this._fastActionRunner seam the deterministic router (_runDirectFastAction)
    // uses; both paths now go through the same guarded seam.
    try { result = await this._fastActionRunner(id); }
    catch (e) { result = { status: 'error', message: e.message }; }
    const output = (result.status === 'ok' ? result.message : ('Error: ' + result.message)) || 'Done.';
    this.emit('tool_result', output, msg.call_id);
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output: output.slice(0, 1000) }
      }));
      this._sendResponseCreate();
    } catch (e) {}
  }

  _sendBlockedToolResult(callId) {
    const output = 'CONFIRMATION REQUIRED: this action may have an external, sensitive, or destructive effect. Ask the user to say confirm or cancel. Do not claim it was executed.';
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output }
      }));
      this._sendResponseCreate({
        tool_choice: 'none',
        instructions: 'Ask exactly one concise confirmation question. Do not claim the action ran.'
      });
    } catch (e) {}
  }

  async _runConfirmedTask(description) {
    const authorization = this._actionSafety.authorize({ kind: 'task', description });
    if (!authorization.allowed) return;
    const callId = 'confirmed-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    this.emit('tool_call', description, callId);
    const result = await runFullAgent(description, 'agent:main:jarvis-task-' + callId, (proc) => {
      this._runningTasks.set(callId, { proc, description });
    }, spawn, progress => this._sendTaskProgress(callId, progress));
    this._runningTasks.delete(callId);
    if (this.closed) return;
    this.emit('tool_result', result, callId);
    await this._deliverSpokenAnswer(result.slice(0, 4000));
  }

  // Captures the screen and adds the image to THIS conversation, so the model sees
  // it itself (no separate vision call, no run_task). The image is scaled down to
  // 900 px: far fewer tokens and less upload time, while text stays readable.
  async _handleSeeScreen(msg) {
    this.emit('tool_call', 'see_screen: ekranga qaraldi', msg.call_id);
    let visionDescription = '';
    try {
      const sv = require('../screen-vision');
      const res = await sv.inspectScreen("What is open on the screen right now? Describe the app, window, and active content in 1-2 concise, clear sentences.");
      if (res && res.status === 'ok' && res.description) {
        visionDescription = res.description;
      }
    } catch (e) {
      visionDescription = '';
    }

    const output = visionDescription ? `The user's screen shows: ${visionDescription}` : 'Screen checked: current desktop is visible.';
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output }
      }));
      this._sendResponseCreate();
    } catch (e) {}
    this.emit('tool_result', output, msg.call_id);
  }

  _setMediaLikelyPlaying() {
    saveMediaState(); // so later (new) conversations know too; see the note in connect()
    if (this._mediaModeActive) return;
    this._mediaModeActive = true;
    // With media in the background the local gate must switch to the same
    // conservative trailing-silence window as server VAD; otherwise video noise
    // can close the turn wrongly or break the next audio lifecycle.
    this.duplex.hangoverMs = MEDIA_DUPLEX_HANGOVER_MS;
    try {
      // 0.92 made JARVIS nearly deaf to the user at real microphone levels. During
      // media a moderate threshold is used together with a longer confirmation
      // window and echo mute; the value is configurable in .env.
      this.ws.send(JSON.stringify({
        type: 'session.update',
        session: { turn_detection: { type: 'server_vad', threshold: MEDIA_VAD_THRESHOLD, silence_duration_ms: MEDIA_VAD_SILENCE_MS, prefix_padding_ms: 300, create_response: false, interrupt_response: false } }
      }));
    } catch (e) {}
  }

  // When the user genuinely speaks during the conversation (a transcript arrives)
  // media mode may no longer be needed, but sensitivity is deliberately NOT
  // restored (the media itself may still be playing, and lowering it by mistake
  // causes false negatives); it stays at this level until the session ends.

  // Feeds a raw 16 kHz PCM chunk from the microphone into the stream. Both
  // Realtime and Azure TTS playback hand the 24 kHz PCM sent to the speaker to the
  // duplex engine as a reference, so the microphone is not hard-muted during
  // playback and real barge-in is preserved. A short grace period follows
  // playback, because room reverberation can still reach the microphone after the
  // reference ends. During playback, AEC removes the echo and lets barge-in
  // through when enough residual remains.
  feedAudio(pcm16_16k) {
    if (!this.ready || this.closed) return;
    const now = Date.now();
    const muteUntil = Math.max(this._playbackUntil, this._speakEndedAt) + (this._nativeAec ? NATIVE_MIC_MUTE_GRACE_MS : MIC_MUTE_GRACE_MS);
    const resampled = resample16to24(pcm16_16k);
    const userTakingTurn = this._nativeAec && (this._serverSpeechOpen || this._bargeInConfirmed || this._duck);
    const inAcousticGrace = !this.assistantSpeaking && now < muteUntil && !userTakingTurn;
    // Safeguard: if the "speaking" state is stuck while no audio arrives and the speaker is silent (the gate goes deaf),
    // uni qayta tiklaymiz.
    if (this.assistantSpeaking && this._lastAudioQueuedAt && now > this._playbackUntil + 1500 && now - this._lastAudioQueuedAt > 2500) {
      this.assistantSpeaking = false;
      this._resetBargeInCandidate();
      this._syncAutoResponse();
      this.emit('telemetry', 'assistant.speaking.stuck_reset', {});
    }
    const processed = this._nativeAec
      ? this._nativeGate(resampled)
      : this.duplex.process(resampled, { assistantSpeaking: this.assistantSpeaking });
    this._recordGateStats(processed, now);
    // While speaking, the adaptive AEC preserves barge-in. In the grace window
    // after speech the reference may already have ended, so remaining room echo
    // is not sent to the server at all.
    if (inAcousticGrace) return;
    // The optional recovery recorder must see the original 16 kHz turn even
    // while candidate barge-in audio is held back from server VAD.
    if (this._authoritativeTranscribe && processed.send) {
      const copy = Buffer.from(pcm16_16k);
      if (this._sttTurn) {
        this._sttTurn.chunks.push(copy);
        this._sttTurn.bytes += copy.length;
      } else {
        this._sttPreRoll.push(copy);
        this._sttPreRollBytes += copy.length;
        const maxPreRollBytes = Math.ceil(16000 * 2 * 0.7);
        while (this._sttPreRollBytes > maxPreRollBytes && this._sttPreRoll.length > 1) {
          this._sttPreRollBytes -= this._sttPreRoll.shift().length;
        }
      }
    }
    if (this._nativeAec) {
      // While JARVIS speaks, keep all frames briefly: once barge-in is confirmed, the start of the
      // user's speech (including quiet syllables) reaches the server intact.
      if (this.assistantSpeaking && !this._bargeInConfirmed) {
        this._nativePreRoll.push(Buffer.from(resampled));
        this._nativePreRollBytes += resampled.length;
        while (this._nativePreRollBytes > NATIVE_PREROLL_BYTES && this._nativePreRoll.length > 1) {
          this._nativePreRollBytes -= this._nativePreRoll.shift().length;
        }
      } else if (!this.assistantSpeaking) {
        this._nativePreRoll = [];
        this._nativePreRollBytes = 0;
      }
    }
    if (this.assistantSpeaking) {
      const chunkMs = pcm16_16k.length / (IN_RATE * 2) * 1000;
      if (!processed.send || processed.reason !== 'barge-in') {
        if (!this._bargeInConfirmed && this._bargeInCandidateMs > 0) {
          this._bargeInGapMs += chunkMs;
          if (this._bargeInGapMs > BARGE_IN_MAX_GAP_MS) this._resetBargeInCandidate();
        }
        return;
      }

      if (now < this._noBargeInUntil) return;
      if (!this._bargeInConfirmed) {
        this._bargeInGapMs = 0;
        this._bargeInCandidate.push(Buffer.from(processed.audio));
        this._bargeInCandidateMs += chunkMs;
        const confirmMs = this._nativeAec ? NATIVE_BARGE_IN_CONFIRM_MS : BARGE_IN_CONFIRM_MS;
        if (this._bargeInCandidateMs < confirmMs) return;

        const candidate = this._nativeAec && this._nativePreRoll.length
          ? Buffer.concat(this._nativePreRoll)
          : Buffer.concat(this._bargeInCandidate);
        this._nativePreRoll = [];
        this._nativePreRollBytes = 0;
        this._bargeInCandidate = [];
        this._bargeInCandidateMs = 0;
        // Waiting for provider VAD adds noticeable delay. Stop the speaker as soon
        // as the local AEC gate confirms speech; the later server event only
        // continues the turn lifecycle. _flushPlayback resets the candidate state,
        // so confirmed/evidence are written AFTER it.
        this._beginDuck();
        this._bargeInConfirmed = true;
        this._bargeInEvidenceAt = now;
        this.emit('telemetry', 'barge_in.confirmed', {
          confirmationMs: this._nativeAec ? NATIVE_BARGE_IN_CONFIRM_MS : BARGE_IN_CONFIRM_MS,
          source: this._nativeAec ? 'native-aec' : 'local-duplex'
        });
        this._sendInputAudio(candidate);
        return;
      }
      this._bargeInEvidenceAt = now;
    }
    if (!processed.send) { this._feedTrailingSilence(resampled.length); return; }
    this._trailingSilenceMs = 0;
    // Only real audio activity that passed the echo/noise filter is reported, so the
    // daemon keeps the session alive even when the server transcript is late.
    this.emit('audio_activity', {
      reason: processed.reason,
      residualRms: processed.residualRms,
      correlation: processed.correlation,
      estimatedNoiseRms: processed.estimatedNoiseRms,
      speechThresholdRms: processed.speechThresholdRms
    });
    this._sendInputAudio(processed.audio);
  }

  // The local noise gate stops sending audio when speech ends, but server VAD only detects silence
  // from incoming audio (330 ms is not enough given the server noise-filter delay), so while the
  // server still thinks the user is speaking, send silence until speech_stopped arrives.
  _isSpeakingNow() {
    return this.assistantSpeaking || Boolean(this._duck) || this._realtimeResponseActive || Date.now() < this._playbackUntil;
  }

  // The user said "stop" ("to'xta"/"boldi"): stop speaking at once and keep background messages quiet briefly.
  _stopSpeakingByUser(reason) {
    this._discardSpeculative();
    if (this._duck) {
      this._commitBargeIn(reason);
    } else {
      this._responseInterrupted = true;
      this._dropStaleAudio = true;
      if (this._realtimeResponseActive) {
        this._specClearing = true;
        this._armSpecClearTimer();
        try { this.ws.send(JSON.stringify({ type: 'response.cancel' })); } catch (e) {}
      }
      this._flushPlayback();
      this.assistantSpeaking = false;
      this._syncAutoResponse();
    }
    this._quietUntil = Date.now() + STOP_QUIET_MS;
    const timer = setTimeout(() => { this._deliverReadyBackgroundResearch(); this._deliverReadyBackgroundWork(); }, STOP_QUIET_MS + 100);
    if (timer.unref) timer.unref();
    this.emit('telemetry', 'stop_command', { reason });
  }

  // Barge-in: PAUSE the speaker immediately (SIGSTOP), but do not cancel the reply until the transcript is checked.
  _beginDuck() {
    if (this._duck) return;
    const duck = { at: Date.now(), timer: null };
    duck.timer = setTimeout(() => { if (this._duck === duck) this._onDuckTimeout(); }, BARGE_IN_VERIFY_TIMEOUT_MS);
    if (duck.timer.unref) duck.timer.unref();
    this._duck = duck;
    try { this.playProc?.kill('SIGSTOP'); } catch (e) {}
    this.emit('telemetry', 'barge_in.paused', {});
  }

  // Verification window over: if the server still hears speech it is a real interruption; otherwise it was echo, so resume.
  _onDuckTimeout() {
    if (this._serverSpeechOpen) this._commitBargeIn('timeout-speaking');
    else this._resumeBargeIn('timeout-no-speech');
  }

  _commitBargeIn(reason) {
    const duck = this._duck;
    if (!duck) return;
    clearTimeout(duck.timer);
    this._duck = null;
    try { this.playProc?.kill('SIGCONT'); } catch (e) {}
    this._responseInterrupted = true;
    this._dropStaleAudio = true;
    if (this._realtimeResponseActive) {
      this._specClearing = true;
      this._armSpecClearTimer();
      try { this.ws.send(JSON.stringify({ type: 'response.cancel' })); } catch (e) {}
    }
    this._flushPlayback();
    this.assistantSpeaking = false;
    this._syncAutoResponse();
    this._bargeInConfirmed = true;
    this._bargeInEvidenceAt = Date.now();
    this.emit('telemetry', 'barge_in.committed', { reason });
  }

  _resumeBargeIn(reason) {
    const duck = this._duck;
    if (!duck) return;
    clearTimeout(duck.timer);
    this._duck = null;
    const pausedMs = Date.now() - duck.at;
    if (this._playbackUntil > duck.at) this._playbackUntil += pausedMs;
    try { this.playProc?.kill('SIGCONT'); } catch (e) {}
    this._resetBargeInCandidate();
    // The AEC reference lost sync with the microphone during the pause: ignore new barge-ins briefly.
    this._noBargeInUntil = Date.now() + (this._nativeAec ? 300 : 1500);
    this.emit('telemetry', 'barge_in.resumed', { reason, pausedMs });
  }

  // macOS Voice Processing microphone: echo is already removed at the OS level, so no local AEC/gate is needed.
  // While silent, all audio goes to the server (server VAD + noise filter decide); while JARVIS speaks,
  // only clearly loud speech becomes a barge-in candidate (then the pause + transcript check runs).
  enableNativeAec() {
    if (this._nativeAec) return;
    this._nativeAec = true;
    this.duplex.clearPlayback();
    this.emit('telemetry', 'native_aec.enabled', {});
  }

  disableNativeAec(reason) {
    if (!this._nativeAec) return;
    this._nativeAec = false;
    this.emit('telemetry', 'native_aec.disabled', { reason });
  }

  _nativeGate(audio) {
    if (this._idleGateActive()) return this._idleGate(audio);
    const level = rms(audio);
    if (this.assistantSpeaking) {
      if (this._duck || this._bargeInConfirmed || this._serverSpeechOpen) {
        // The user took the turn: do not drop quiet syllables.
        return { send: true, audio, reason: 'barge-in', residualRms: level, correlation: 0, speechThresholdRms: NATIVE_BARGE_IN_RMS };
      }
      const send = level >= NATIVE_BARGE_IN_RMS;
      return { send, audio, reason: send ? 'barge-in' : 'playback-noise', residualRms: level, correlation: 0, speechThresholdRms: NATIVE_BARGE_IN_RMS };
    }
    return { send: true, audio, reason: 'speech', residualRms: level, correlation: 0, speechThresholdRms: 0 };
  }

  _recordGateStats(processed, now) {
    const stats = this._gateStats;
    if (this._usageBytes >= 24000 * 2 * 20) {
      // Seconds of audio sent to the server (for cost tracking), recorded roughly every 20 s.
      try { require('../../core/usage-meter').sharedMeter().add('voice_seconds', this._usageBytes / 48000); } catch (_) {}
      this._usageBytes = 0;
    }
    if (processed.send) stats.sent++; else stats.dropped++;
    stats.maxResidual = Math.max(stats.maxResidual, Math.round(processed.residualRms || 0));
    if (now - stats.since < 5000) return;
    if (stats.sent || this.assistantSpeaking) {
      this.emit('telemetry', 'gate.stats', {
        sent: stats.sent, dropped: stats.dropped, maxResidualRms: stats.maxResidual,
        thresholdRms: processed.speechThresholdRms, assistantSpeaking: this.assistantSpeaking
      });
    }
    this._gateStats = { sent: 0, dropped: 0, maxResidual: 0, since: now };
  }

  _feedTrailingSilence(bytes24k) {
    if (!this._serverSpeechOpen || this.assistantSpeaking || this.closed) return;
    if (this._trailingSilenceMs >= TRAILING_SILENCE_MAX_MS) return;
    this._trailingSilenceMs += bytes24k / 48;
    this._sendInputAudio(Buffer.alloc(bytes24k));
  }

  _sendInputAudio(audio) {
    if (!audio?.length) return false;
    this._usageBytes = (this._usageBytes || 0) + audio.length;
    try {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audio.toString('base64') }));
      return true;
    } catch (e) { return false; }
  }

  _resetBargeInCandidate() {
    this._bargeInCandidate = [];
    this._bargeInCandidateMs = 0;
    this._bargeInGapMs = 0;
    this._bargeInConfirmed = false;
    this._bargeInEvidenceAt = 0;
  }

  _startPlayback() {
    this._playbackUntil = Date.now();
    this.playProc = spawn('sox', ['-t', 'raw', '-r', String(OUT_RATE), '-e', 'signed', '-b', '16', '-c', '1', '-', '-d'], {
      stdio: ['pipe', 'ignore', 'ignore']
    });
    this.playbackBuffer = new PcmPlaybackBuffer({
      sampleRate: OUT_RATE,
      prebufferMs: PLAYBACK_PREBUFFER_MS,
      maxWaitMs: PLAYBACK_MAX_WAIT_MS,
      onData: audio => this._writePlayback(audio)
    });
    this.playProc.on('error', () => {});
    // An unhandled stdin EPIPE (e.g. the player process dies unexpectedly) would
    // crash the whole daemon, so it is swallowed here.
    this.playProc.stdin.on('error', () => {});
  }

  _playChunk(buf) {
    if (this.playProc && this.playProc.stdin.writable) {
      this.playbackBuffer.push(buf);
    }
  }

  _writePlayback(buf) {
    if (!buf?.length || !this.playProc?.stdin?.writable) return false;
    // The deadline counts from when audio is actually handed to sox; time spent
    // waiting in the prebuffer is not mistaken for playback duration.
    const now = Date.now();
    const durationMs = Math.ceil((buf.length / (OUT_RATE * 2)) * 1000);
    this._playbackUntil = Math.max(now, this._playbackUntil) + durationMs;
    this._lastAudioQueuedAt = now;
    if (!this._nativeAec) this.duplex.queuePlayback(buf);
    try {
      const writable = this.playProc.stdin.write(buf);
      if (!this._playbackStartedForTurn) {
        this._playbackStartedForTurn = true;
        this.emit('telemetry', 'playback.started', { queuedAudioMs: durationMs });
      }
      return writable;
    } catch (e) { return false; }
  }

  _waitForPlayback() {
    return new Promise(resolve => {
      const check = () => {
        if (this.closed || this._externalPlaybackCancelled || Date.now() >= this._playbackUntil) return resolve();
        const timer = setTimeout(check, Math.min(40, Math.max(5, this._playbackUntil - Date.now())));
        timer.unref?.();
      };
      check();
    });
  }

  _flushPlayback() {
    if (this._externalPlayProc) {
      this._externalPlaybackCancelled = true;
      try { this._externalPlayProc.kill('SIGKILL'); } catch (e) {}
      this._externalPlayProc = null;
    }
    this._stopPlayback();
    this._startPlayback();
    this.duplex.clearPlayback();
    this._resetBargeInCandidate();
    this._speakEndedAt = Date.now();
  }

  _stopPlayback() {
    if (this._duck) { clearTimeout(this._duck.timer); this._duck = null; }
    if (this._externalPlayProc) {
      this._externalPlaybackCancelled = true;
      try { this._externalPlayProc.kill('SIGKILL'); } catch (e) {}
      this._externalPlayProc = null;
    }
    this.playbackBuffer?.reset();
    this.playbackBuffer = null;
    if (this.playProc) { try { this.playProc.kill('SIGKILL'); } catch (e) {} this.playProc = null; }
    this._playbackUntil = Date.now();
    this.duplex.clearPlayback();
    this._resetBargeInCandidate();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._pendingAuthoritativeTurn?.timer) clearTimeout(this._pendingAuthoritativeTurn.timer);
    this._pendingAuthoritativeTurn = null;
    clearInterval(this._wakeSyncTimer);
    this.cancelRunningTasks();
    this._stopPlayback();
    if (this.ws) {
      try {
        if (typeof this.ws.removeAllListeners === 'function') this.ws.removeAllListeners();
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    this.emit('close');
  }
}

module.exports = {
  RealtimeSession, resample16to24, needsGroundedAnswer, needsContextGrounding,
  needsExpertAnswer, needsBackgroundAgentTask, isUnverifiedAgentResult, collectGrounding, matchDirectFastAction, prepareSpokenAnswer,
  buildSessionUpdate, loadInstructions, runFullAgent, confirmationPrompt, buildTools, verifyActionResult
};
