#!/usr/bin/env node
/**
 * JARVIS Daemon v5.0 — BLAZING FAST
 * ────────────────────────────────────
 *  • node-record-lpcm16   → continuous mic stream, no ffmpeg spawns
 *  • Porcupine.js         → offline hotword (frame-level, ~32ms latency)
 *  • Rolling buffer        → 50 % overlap chunks, hotword never split
 *  • STT promises pool    → pre-spawned children, no spawn delay
 *  • Zero-disk audio      → everything in Buffer, base64 to STT via pipe
 *
 * Latency stack:
 *   Hotword:     0.03–0.15 s  (Porcupine frame-level)
 *   STT start:   0.10–0.30 s  (promise pool, no spawn)
 *   Total cmd:   ~1.0 s       (silence-based, adaptive threshold)
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const { PROJECT_DIR } = require('./core/paths');
process.chdir(PROJECT_DIR);

// The openclaw agent reads skill/core code from ~/.openclaw/workspace (a separate
// copy), not from PROJECT_DIR. Syncing used to be manual and went stale for weeks,
// leaving several skills (memory, desktop-control, google-calendar, gmail,
// phone-control, ...) invisible to the agent. It now runs automatically, silently
// and quickly (diff-based) on every boot/restart.
try {
  require('child_process').execFileSync('bash', [require('path').join(PROJECT_DIR, 'scripts', 'sync-workspace.sh')], { timeout: 20000, stdio: 'ignore' });
} catch (e) { wrnEarly('sync-workspace.sh failed: ' + e.message); }
function wrnEarly(msg) { try { console.warn('⚠️  ' + msg); } catch (_) {} }

const { writeMemory, searchMemory, upsertTurnMemory } = require('./skills/memory');
const { RealtimeSession } = require('./skills/realtime-voice');
const { NativeMic, ensureNativeMicBinary } = require('./core/native-mic');
const { MissionStore: GoalMissionStore } = require('./core/missions/store');
const { createMissionApi } = require('./core/missions/api');
const { JarvisRuntime } = require('./core/jarvis-runtime');
const { VoiceFlightRecorder } = require('./core/voice-flight-recorder');
const { MissionControl, stableId } = require('./core/mission-control');
const { ProactivePolicy } = require('./core/proactive-policy');
const { createSkillPlatform } = require('./skills/platform');
const { ok, er, inf, wrn } = require('./core/log');
const { makeWavHeader, pcmToWavBuffer, getEnergy, getPeakAmplitude } = require('./core/audio-utils');
const { buildSoxCaptureArgs } = require('./core/mic-capture');
const { RollingBuffer } = require('./core/rolling-buffer');
const { HotwordDetector } = require('./core/hotword-detector');
const { OpenWakeWordDetector } = require('./core/openwakeword-detector');
const { WhisperWakeDetector } = require('./core/whisper-wake-detector');
const { findWakeRecognition, extractAddressedCommand } = require('./core/wake-word-policy');
const { VoiceLiveWake } = require('./core/voicelive-wake');
const { TurnJournal } = require('./core/turn-journal');
const { ConversationContext } = require('./core/conversation-context');
const { ClapDetector } = require('./core/clap-detector');
const { STTPool } = require('./core/stt-pool');
const { detectWakeSoundMs, playWakeSound, playSystemSound, playTaskDoneSound } = require('./core/voice-sounds');
const { buildVoiceProviders } = require('./core/voice-provider');
const { createAgentBridge } = require('./core/agent-bridge');
const { resolveOpenClawEnvironment } = require('./core/openclaw-credentials');
const { conversationIdleDelay } = require('./core/voice-turn-policy');
const { createWakeAudioHandoff } = require('./core/wake-audio-handoff');
const { isComplexTask, needsStrongAgentModel } = require('./core/model-routing');
const { VoiceTelemetry, VOICE_MILESTONES } = require('./utils/telemetry');
const { RuntimeTelemetry } = require('./core/runtime-telemetry');

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return; }
      resolve({ stdout, stderr });
    });
  });
}

function runNodeWithInput(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], { cwd: PROJECT_DIR, stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`)));
    child.stdin.end(input);
  });
}

const ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8');
function env(k) { const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; }

// Returns the local (timezone-aware) date. toISOString() returns UTC, so at UTC+8
// Obsidian entries written before 08:00 local time landed in "yesterday's" file.
function localDateStr(d) {
  d = d || new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

const TOKEN = env('TELEGRAM_BOT_TOKEN');
const CHAT_ID = env('JARVIS_CHAT_ID') || '';
const AZURE_OPENAI_KEY = env('AZURE_OPENAI_KEY');
const PICOVOICE_ACCESS_KEY = env('PICOVOICE_ACCESS_KEY');
const OPENWAKEWORD_ENABLED = (env('OPENWAKEWORD_ENABLED') || 'true') !== 'false';
const OPENWAKEWORD_PYTHON = path.join(PROJECT_DIR, '.venv-openwakeword', 'bin', 'python');
const STARTUP_NOTICE_FILE = path.join(PROJECT_DIR, '.run', 'telegram-startup-notice.json');
const STARTUP_NOTICE_COOLDOWN_MS = 30 * 60 * 1000;

function shouldSendStartupNotice(now = Date.now()) {
  try {
    const previous = JSON.parse(fs.readFileSync(STARTUP_NOTICE_FILE, 'utf8'));
    if (Number.isFinite(previous.sentAt) && now - previous.sentAt < STARTUP_NOTICE_COOLDOWN_MS) return false;
  } catch (e) {}
  try {
    fs.mkdirSync(path.dirname(STARTUP_NOTICE_FILE), { recursive: true });
    fs.writeFileSync(STARTUP_NOTICE_FILE, JSON.stringify({ sentAt: now }));
  } catch (e) {}
  return true;
}

// ── Config ──────────────────────────────────────────────
const SAMPLE_RATE = 16000;
const MIC_FILTER_ENABLED = !/^(?:false|0|no|off)$/i.test(env('MIC_FILTER_ENABLED') || 'true');
const MIC_HIGHPASS_HZ = parseFloat(env('MIC_HIGHPASS_HZ')) || 80;
const MIC_LOWPASS_HZ = parseFloat(env('MIC_LOWPASS_HZ')) || 7600;
const CHUNK_MS = 1200;             // overlap window (ms), long enough to contain a whole "Jarvis"
const STEP_MS = 150;               // faster wake inference cadence without reducing confidence
const ENERGY_MIN_STT = parseFloat(env('ENERGY_MIN_STT')) || 120; // keep the backup working on quiet microphones
const ENERGY_TARGET = 1500;        // adaptive gain target — low, no clip
const SILENCE_MS = parseInt(env('SILENCE_MS'), 10) || 450;            // natural speech end pause
const VOICE_ACTIVITY_THRESHOLD = parseFloat(env('VOICE_ACTIVITY_THRESHOLD')) || 15; // voice activity threshold
const CMD_MAX = 5.0;               // max command length (s)
const GAIN_MAX = 8, GAIN_MIN = 2; // gain limits, to avoid clipping
const HOTWORD_COOLDOWN_MS = parseInt(env('HOTWORD_COOLDOWN_MS'), 10) || 3000;
const OPENWAKEWORD_INPUT_GAIN = Math.max(1, Math.min(6, parseFloat(env('OPENWAKEWORD_INPUT_GAIN')) || 3));
const WHISPER_WAKE_ENABLED = (env('WHISPER_WAKE_ENABLED') || 'false') === 'true';
const WHISPER_WAKE_BINARY = env('WHISPER_WAKE_BINARY');
const WHISPER_WAKE_MODEL = env('WHISPER_WAKE_MODEL');
const WHISPER_WAKE_LANGUAGE = env('WHISPER_WAKE_LANGUAGE') || 'en';
const WHISPER_WAKE_WINDOW_MS = parseInt(env('WHISPER_WAKE_WINDOW_MS'), 10) || 3000;
const WHISPER_WAKE_INTERVAL_MS = parseInt(env('WHISPER_WAKE_INTERVAL_MS'), 10) || 1500;
const WHISPER_WAKE_COOLDOWN_MS = parseInt(env('WHISPER_WAKE_COOLDOWN_MS'), 10) || 5000;
const WHISPER_WAKE_TIMEOUT_MS = parseInt(env('WHISPER_WAKE_TIMEOUT_MS'), 10) || 15000;
const WHISPER_WAKE_COLD_START_TIMEOUT_MS = parseInt(env('WHISPER_WAKE_COLD_START_TIMEOUT_MS'), 10) || 45000;
const WAKE_STT_SILENCE_MS = 420;
const WAKE_STT_MAX_MS = 2200;
const WAKE_STT_PREROLL_MS = 450;
const WAKE_STT_MIN_SPEECH_MS = 480;

const hasVoiceProviders = Boolean(buildVoiceProviders(env).length);
const REALTIME_ENABLED = hasVoiceProviders && (env('REALTIME_ENABLED') || 'true') !== 'false'; // true realtime (speech-to-speech) conversation mode
const NATIVE_AEC = (env('JARVIS_NATIVE_AEC') || 'true') !== 'false';
// Tool names safe to store in voice telemetry (free-form run_task descriptions are not).
const TELEMETRY_TOOL_NAMES = new Set(['background_agent', 'fast_action', 'communication', 'ask_expert', 'recall_memory', 'save_memory',
  'manage_tasks', 'cancel_task', 'close_app', 'file_op', 'undo_last', 'web_open', 'see_screen']);
// Always-listening is active only when a cloud realtime provider is available
const ALWAYS_LISTEN = hasVoiceProviders && (env('JARVIS_ALWAYS_LISTEN') || 'true') !== 'false';
const ALWAYS_LISTEN_MAX_AGE_MS = Math.max(5, parseInt(env('ALWAYS_LISTEN_MAX_AGE_MIN'), 10) || 25) * 60000;
const REALTIME_IDLE_MS = parseInt(env('REALTIME_IDLE_MS'), 10) || 20000;  // end the conversation after this much silence
// If provider VAD loses a `speech_stopped` event, the idle timer may never re-arm.
// This independent watchdog recovers a stuck realtime session; it is much longer
// than the normal 20 s follow-up window, so it never cuts a natural conversation.
const REALTIME_STALE_SESSION_MS = Math.max(75000, parseInt(env('REALTIME_STALE_SESSION_MS'), 10) || 75000);
// If the provider sends `speech_started` but loses `speech_stopped`, the normal idle
// timer deliberately stays disarmed. Cap how long one speech turn may last so such a
// stuck VAD state cannot block later Fn triggers.
const REALTIME_MAX_USER_SPEECH_MS = Math.max(30000, parseInt(env('REALTIME_MAX_USER_SPEECH_MS'), 10) || 45000);
const REALTIME_WAKE_PREROLL_MS = parseInt(env('REALTIME_WAKE_PREROLL_MS'), 10) || 1800;
const CONVERSATION_FOLLOWUP_MS = parseInt(env('CONVERSATION_FOLLOWUP_MS'), 10) || 30000; // window to keep talking without "Jarvis" (after a reply)
const ACTION_CONFIRMATION_TTL_MS = parseInt(env('ACTION_CONFIRMATION_TTL_MS'), 10) || 30000;
const TURN_STALE_TIMEOUT_MS = Math.max(30000, parseInt(env('TURN_STALE_TIMEOUT_MS'), 10) || 600000);

// State of live tasks running in parallel (run_task). The dashboard reads it via
// /api/realtime-tasks to show its "what is JARVIS working on" panel. Daemon and
// dashboard are separate processes, so they share a file (simpler than extra IPC).
const REALTIME_TASKS_STATE_FILE = path.join(PROJECT_DIR, '.realtime-tasks-state.json');
const RUNTIME_STATE_FILE = path.join(PROJECT_DIR, '.jarvis-runtime.json');
const RUNTIME_TELEMETRY_FILE = path.join(PROJECT_DIR, '.run', 'telemetry.json');
const VOICE_FLIGHT_RECORDER_FILE = path.join(PROJECT_DIR, '.run', 'voice-flight-recorder.jsonl');
const MISSION_CONTROL_FILE = path.join(PROJECT_DIR, '.mission-control.json');
const REALTIME_TASKS_MAX = 15;
let _realtimeTasks = [];
const runtime = new JarvisRuntime({
  statusFile: RUNTIME_STATE_FILE,
  commandWindowMs: parseInt(env('COMMAND_DEDUP_MS'), 10) || 5000,
  responseWindowMs: parseInt(env('RESPONSE_DEDUP_MS'), 10) || 15000
});
const runtimeTelemetry = new RuntimeTelemetry({ file: RUNTIME_TELEMETRY_FILE });
const DAEMON_STARTED_AT = Date.now();
const runtimeIdentity = () => ({ pid: process.pid, startedAt: DAEMON_STARTED_AT });
const missions = new MissionControl({ file: MISSION_CONTROL_FILE, defaultMaxAttempts: 3 });
const skillPlatform = createSkillPlatform({ projectDir: PROJECT_DIR, env });
// Autonomous missions (hours or days) run in a separate runner process (core/mission-runner.js); the daemon is only a bridge.
const goalMissionStore = new GoalMissionStore({ dir: path.join(PROJECT_DIR, '.run', 'missions') });
const goalMissionApi = createMissionApi(goalMissionStore);
let goalEventOffset = goalMissionStore.eventsOffset();
const GOAL_VOICE_EVENTS = new Set(['mission.completed', 'mission.blocked', 'mission.failed', 'mission.needs_approval', 'usage.alert']);
setInterval(() => {
  try {
    const { events, offset } = goalMissionStore.readEventsSince(goalEventOffset);
    goalEventOffset = offset;
    for (const event of events) {
      if (!GOAL_VOICE_EVENTS.has(event.kind) || !_activeRealtimeSession) continue;
      _activeRealtimeSession.announce(event.text);
    }
  } catch (_) {}
}, 3000).unref();
const conversationContext = new ConversationContext({ windowMs: CONVERSATION_FOLLOWUP_MS });
const turnJournal = new TurnJournal({
  file: path.join(PROJECT_DIR, '.run', 'addressed-turns.jsonl'),
  sidecarFile: path.join(PROJECT_DIR, '.run', 'addressed-turns.materialized.json'),
  materialize: upsertTurnMemory,
  retryMs: 750,
  maxRetries: 4,
  maxBytes: parseInt(env('TURN_JOURNAL_MAX_BYTES'), 10) || 8 * 1024 * 1024,
  retentionFiles: parseInt(env('TURN_JOURNAL_RETENTION_FILES'), 10) || 5
});
turnJournal.on('error', (error, context) => {
  wrn(`Turn memory write failed (${context.turnId}, attempt ${context.attempt + 1}): ${error.message || error}`);
  runtime.heartbeat('memory-write', { status: 'error', turnId: context.turnId, error: String(error.message || error).slice(0, 250) });
});
turnJournal.on('materialized', (turn, metrics) => {
  runtime.observeLatency('memory-write', metrics.durationMs);
  runtime.heartbeat('memory-write', { status: 'ready', turnId: turn.turnId, latencyMs: metrics.durationMs, origin: metrics.origin });
  if (metrics.origin !== 'replay' && turn.status === 'completed') setTimeout(() => embedIndexJob.run(), 500).unref?.();
});
const recoveredMissions = missions.recoverStale();
if (recoveredMissions) console.log('Mission Control: ' + recoveredMissions + ' ta stale worker tiklandi');
runtime.on('runtime.error', error => console.error('Jarvis runtime state error:', error.message));

function resultLooksSuccessful(result) {
  if (result === null || result === undefined || result === false) return false;
  const text = String(result || '').trim();
  return text.length > 0 && !/^(?:null|undefined|false|\[\s*\]|\{\s*\})$/i.test(text) &&
    !/\b(xato|error|failed|bajarilmadi|uddalay olmadim|muvaffaqiyatsiz|permission denied|ruxsat yo.q|timeout)\b/i.test(text);
}

function beginSingleStepMission(goal, options = {}) {
  const mission = missions.createMission(goal, options);
  const current = missions.getMission(mission.id);
  let step = current.steps.find(item => item.status === 'running');
  if (!step) step = missions.claimNext(mission.id, options.worker || 'jarvis-daemon');
  return { mission: missions.getMission(mission.id), step };
}

function recordMissionResult(missionId, stepId, result, evidence = {}) {
  if (!stepId) return null;
  if (result && typeof result === 'object') return missions.completeStep(missionId, stepId, result);
  if (typeof result === 'string' && /^\s*\{/.test(result)) {
    let structured = null;
    try { structured = JSON.parse(result); } catch (_) {}
    if (structured) return missions.completeStep(missionId, stepId, structured);
  }
  if (!resultLooksSuccessful(result)) return missions.failStep(missionId, stepId, result || 'Empty result');
  missions.submitResult(missionId, stepId, result, evidence);
  return missions.verifyStep(missionId, stepId, { ok: true, method: evidence.type || 'agent-result' });
}
function saveRealtimeTasksState() {
  fs.promises.writeFile(REALTIME_TASKS_STATE_FILE, JSON.stringify(_realtimeTasks.slice(-REALTIME_TASKS_MAX))).catch(() => {});
}
function rtTaskStarted(callId, description) {
  _realtimeTasks.push({ callId, description, status: 'in_progress', result: null, startedAt: Date.now(), completedAt: null });
  if (_realtimeTasks.length > REALTIME_TASKS_MAX) _realtimeTasks = _realtimeTasks.slice(-REALTIME_TASKS_MAX);
  saveRealtimeTasksState();
}
function rtTaskCompleted(callId, result) {
  const t = _realtimeTasks.find(x => x.callId === callId && x.status === 'in_progress');
  if (t) { t.status = resultLooksSuccessful(result) ? 'completed' : 'failed'; t.result = String(result || '').slice(0, 500); t.completedAt = Date.now(); }
  saveRealtimeTasksState();
}

// Clap detection is opt-in because keyboard and desk knocks caused many false triggers.
// The reliable primary triggers are "Hey Jarvis" and Fn push-to-talk.
const CLAP_TRIGGER_ENABLED = (env('CLAP_TRIGGER_ENABLED') || 'false') === 'true';
const CLAP_SPIKE_RATIO = parseFloat(env('CLAP_SPIKE_RATIO')) || 4;     // spike, tinch fondan necha barobar baland
const CLAP_ABS_FLOOR = parseFloat(env('CLAP_ABS_FLOOR')) || 250;       // absolute minimum spike (even in a very quiet room)
// The remaining clap timing constants (quiet ratio, min/max gap) live in
// core/clap-detector.js; that module's defaults match the old values here.

let _gain = 2.0;  // START LOW — adapt, don't clip

inf('JARVIS v5.1 BLAZING — 16 kHz stream | local wake-word | STT fallback');

// ── WAKE SOUND ── As soon as a trigger fires, a short original synthetic
// acknowledgement chime plays without waiting for the Realtime connection. A
// pre-recorded human voice clashed with Cedar's timbre and held the microphone for
// 0.94 s; a 180 ms chime keeps every spoken reply in the canonical voice.
const WAKE_SOUND_PATH = path.join(PROJECT_DIR, 'assets', 'wake-chime.wav');

// While this sound plays the microphone is NOT sent to the live session at all
// (so JARVIS never hears itself as the user). That makes it fully DEAD time: user
// speech is not heard either, so the sound must be as SHORT as possible (the old
// spoken acknowledgement was 0.84 s; the new chime is 0.18 s). The duration is
// READ from the file, so swapping the file never leaves a stale hand-coded number.
const WAKE_SOUND_MS = detectWakeSoundMs(WAKE_SOUND_PATH);

// ════════════════════════════════════════════
// TELEGRAM / TTS / AGENT BRIDGE (core/agent-bridge.js)
// ════════════════════════════════════════════
const { sendTelegram, sendTelegramVoice, ttsToFile, askOpenClaw, agentProviders, askAgent } = createAgentBridge({
  chatIds: [env('TELEGRAM_OWNER_IDS')],
  chatId: CHAT_ID, token: TOKEN, projectDir: PROJECT_DIR, env, azureOpenAiKey: AZURE_OPENAI_KEY,
  openClawEnvironment: resolveOpenClawEnvironment({ projectDir: PROJECT_DIR }),
  skillPlatform, runtime, telemetry: runtimeTelemetry
});

// ════════════════════════════════════════════
// BACKGROUND JOBS (core/background-jobs/*.js). Each one loads its own state file
// and dependencies; only enabling and scheduling happens here. proactivePolicy is
// shared by both proactive and urgent checks.
// ════════════════════════════════════════════
const { createProactiveCheckJob } = require('./core/background-jobs/proactive-check');
const { createUrgentCheckJob } = require('./core/background-jobs/urgent-check');
const { createDailySynthesisJob } = require('./core/background-jobs/daily-synthesis-job');
const { createDailyTasksJob } = require('./core/background-jobs/daily-tasks-job');
const { createDailyReportJob } = require('./core/background-jobs/daily-report-job');
const { createMorningBriefJob } = require('./core/background-jobs/morning-brief-job');
const { AmbientContext } = require('./core/ambient-context');
const { HealthWatchdog, kickstart } = require('./core/health-watchdog');
const { collectMacOSContext } = require('./core/macos-context');
const { createProjectsJob } = require('./core/background-jobs/projects-job');
const { createFastActionLearnJob } = require('./core/background-jobs/fast-action-learn-job');
const { createEmbedIndexJob } = require('./core/background-jobs/embed-index-job');

// PROACTIVE MODE: periodically reviews the Obsidian memory the screen monitor
// writes; when the agent finds something genuinely useful it suggests it via
// Telegram or voice. It never acts on its own (no clicks or typing) without
// asking; it only observes and suggests.
const PROACTIVE_ENABLED_RT = (env('PROACTIVE_ENABLED') || 'false') === 'true';
const PROACTIVE_INTERVAL_MIN_RT = parseInt(env('PROACTIVE_INTERVAL_MIN'), 10) || 30;
const proactivePolicy = new ProactivePolicy({
  file: path.join(PROJECT_DIR, '.proactive-policy.json'),
  cooldownMs: (parseInt(env('PROACTIVE_COOLDOWN_MIN'), 10) || 30) * 60e3,
  dailySuggestionBudget: parseInt(env('PROACTIVE_DAILY_BUDGET'), 10) || 8,
  defaultContext: {
    privacyMode: /^(?:true|1|yes|on)$/i.test(env('JARVIS_PRIVACY_MODE') || 'false'),
    focusMode: /^(?:true|1|yes|on)$/i.test(env('JARVIS_FOCUS_MODE') || 'false'),
    meeting: /^(?:true|1|yes|on)$/i.test(env('JARVIS_MEETING_MODE') || 'false')
  }
});
const proactiveCheckJob = createProactiveCheckJob({
  projectDir: PROJECT_DIR, intervalMin: PROACTIVE_INTERVAL_MIN_RT, localDateStr, proactivePolicy, askAgent, sendTelegram, ttsToFile
});
if (PROACTIVE_ENABLED_RT) {
  inf('Proactive mode enabled: checking every ' + PROACTIVE_INTERVAL_MIN_RT + ' minutes');
  setInterval(() => { proactiveCheckJob.run().catch(() => {}); }, PROACTIVE_INTERVAL_MIN_RT * 60 * 1000);
}

// URGENT screen alerts. Unlike the 30-minute proactive cycle, entries the screen
// monitor tagged #urgent (errors/crashes, security, deadlines) are checked much
// more often (every 3 minutes by default) and announced IMMEDIATELY by voice and
// Telegram.
const URGENT_CHECK_ENABLED = (env('URGENT_CHECK_ENABLED') || 'true') !== 'false';
const URGENT_CHECK_INTERVAL_MIN = parseInt(env('URGENT_CHECK_INTERVAL_MIN'), 10) || 3;
const urgentCheckJob = createUrgentCheckJob({ projectDir: PROJECT_DIR, localDateStr, proactivePolicy, askAgent, sendTelegram, ttsToFile });
if (URGENT_CHECK_ENABLED) {
  inf('Urgent screen alerts enabled: checking every ' + URGENT_CHECK_INTERVAL_MIN + ' minutes');
  setInterval(() => { urgentCheckJob.run().catch(() => {}); }, URGENT_CHECK_INTERVAL_MIN * 60 * 1000);
}

// Daily learning: distils stable patterns from raw observations into the profile.
// The skill remembers which days it already processed, so frequent calls are safe
// (nothing runs twice).
const SYNTHESIS_ENABLED = (env('DAILY_SYNTHESIS_ENABLED') || 'true') !== 'false';
const dailySynthesisJob = createDailySynthesisJob({ sendTelegram });
if (SYNTHESIS_ENABLED) {
  inf('Daily learning enabled');
  setTimeout(() => { dailySynthesisJob.run(); }, 2 * 60 * 1000);          // shortly after startup
  setInterval(() => { dailySynthesisJob.run(); }, 60 * 60 * 1000);        // then check every hour
}

// DAILY TASKS: the Obsidian list (skills/tasks). Listed items need no separate
// permission and run automatically one after another during the day (SOUL.md
// Boundaries still apply: irreversible actions are still confirmed).
const DAILY_TASKS_ENABLED = (env('DAILY_TASKS_ENABLED') || 'true') !== 'false';
const DAILY_TASK_LEAD_MIN = Math.max(0, parseInt(env('DAILY_TASK_LEAD_MIN'), 10) || 0);
const dailyTasksJob = createDailyTasksJob({
  projectDir: PROJECT_DIR, localDateStr, leadMin: DAILY_TASK_LEAD_MIN, stableId, beginSingleStepMission, recordMissionResult, askAgent, sendTelegram, writeMemory
});
if (DAILY_TASKS_ENABLED) {
  inf('Daily tasks mode enabled');
  setTimeout(() => { dailyTasksJob.run().catch(() => {}); }, 3 * 60 * 1000);
  setInterval(() => { dailyTasksJob.run().catch(() => {}); }, 20 * 60 * 1000);
}

// DAILY SELF-REPORT: at the end of the (local) day, everything done autonomously
// today is summarised and announced via Telegram and voice. With full autonomy
// granted, this keeps things transparent instead of requiring oversight.
const DAILY_REPORT_ENABLED = (env('DAILY_REPORT_ENABLED') || 'true') !== 'false';
const DAILY_REPORT_HOUR = parseInt(env('DAILY_REPORT_HOUR'), 10) || 22; // mahalliy soat
const dailyReportJob = createDailyReportJob({
  projectDir: PROJECT_DIR, localDateStr, reportHour: DAILY_REPORT_HOUR, askAgent, sendTelegram, writeMemory, ttsToFile
});
if (DAILY_REPORT_ENABLED) {
  inf('Daily report enabled: every day after ' + DAILY_REPORT_HOUR + ':00');
  setInterval(() => { dailyReportJob.run().catch(() => {}); }, 15 * 60 * 1000);
}

// PEAK: morning brief, screen context, self-healing.
if ((env('MORNING_BRIEF_ENABLED') || 'true') !== 'false') {
  const morningBrief = createMorningBriefJob({
    projectDir: PROJECT_DIR, localDateStr, hour: parseInt(env('MORNING_BRIEF_HOUR'), 10) || 8,
    getMissions: () => goalMissionStore.list(),
    getUsage: () => { const d = new Date(Date.now() - 86400000); return require('./core/usage-meter').sharedMeter().totals(require('./core/usage-meter').dayKey(d.getTime())); },
    getYesterday: async () => '',
    getEvents: async () => { const r = await require('./skills/google-calendar').listEvents(1, 8); return r.status === 'ok' ? r.events.filter(e => String(e.start || '').slice(0, 10) === localDateStr()) : []; },
    getUnread: async () => { const r = await require('./skills/gmail').listMessages('is:unread category:primary newer_than:2d', 10); return r.status === 'ok' ? r.messages : []; },
    sendTelegram,
    announce: text => { try { if (_activeRealtimeSession) _activeRealtimeSession.announce(text.replace(/\n/g, ' ')); } catch (_) {} }
  });
  setInterval(() => { morningBrief.run().catch(() => {}); }, 5 * 60 * 1000);
  setTimeout(() => { morningBrief.run().catch(() => {}); }, 20000);
}
if ((env('AMBIENT_CONTEXT') || 'true') !== 'false') {
  new AmbientContext({ file: path.join(PROJECT_DIR, '.run', 'ambient-context.json'), collect: collectMacOSContext, intervalMs: parseInt(env('AMBIENT_INTERVAL_MS'), 10) || 5000 }).start();
}
if ((env('HEALTH_WATCHDOG') || 'true') !== 'false') {
  const httpOk = url => fetch(url, { signal: AbortSignal.timeout(4000) }).then(r => r.ok).catch(() => false);
  new HealthWatchdog({
    notify: sendTelegram,
    checks: [
      { name: 'OpenClaw gateway', probe: () => httpOk('http://127.0.0.1:18789/health'), heal: kickstart('ai.openclaw.gateway') },
      { name: 'Mission runner', probe: async () => { try { return Date.now() - JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, '.run', 'missions', 'runner.json'), 'utf8')).at < 30000; } catch (_) { return false; } }, heal: kickstart('com.jarvis.mission-runner') }
    ]
  }).start();
}

// PROJECTS: multi-step autonomous work done in sequence during the day
// (skills/projects). Steps run in ONE shared session, and a SEPARATE final report
// is delivered when the project finishes.
const PROJECTS_ENABLED = (env('PROJECTS_ENABLED') || 'true') !== 'false';
const PROJECT_STEP_MAX_ATTEMPTS = parseInt(env('PROJECT_STEP_MAX_ATTEMPTS'), 10) || 2;
const projectsJob = createProjectsJob({
  missions, stableId, beginSingleStepMission, recordMissionResult, stepMaxAttempts: PROJECT_STEP_MAX_ATTEMPTS, askAgent, sendTelegram, writeMemory
});
if (PROJECTS_ENABLED) {
  inf('Multi-step projects mode enabled');
  setTimeout(() => { projectsJob.run().catch(() => {}); }, 4 * 60 * 1000);
  setInterval(() => { projectsJob.run().catch(() => {}); }, 15 * 60 * 1000);
}

// FAST-ACTION LEARNING: periodically reviews recent days' tasks in Obsidian memory,
// finds "just open some app"-style requests not yet in the fast-actions list,
// and adds them automatically.
const FAST_ACTION_LEARN_ENABLED = (env('FAST_ACTION_LEARN_ENABLED') || 'true') !== 'false';
const FAST_ACTION_LEARN_INTERVAL_MIN = parseInt(env('FAST_ACTION_LEARN_INTERVAL_MIN'), 10) || 720; // every 12 hours
const fastActionLearnJob = createFastActionLearnJob({ projectDir: PROJECT_DIR, localDateStr, askAgent, sendTelegram, writeMemory, skillPlatform });
if (FAST_ACTION_LEARN_ENABLED) {
  inf('Fast-action learning enabled: checking every ' + FAST_ACTION_LEARN_INTERVAL_MIN + ' minutes');
  setTimeout(() => { fastActionLearnJob.run().catch(() => {}); }, 10 * 60 * 1000);
  setInterval(() => { fastActionLearnJob.run().catch(() => {}); }, FAST_ACTION_LEARN_INTERVAL_MIN * 60 * 1000);
}

// BACKGROUND MEMORY INDEXING: for semantic (meaning-based) search to cover the
// whole history, every new memory block must be indexed. That happens regularly in
// the background, so searches always read a ready index and answer instantly.
const EMBED_INDEX_ENABLED = (env('EMBED_INDEX_ENABLED') || 'true') !== 'false';
const EMBED_INDEX_INTERVAL_MIN = parseInt(env('EMBED_INDEX_INTERVAL_MIN'), 10) || 15;
const embedIndexJob = createEmbedIndexJob();
if (EMBED_INDEX_ENABLED) {
  inf('Memory index refreshes in the background every ' + EMBED_INDEX_INTERVAL_MIN + ' minutes');
  setTimeout(() => { embedIndexJob.run(); }, 60 * 1000);
  setInterval(() => { embedIndexJob.run(); }, EMBED_INDEX_INTERVAL_MIN * 60 * 1000);
}
turnJournal.startWatchdog({ maxAgeMs: TURN_STALE_TIMEOUT_MS, reason: 'turn watchdog timeout' });
// Recovery runs in slices (the event loop is never blocked); entries already written are skipped via the sidecar.
turnJournal.replayAsync().then(replayResult => {
  runtime.heartbeat('memory-recovery', { status: 'ready', ...replayResult });
  if (replayResult.replayed > 0) {
    inf(`Turn journal recovery: re-materialized ${replayResult.replayed} terminal turns (${replayResult.alreadyMaterialized || 0} were already written)`);
    if (EMBED_INDEX_ENABLED) setTimeout(() => embedIndexJob.run(), 500).unref?.();
  }
}).catch(error => wrn('Turn journal recovery error: ' + (error.message || error)));

function adaptGain(energy) {
  if (energy < ENERGY_MIN_STT) _gain = Math.min(_gain * 1.2, GAIN_MAX);
  else if (energy > ENERGY_TARGET * 2.5) _gain = Math.max(_gain * 0.8, GAIN_MIN);
  else _gain = Math.max(_gain * 0.97, GAIN_MIN); // slow drift down
  return _gain;
}

// Adaptive gain on raw PCM buffer (simple gain multiply, no filtering)
function applyGain(pcm16, gain) {
  if (gain === 1.0 || gain === undefined) return pcm16;
  for (let i = 0; i < pcm16.length; i += 2) {
    const v = pcm16.readInt16LE(i);
    const nv = Math.max(-32768, Math.min(32767, Math.round(v * gain)));
    pcm16.writeInt16LE(nv, i);
  }
  return pcm16;
}

// ════════════════════════════════════════════
// MAIN DAEMON STATE
// ════════════════════════════════════════════
let _sttPool = null;
let _detector = null;
let _whisperWakeDetector = null;
  let _voiceLiveWake = null;
let _clap = null;
let _sox = null;
let _soxStream = null;
let _activeRealtimeSession = null;
let _realtimeFailureCount = 0;
let _realtimeDisabledUntil = 0;
const REALTIME_FAILURE_LIMIT = parseInt(env('REALTIME_FAILURE_LIMIT'), 10) || 3;
const REALTIME_COOLDOWN_MS = parseInt(env('REALTIME_COOLDOWN_MS'), 10) || 120000;
let inConversation = false;
let state = 'listening';
let resumeConversationListening = () => {};

// ════════════════════════════════════════════
// CONTINUOUS LISTENING ARCHITECTURE (ffmpeg → PCM)
// ════════════════════════════════════════════
const STEP_BYTES = Math.floor((STEP_MS * SAMPLE_RATE * 2) / 1000);   // 4800 bytes
const CHUNK_SAMPLES = Math.floor((CHUNK_MS * SAMPLE_RATE) / 1000);   // 5600 samples

function startMicProcess() {
  const capture = spawn('sox', buildSoxCaptureArgs({
    sampleRate: SAMPLE_RATE,
    filterEnabled: MIC_FILTER_ENABLED,
    highpassHz: MIC_HIGHPASS_HZ,
    lowpassHz: MIC_LOWPASS_HZ
  }));
  capture.on('error', (err) => er('Mic process error: ' + err.message));
  capture.stderr.on('data', () => {});
  return capture;
}

async function mainLoop() {
  _sttPool = new STTPool({ size: 2, projectDir: PROJECT_DIR, env });
  _clap = CLAP_TRIGGER_ENABLED ? new ClapDetector({ absFloor: CLAP_ABS_FLOOR, spikeRatio: CLAP_SPIKE_RATIO }) : null;
  if (OPENWAKEWORD_ENABLED && fs.existsSync(OPENWAKEWORD_PYTHON)) {
    _detector = new OpenWakeWordDetector({ projectDir: PROJECT_DIR, pythonPath: OPENWAKEWORD_PYTHON, env, sampleRate: SAMPLE_RATE });
  } else if (PICOVOICE_ACCESS_KEY && PICOVOICE_ACCESS_KEY.length > 10) {
    try {
      const { Porcupine, BuiltinKeyword, getBuiltinKeywordPath } = require('@picovoice/porcupine-node');
      _detector = new HotwordDetector(PICOVOICE_ACCESS_KEY, Porcupine, getBuiltinKeywordPath(BuiltinKeyword.JARVIS));
    } catch (e) {
      wrn('Porcupine yuklanmadi — STT backup faol: ' + e.message);
    }
  } else {
    wrn('openWakeWord is not installed; using the STT backup. Run scripts/setup-openwakeword.sh');
  }
  if (WHISPER_WAKE_ENABLED) {
    _whisperWakeDetector = new WhisperWakeDetector({
      binaryPath: WHISPER_WAKE_BINARY,
      modelPath: WHISPER_WAKE_MODEL,
      language: WHISPER_WAKE_LANGUAGE,
      sampleRate: SAMPLE_RATE,
      windowMs: WHISPER_WAKE_WINDOW_MS,
      intervalMs: WHISPER_WAKE_INTERVAL_MS,
      cooldownMs: WHISPER_WAKE_COOLDOWN_MS,
      timeoutMs: WHISPER_WAKE_TIMEOUT_MS,
      coldStartTimeoutMs: WHISPER_WAKE_COLD_START_TIMEOUT_MS,
      onReady: () => ok('whisper.cpp local wake transcript detector ready'),
      onError: error => wrn('whisper.cpp wake detector: ' + error.message),
      onWake: ({ transcript }) => {
        if (state !== 'listening' || Date.now() - lastHotwordTime <= HOTWORD_COOLDOWN_MS) return;
        triggerVoice('🔥 HOTWORD (whisper.cpp): "' + transcript.slice(0, 120) + '"', {
          addressedWake: true,
          playAck: true
        });
      }
    });
    _whisperWakeDetector.start();
  }

  // If Azure VoiceLive is configured, create a lightweight wake worker that
  // keeps a transcription/VAD-only session open and emits transcripts.
  try {
    // The cloud VoiceLive wake worker opens an extra connection and could wake JARVIS twice alongside the local
    // openWakeWord/Whisper detectors, so it only starts when explicitly enabled (AZURE_VOICELIVE_WAKE_ENABLED=true).
    const wakeEnabled = (env('AZURE_VOICELIVE_WAKE_ENABLED') || 'false') === 'true';
    const vlProvider = wakeEnabled ? require('./core/voice-provider').buildVoiceProviders(env).find(p => p.id === 'voice-live') : null;
    if (vlProvider && wakeEnabled) {
      _voiceLiveWake = new VoiceLiveWake({
        provider: vlProvider,
        prefixPaddingMs: parseInt(env('AZURE_VOICELIVE_WAKE_PREFIX_PADDING_MS') || '80', 10),
        silenceMs: parseInt(env('AZURE_VOICELIVE_WAKE_SILENCE_MS') || '200', 10),
        model: env('AZURE_VOICELIVE_MODEL') || undefined,
        voice: vlProvider.voice,
        inputRate: parseInt(env('MIC_CAPTURE_RATE') || String(16000), 10)
      });
      _voiceLiveWake.on('ready', () => ok('VoiceLive wake worker ready'));
      _voiceLiveWake.on('error', e => wrn('VoiceLive wake worker error: ' + (e && e.message ? e.message : String(e))));
      _voiceLiveWake.on('transcript', ({ text }) => {
        try {
          const recognized = text || '';
          if (!recognized) return;
          const candidate = findWakeRecognition([{ status: 'ok', text: recognized }]);
          if (candidate && state === 'listening' && Date.now() - lastHotwordTime > HOTWORD_COOLDOWN_MS) {
            triggerVoice('🔥 HOTWORD (voicelive): "' + candidate.text + '"', {
              addressedWake: true,
              initialTranscript: candidate.text.replace(/^(?:jarvis\s*)/i, '').trim(),
              playAck: true
            });
          }
        } catch (e) { wrn('VoiceLive wake transcript handler failed: ' + (e && e.message ? e.message : String(e))); }
      });
      _voiceLiveWake.start();
    }
  } catch (e) { wrn('VoiceLive wake init failed: ' + (e && e.message ? e.message : String(e))); }

  // Start sox for continuous raw PCM
  _sox = startMicProcess();
  _soxStream = _sox.stdout;

  const rolling = new RollingBuffer(5000);
  let stepBuffer = Buffer.alloc(0);
  let nextStepTime = 0;
  let lastHotwordTime = 0;
  let lastSttCheck = 0;
  let sttBackupInFlight = false;
  let lastSttBackupNotice = 0;
  let wakeSpeechBuffers = [];
  let wakeSpeechStartedAt = 0;
  let wakeSpeechLastVoiceAt = 0;
  state = 'listening'; // 'listening' | 'realtime' | 'command_record' | 'processing'
  let cmdBuffers = [];
  let lastVoiceTime = 0;
  let cmdStartTime = 0;
  let cmdSpeechStarted = false;
  inConversation = false;
  let lastConversationActivityAt = 0;
  // Fn is not push-to-talk: it is a trigger that opens a hands-free realtime conversation.
  // Once the session is open, server VAD splits turns at natural pauses.
  let fnPressed = false;
  let lastFnDownAt = 0;
  let restartFromFn = false;
  let _startingRealtimeSession = false;
  // The Mac microphone's real quiet RMS measured 100-200 in tests. Starting at 40
  // treated noise as speech and sent STT segments non-stop.
  let ambientEnergy = ENERGY_MIN_STT;

  function submitWakeStt(pcm, measuredEnergy) {
    if (!pcm.length || sttBackupInFlight || Date.now() - lastSttCheck < 900) return;
    lastSttCheck = Date.now();
    sttBackupInFlight = true;
    const gain = Math.max(1, Math.min(5, ENERGY_TARGET / Math.max(measuredEnergy, 1)));
    const wavBuf = pcmToWavBuffer(applyGain(Buffer.from(pcm), gain));
    inf('STT wake segment (' + Math.round(pcm.length / (SAMPLE_RATE * 2) * 1000) + 'ms, energy=' + Math.round(measuredEnergy) + ')...');
    // Local openWakeWord is primary. Two independent locale decoders run in
    // parallel as a fallback: this catches both plain/accented "Jarvis" and
    // the known cross-locale phonetic fingerprint without adding serial wait.
    Promise.all([
      _sttPool.recognize(wavBuf, 'en-US', { localOnly: true }),
      _sttPool.recognize(wavBuf, 'uz-UZ', { localOnly: true })
    ]).then(results => {
      const heard = results.filter(r => r && r.status === 'ok' && r.text);
      if (heard.length) {
        inf('STT wake heard: ' + heard.map(r => '"' + r.text + '"').join(' / '));
        const wake = findWakeRecognition(heard);
        if (wake && state === 'listening' && Date.now() - lastHotwordTime > HOTWORD_COOLDOWN_MS) {
          triggerVoice('🔥 HOTWORD (hybrid STT): "' + wake.text + '"', {
            addressedWake: true,
            // The wake fallback recognises exactly the wake segment. A random trailing
            // word that STT appended is not executed as a command; the separate turn
            // after the chime is the real command.
            initialTranscript: '',
            playAck: true
          });
        }
      } else {
        const failed = results.find(r => r && r.reason && !['NoMatch', 'nomatch', 'unknown'].includes(r.reason));
        if (!failed || Date.now() - lastSttBackupNotice <= 60000) return;
        lastSttBackupNotice = Date.now();
        wrn('STT backup temporarily did not respond: ' + failed.reason);
      }
    }).catch(e => {
      if (Date.now() - lastSttBackupNotice > 60000) {
        lastSttBackupNotice = Date.now();
        wrn('STT backup temporarily failed: ' + (e.message || e));
      }
    }).finally(() => { sttBackupInFlight = false; });
  }

  // English Realtime owns STT, VAD, conversation and speech. Grok Fast handles
  // normal reasoning, GPT-5.6 Sol handles complex reasoning and executable tasks.
  function startRealtimeSession(reason, trigger = {}) {
    if (_startingRealtimeSession || _activeRealtimeSession || state !== 'listening') return false;
    _startingRealtimeSession = true;
    try {
      // Open the conversation window for the first command after the wake word.
      if (trigger.addressedWake) conversationContext.touch();

    const session = new RealtimeSession({
      // Bridge to background missions: start/status/control return in milliseconds (the voice conversation never blocks).
      missions: goalMissionApi,
      // A session woken by "Jarvis" also answers only within the short conversation window after the
      // first command (CONVERSATION_FOLLOWUP_MS after a reply) or when "Jarvis" is said again.
      // This used to apply only to always-on mode, so in a wake session any room talk (TV, other
      // people, misheard words) was treated as addressed to JARVIS.
      wakeRequired: Boolean(trigger.alwaysOn || trigger.addressedWake),
      // The Fn hands-free trigger confirms the user is addressing JARVIS for the
      // whole open session, so the media background gate does not block follow-ups.
      // A wake-word trigger only grants a one-time bypass for the first meaningful turn.
      explicitUserSession: reason.includes('Fn'),
      explicitUserTrigger: Boolean(trigger.addressedWake),
      addressedWakeTrigger: Boolean(trigger.addressedWake && !trigger.initialTranscript),
      initialTranscript: trigger.initialTranscript || '',
      // English Realtime STT is the single source of truth for both wake-word
      // and push-to-talk sessions. Do not add a second language decoder here:
      // competing transcripts increase latency and can route the wrong action.
      conversationContext,
      actionConfirmationTtlMs: ACTION_CONFIRMATION_TTL_MS,
      // RealtimeSession's default askExpert() spawns the `openclaw agent` CLI (the
      // same primary model as run_task), so the genuinely strong `deep-think` path
      // (Grok Fast or GPT-5.6 Sol, called directly via the Azure Responses API with
      // no tool loop, hence faster) was never used. Wiring it here sends both
      // `ask_expert` and the deterministic expert/grounding path to the strong model.
      expertAnswer: async (question, callId, grounding) => {
        try {
          return await skillPlatform.invoke('deep-think', 'askExpert', { question, context: grounding });
        } catch (e) {
          return "I couldn't reach the reasoning service.";
        }
      },
      // fast-actions now run through the SkillPlatform, so a hung action (e.g. an
      // osascript waiting on a permission dialog) is bounded by the platform's
      // timeout/circuit breaker even if it never rejects on its own.
      fastActionRunner: (id) => skillPlatform.invoke('fast-actions', 'runFastAction', { id })
    });
    const flightRecorder = new VoiceFlightRecorder({ file: VOICE_FLIGHT_RECORDER_FILE });
    const voiceTelemetry = new VoiceTelemetry({
      file: path.join(PROJECT_DIR, '.run', 'voice-latency.jsonl'),
      sessionId: flightRecorder.beginSession({ trigger: reason, mode: reason.includes('Fn') ? 'fn-hands-free' : 'wake-word' })
    });
    if (!trigger.alwaysOn) voiceTelemetry.event(VOICE_MILESTONES.WAKE_DETECTED, { trigger: reason.includes('Fn') ? 'fn' : 'wake-word' });
    runtime.beginConversation(reason.includes('Fn') ? 'fn-hands-free' : 'wake-word');
    const connectStartedAt = Date.now();
    _activeRealtimeSession = session;
    // macOS Voice Processing (FaceTime-grade echo cancellation): until it is ready, or if it fails,
    // the plain microphone + local AEC path keeps working.
    let nativeMic = null;
    let nativeMicLastAt = 0;
    if (NATIVE_AEC && NativeMic.isSupported()) {
      nativeMic = new NativeMic();
      nativeMic.on('data', chunk => {
        if (session.closed) return;
        nativeMicLastAt = Date.now();
        if (!session._nativeAec) { session.enableNativeAec(); inf('🎧 Native AEC (Voice Processing) enabled'); }
        const queued = typeof session._jarvisQueueWakeAudio === 'function' && session._jarvisQueueWakeAudio(Buffer.from(chunk));
        if (!queued && Date.now() >= (session._jarvisWakeMuteUntil || 0)) session.feedAudio(chunk);
      });
      nativeMic.on('exit', info => {
        session.disableNativeAec('helper-exit');
        if (!session.closed) wrn('Native AEC stopped (' + (info.error || info.code) + '); fell back to the plain microphone path');
      });
      nativeMic.on('unavailable', reason => { wrn('Native AEC unavailable: ' + reason); });
      nativeMic.start();
    }
    state = 'realtime';
    lastHotwordTime = Date.now();
    // Hotword and Fn both give the user the same short synthetic chime at once.
    // Microphone audio is dropped during the ack; otherwise the chime from the
    // speaker enters the preroll and the server takes it as user speech. If the
    // connection is not ready when the ack ends, the real command is collected in
    // a bounded preroll and sent as soon as it is ready. WAKE_SOUND_MS already
    // includes a 100 ms audio-driver guard; a second guard here would needlessly
    // drop the user's first words.
    const shouldPlayAck = trigger.playAck !== false;
    const wakeMuteUntil = shouldPlayAck ? Date.now() + WAKE_SOUND_MS : 0;
    if (shouldPlayAck) playWakeSound(WAKE_SOUND_PATH);
    let idleTimer = null;
    let staleSessionTimer = null;
    let lastRealtimeActivityAt = Date.now();
    const sessionStartedAt = Date.now();
    let finished = false;
    let sessionWasReady = false;
    let lastUserTranscript = '';
    let currentTurnId = '';
    const pendingTurnIds = [];
    let activeToolCount = 0;
    let awaitingFollowup = false;
    // Provider VAD may send speech_started before session.updated/ready. In that
    // case the ready handler must not arm an idle timer that wrongly closes the
    // ongoing speech after REALTIME_IDLE_MS.
    let userSpeaking = false;
    let userSpeechStartedAt = 0;
    const toolTurns = new Map();
    let speechStoppedAt = 0;
    let transcriptAcceptedAt = 0;
    let firstAudioObserved = false;
    const maxWakePrerollBytes = Math.ceil(SAMPLE_RATE * 2 * REALTIME_WAKE_PREROLL_MS / 1000);
    const wakeAudioHandoff = createWakeAudioHandoff({
      muteUntil: wakeMuteUntil,
      maxBytes: maxWakePrerollBytes,
      initialChunks: trigger.seedAudio?.length
        ? [Buffer.from(trigger.seedAudio)] : []
    });

    // The microphone loop calls these hooks for every live chunk. Audio emitted
    // while the acknowledgement chime is playing must be discarded, not sent
    // to provider VAD. Genuine post-chime speech is retained in a bounded
    // preroll until the websocket is ready, then normal streaming takes over.
    session._jarvisWakeMuteUntil = wakeMuteUntil;
    session._jarvisQueueWakeAudio = chunk => wakeAudioHandoff.queue(chunk);

    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      // No silence timer runs during an active VAD turn. It is re-armed once
      // speech_stopped closes the transcription window.
      if (userSpeaking) return;
      if (trigger.alwaysOn) return;   // an always-on session is not closed on silence
      const delay = conversationIdleDelay({
        now: Date.now(),
        idleMs: REALTIME_IDLE_MS,
        // The connection stays open for REALTIME_IDLE_MS of silence (no reconnect wait); the window for
        // replying without "Jarvis" is separate and managed by conversationContext (CONVERSATION_FOLLOWUP_MS).
        followupMs: Math.max(CONVERSATION_FOLLOWUP_MS, REALTIME_IDLE_MS),
        playbackUntil: session._playbackUntil,
        awaitingFollowup
      });
      idleTimer = setTimeout(() => {
        // Closing the session cancels running run_task processes, so keep
        // extending the timeout until a result arrives.
        if (activeToolCount > 0) return armIdleTimer();
        finishRealtimeSession('idle timeout');
      }, delay);
    };
    const markRealtimeActivity = () => { lastRealtimeActivityAt = Date.now(); };
    staleSessionTimer = setInterval(() => {
      if (nativeMic && session._nativeAec && Date.now() - nativeMicLastAt > 2000) session.disableNativeAec('no-frames');
      if (finished || activeToolCount > 0) return;
      if (userSpeaking && Date.now() - userSpeechStartedAt >= REALTIME_MAX_USER_SPEECH_MS) {
        runtimeTelemetry.vadWatchdogTimeout();
        wrn('Realtime VAD speech_stopped bermadi (' + Math.round((Date.now() - userSpeechStartedAt) / 1000) + 's) — stuck turn yopilyapti');
        finishRealtimeSession('VAD speech timeout');
        return;
      }
      if (trigger.alwaysOn) {
        // A long-open session can go stale server-side; refresh it periodically (during silence).
        if (Date.now() - sessionStartedAt > ALWAYS_LISTEN_MAX_AGE_MS && !userSpeaking && !session.assistantSpeaking) finishRealtimeSession('always-on yangilanmoqda');
        return;
      }
      const inactiveMs = Date.now() - lastRealtimeActivityAt;
      if (inactiveMs < REALTIME_STALE_SESSION_MS) return;
      wrn('Realtime session inactive for ' + Math.round(inactiveMs / 1000) + 's; closing it to recover');
      finishRealtimeSession('faolliksiz realtime watchdog');
    }, 5000);
    staleSessionTimer.unref?.();
    const finishRealtimeSession = (why) => {
      if (finished) return;
      finished = true;
      for (const [callId, turnId] of toolTurns) {
        turnJournal.append(turnId, 'tool.cancelled', { callId, reason: why });
      }
      toolTurns.clear();
      while (pendingTurnIds.length) {
        turnJournal.append(pendingTurnIds.shift(), /xato|error/i.test(why) ? 'turn.failed' : 'turn.cancelled', { reason: why });
      }
      flightRecorder.endSession(why);
      clearTimeout(idleTimer);
      clearInterval(staleSessionTimer);
      try { nativeMic?.stop(); } catch (e) {}
      if (_activeRealtimeSession === session) _activeRealtimeSession = null;
      try { session.close(); } catch (e) {}
      state = 'listening';
      runtime.endConversation(why);
      runtime.heartbeat('voice-daemon', { state, ...runtimeIdentity() });
      nextStepTime = Date.now();
      inf('Realtime conversation ended: ' + why);
      if (restartFromFn) {
        restartFromFn = false;
        // A new session opens after the close() callbacks finish and the state
        // returns to listening, which is how Fn recovers a stuck realtime session.
        setTimeout(() => triggerVoice('⌨️ Fn hands-free conversation'), 0);
      } else scheduleAlwaysOn(1500);
    };

    session.on('ready', () => {
      markRealtimeActivity();
      sessionWasReady = true;
      _realtimeFailureCount = 0;
      _realtimeDisabledUntil = 0;
      runtime.observeLatency('realtime-connect', Date.now() - connectStartedAt);
      runtime.setConversationMode('listening');
      runtime.heartbeat('realtime-api', { status: 'ready' });
      ok('Realtime voice session connected');
      // A "Hey Jarvis, ..." command spoken during the wake chime/handshake is
      // forwarded once the session is ready instead of being lost.
      for (const chunk of wakeAudioHandoff.drain()) session.feedAudio(chunk);
      wakeAudioHandoff.markReady();
      armIdleTimer();
    });
    session.on('provider', ({ id }) => {
      markRealtimeActivity();
      runtime.heartbeat('realtime-api', { status: 'ready', provider: id });
      inf('Voice provider: ' + id);
    });
    session.on('audio_activity', () => { markRealtimeActivity(); armIdleTimer(); });
    session.on('user_speaking', () => {
      userSpeaking = true;
      runtimeTelemetry.speechStarted();
      userSpeechStartedAt = Date.now();
      markRealtimeActivity();
      awaitingFollowup = false;
      const turnId = flightRecorder.beginTurn({ source: 'realtime', trigger: reason });
      voiceTelemetry.event(VOICE_MILESTONES.WAKE_DETECTED, { trigger: 'provider-vad' }, { turnId });
      runtime.setConversationMode('user-speaking');
      clearTimeout(idleTimer);
    });
    session.on('user_speech_stopped', () => {
      userSpeaking = false;
      runtimeTelemetry.speechStopped();
      userSpeechStartedAt = 0;
      markRealtimeActivity();
      speechStoppedAt = Date.now();
      transcriptAcceptedAt = 0;
      firstAudioObserved = false;
      armIdleTimer();
    });
    session.on('turn_suppressed', (reason, text) => {
      markRealtimeActivity();
      if (reason === 'no-wake') return;   // room talk: never recorded anywhere
      flightRecorder.textEvent('turn.suppressed', text, { reason });
      if (reason !== 'no-wake' && reason !== 'wake-only') inf('🔇 Realtime turn bloklandi (' + reason + '): ' + String(text || '').slice(0, 100));
      runtime.setConversationMode('listening');
      if (reason === 'wake-only' && !shouldPlayAck) playWakeSound(WAKE_SOUND_PATH);
      armIdleTimer();
    });
    session.on('user_transcript', (text) => {
      markRealtimeActivity();
      const clean = String(text || '').trim();
      if (!clean) return;
      const accepted = runtime.acceptCommand(clean, { source: 'realtime-transcript' });
      if (!accepted.accepted) {
        wrn('Takror realtime transkript tashlandi: ' + clean);
        return;
      }
      lastUserTranscript = clean;
      currentTurnId = turnJournal.createTurn('voice');
      pendingTurnIds.push(currentTurnId);
      turnJournal.append(currentTurnId, 'user.accepted', { text: clean, source: 'realtime' });
      transcriptAcceptedAt = Date.now();
      if (speechStoppedAt) runtime.observeLatency('speech-to-transcript', transcriptAcceptedAt - speechStoppedAt);
      flightRecorder.textEvent('command.accepted', clean, { source: 'realtime-transcript' });
      voiceTelemetry.event(VOICE_MILESTONES.STT_FINISHED, { source: 'realtime-transcript' }, { turnId: flightRecorder.activeTurnId });
      runtime.setConversationMode('thinking');
      inf('🎙 Realtime: ' + clean);
      sendTelegram('🎙 ' + clean);
      armIdleTimer();
    });
    session.on('assistant_transcript', (text, response = {}) => {
      markRealtimeActivity();
      const clean = String(text || '').trim();
      if (!clean) return;
      const accepted = runtime.acceptResponse(clean);
      if (!accepted.accepted) {
        wrn('Duplicate realtime reply not written to log/memory');
        return;
      }
      runtime.setConversationMode('speaking');
      flightRecorder.textEvent('assistant.transcript', clean);
      ok('🤖 Realtime: ' + clean.substring(0, 120));
      sendTelegram('🤖 ' + clean);
      const assistantTurnId = pendingTurnIds.shift() || currentTurnId;
      if (assistantTurnId) {
        if (response.status && response.status !== 'completed') {
          turnJournal.append(assistantTurnId, 'assistant.recorded', { text: clean });
          const type = /cancel/i.test(response.status + ' ' + response.reason) ? 'turn.cancelled' : 'turn.failed';
          turnJournal.append(assistantTurnId, type, { reason: response.reason || response.status });
        } else turnJournal.append(assistantTurnId, 'assistant.completed', { text: clean });
      }
      lastUserTranscript = '';
      awaitingFollowup = true;
      armIdleTimer();
    });
    session.on('turn_done', ({ status, interrupted } = {}) => {
      markRealtimeActivity();
      // A cancelled/incomplete response.done may arrive late, after barge-in opened
      // the next speech turn. Only a successful response confirmed by the provider
      // may mark the active turn completed.
      if (status === 'completed' && !interrupted) flightRecorder.event('turn.completed');
      if (status === 'completed' && !interrupted) awaitingFollowup = true;
      armIdleTimer();
    });
    session.on('response_status', ({ status, reason, hasAssistantTranscript }) => {
      if (hasAssistantTranscript || status === 'completed') return;
      const turnId = pendingTurnIds.shift() || currentTurnId;
      if (!turnId) return;
      const type = /cancel/i.test(status + ' ' + reason) ? 'turn.cancelled' : 'turn.failed';
      turnJournal.append(turnId, type, { reason: reason || status });
    });
    session.on('telemetry', (type, data) => {
      flightRecorder.event(type, data);
      const milestone = {
        'provider.request.sent': VOICE_MILESTONES.PROVIDER_REQUEST_SENT,
        'assistant.audio.first': VOICE_MILESTONES.FIRST_AUDIO_BYTE_RECEIVED,
        'playback.started': VOICE_MILESTONES.PLAYBACK_STARTED
      }[type];
      if (milestone) voiceTelemetry.event(milestone, { provider: session.provider?.id }, { turnId: flightRecorder.activeTurnId });
      if (type === 'stt.authoritative.completed' && Number.isFinite(data?.durationMs)) {
        runtime.observeLatency('authoritative-stt', data.durationMs);
      }
      if (type === 'stt.selection' && Number.isFinite(data?.durationMs)) {
        runtime.observeLatency('stt-selection', data.durationMs);
        const recovered = data.source !== 'authoritative';
        runtime.heartbeat('azure-stt', {
          status: recovered ? 'degraded' : 'ready',
          source: data.source,
          latencyMs: data.durationMs
        });
      }
      if (type === 'stt.recovery') {
        runtime.heartbeat('azure-stt', { status: 'degraded', recovery: data?.source || 'native-fallback' });
      }
      if (type === 'stt.timeout') {
        runtime.heartbeat('azure-stt', { status: 'error', error: 'authoritative STT timeout' });
      }
      if (type !== 'assistant.audio.first' || firstAudioObserved) return;
      firstAudioObserved = true;
      const now = Date.now();
      if (transcriptAcceptedAt) runtime.observeLatency('transcript-to-first-audio', now - transcriptAcceptedAt);
      if (speechStoppedAt) runtime.observeLatency('first-audio', now - speechStoppedAt);
      if (speechStoppedAt) {
        const profile = {
          requestId: currentTurnId,
          source: 'realtime',
          stt_ms: transcriptAcceptedAt ? transcriptAcceptedAt - speechStoppedAt : null,
          agent_ms: null,
          tts_ms: null,
          total_ms: now - speechStoppedAt
        };
        runtimeTelemetry.latency(profile);
        console.log(JSON.stringify({ event: 'response_latency', ...profile }));
      }
    });
    session.on('tool_call', (description, callId) => {
      markRealtimeActivity();
      activeToolCount += 1;
      // Only the tool-name prefix ("fast_action", "see_screen"), never user text, so slow tools can be found.
      const prefix = /^([a-z_]+):/.exec(String(description || ''))?.[1];
      const tool = TELEMETRY_TOOL_NAMES.has(prefix) ? prefix : 'run_task';
      flightRecorder.event('tool.started', { description, callId, tool });
      runtime.requestTask(description, { id: callId, source: 'realtime' });
      runtime.transitionTask(callId, 'running');
      beginSingleStepMission(description, {
        id: stableId('realtime', callId), source: 'realtime', idempotencyKey: 'realtime:' + callId
      });
      rtTaskStarted(callId, description);
      if (currentTurnId) {
        toolTurns.set(callId, currentTurnId);
        turnJournal.append(currentTurnId, 'tool.started', { description, callId });
      }
      inf('🛠 Live task: ' + description);
      armIdleTimer();
    });
    session.on('tool_result', (result, callId) => {
      markRealtimeActivity();
      activeToolCount = Math.max(0, activeToolCount - 1);
      flightRecorder.event('tool.completed', { result, callId });
      let ledgerResult = result;
      if (typeof result === 'string' && /^\s*\{/.test(result)) try { ledgerResult = JSON.parse(result); } catch (_) {}
      try { runtime.completeTask(callId, ledgerResult); } catch (e) { wrn('Task ledger: ' + e.message); }
      try {
        const missionId = stableId('realtime', callId);
        const mission = missions.getMission(missionId);
        const step = mission?.steps.find(item => item.status === 'running' || item.status === 'awaiting_verification');
        if (step) recordMissionResult(missionId, step.id, result, { type: 'tool-result', value: result });
      } catch (e) { wrn('Mission Control: ' + e.message); }
      rtTaskCompleted(callId, result);
      const toolTurnId = toolTurns.get(callId);
      if (toolTurnId) {
        turnJournal.append(toolTurnId, resultLooksSuccessful(result) ? 'tool.completed' : 'tool.failed', { callId, result });
        toolTurns.delete(callId);
      }
      const finishedTask = _realtimeTasks.find(t => t.callId === callId);
      if (finishedTask?.status === 'completed' && !/^fast_action:/i.test(String(finishedTask.description || ''))) playTaskDoneSound();
      armIdleTimer();
    });
    session.on('error', (err) => {
      flightRecorder.event('turn.failed', { error: String(err.message || err) });
      if (currentTurnId) turnJournal.append(currentTurnId, 'turn.failed', { error: String(err.message || err) });
      _realtimeFailureCount += 1;
      if (_realtimeFailureCount >= REALTIME_FAILURE_LIMIT) {
        _realtimeDisabledUntil = Date.now() + REALTIME_COOLDOWN_MS;
      }
      runtime.heartbeat('realtime-api', { status: 'error', error: String(err.message || err).slice(0, 300) });
      er('Realtime error: ' + (err.message || err));
      const shouldFallback = !sessionWasReady;
      finishRealtimeSession('error');
      if (shouldFallback && state === 'listening') {
        // If the connection itself fails, do not leave the user hanging: record
        // the audio after the wake sound through batch STT.
        state = 'command_record';
        cmdBuffers = [];
        cmdStartTime = Date.now();
        lastVoiceTime = cmdStartTime;
        wrn('Realtime not connected; the batch STT fallback is listening');
      }
    });
    session.on('close', () => {
      // A WebSocket often drops straight to 'close' without an 'error' (server-side
      // close or network loss). The heartbeat then stuck at its last 'ready' state
      // and diagnose-voice.js could not see the problem. If `finished` is still
      // false (not already ended by 'error' or the idle timeout), this is an
      // unexpected disconnect, so mark the state correctly.
      if (!finished && !session.closed) {
        if (currentTurnId) turnJournal.append(currentTurnId, 'turn.failed', { error: 'socket-closed-unexpectedly' });
        runtime.heartbeat('realtime-api', {
          status: sessionWasReady ? 'degraded' : 'error',
          reason: 'socket-closed-unexpectedly'
        });
        if (sessionWasReady) {
          // Always-listening sessions are periodically dropped by the server and reconnect on their own; no sound or message.
          if (!trigger.alwaysOn) {
            playSystemSound('Basso');
            sendTelegram('⚠️ The voice session disconnected unexpectedly. It will reconnect on the next invocation.');
          }
        }
      }
      finishRealtimeSession('connection closed');
    });

    inf(reason + ': connecting realtime conversation');
    session.connect();
    armIdleTimer();
    return true;
    } finally {
      _startingRealtimeSession = false;
    }
  }

  // Every trigger goes through one state transition. A reconstructed snapshot
  // once kept the triggerVoice calls but lost the function itself, so the daemon
  // crashed with a ReferenceError on Porcupine/clap detection. Fn DOWN opens the
  // hands-free conversation through here.
  // ── Always-listening session ──
  let alwaysOnTimer = null;
  function ensureAlwaysOnSession() {
    if (!ALWAYS_LISTEN || !REALTIME_ENABLED || _activeRealtimeSession || state !== 'listening' || Date.now() < _realtimeDisabledUntil) return false;
    inf('👂 Opening always-listening session (answers only when you say "Jarvis")');
    return startRealtimeSession('always-on', { alwaysOn: true, playAck: false });
  }
  function scheduleAlwaysOn(delay = 1500) {
    if (!ALWAYS_LISTEN) return;
    clearTimeout(alwaysOnTimer);
    alwaysOnTimer = setTimeout(ensureAlwaysOnSession, delay);
    alwaysOnTimer.unref?.();
  }
  if (ALWAYS_LISTEN) {
    scheduleAlwaysOn(4000);
    setInterval(ensureAlwaysOnSession, 7000).unref?.();
  }

  function triggerVoice(reason, trigger = {}) {
    const isFn = String(reason || '').includes('Fn');
    if (state !== 'listening' && !isFn) return false;
    if (isFn && (state === 'processing' || state === 'command_record')) {
      try { const { execSync } = require('child_process'); execSync('killall afplay >/dev/null 2>&1'); } catch (_) {}
    }
    inf('[triggerVoice] ' + reason + ' @' + new Date().toISOString() + ' trigger=' + JSON.stringify(trigger).slice(0,200));
    // The local model and the STT fallback listen in parallel. As soon as one
    // triggers, the other's half-collected segment is dropped; otherwise an old
    // "Hey Jarvis" would be prepended to the next utterance after realtime ends.
    wakeSpeechBuffers = [];
    wakeSpeechStartedAt = 0;
    wakeSpeechLastVoiceAt = 0;
    if (REALTIME_ENABLED && Date.now() >= _realtimeDisabledUntil) return startRealtimeSession(reason, trigger);
    if (REALTIME_ENABLED && _realtimeDisabledUntil > Date.now()) {
      runtime.heartbeat('realtime-api', {
        status: 'degraded',
        fallback: 'batch-stt',
        retryAt: _realtimeDisabledUntil
      });
      wrn('Realtime temporarily blocked; using the batch STT fallback');
    }
    const now = Date.now();
    lastHotwordTime = now;
    inConversation = true;
    lastConversationActivityAt = now;
    state = 'command_record';
    cmdBuffers = [];
    cmdStartTime = now;
    lastVoiceTime = now;
    cmdSpeechStarted = true;
    if (trigger.playAck !== false) playWakeSound(WAKE_SOUND_PATH);
    inf(reason + ': conversation opened, listening');
    return true;
  }

  resumeConversationListening = function() {
    const now = Date.now();
    inConversation = true;
    lastConversationActivityAt = now;
    state = 'command_record';
    cmdBuffers = [];
    cmdStartTime = now;
    lastVoiceTime = now;
    cmdSpeechStarted = true;
    inf('💬 Conversation continues (hands-free); go ahead and speak...');
  }

  const fnSocketPath = path.join(PROJECT_DIR, '.run', 'fnkey.sock');
  let fnClient = null;
  let fnRetry = null;
  function connectFnBroker() {
    if (fnClient && !fnClient.destroyed) return;
    fnClient = net.createConnection(fnSocketPath);
    let fnBuf = '';
    fnClient.on('connect', () => {
      fnPressed = false;
      inf('Fn-key broker connected');
    });
    fnClient.on('data', (data) => {
      fnBuf += data.toString();
      const lines = fnBuf.split('\n');
      fnBuf = lines.pop();
      for (const raw of lines) {
        const event = raw.trim();
        if (event === 'DOWN') {
          // A duplicate flagsChanged event must not open a second realtime session (400 ms debounce).
          if (fnPressed || Date.now() - lastFnDownAt < 400) continue;
          fnPressed = true;
          lastFnDownAt = Date.now();
          if (state === 'realtime' && _activeRealtimeSession && !_activeRealtimeSession.closed) {
            // Fn must always start a new conversation. If the idle timer/VAD had
            // not closed the session yet, it used to silently reject the next Fn.
            // An active agent task is never cancelled; in that case the existing
            // session is kept.
            if (_activeRealtimeSession._runningTasks?.size) {
              inf('Fn accepted: a task is running, keeping the current realtime conversation');
            } else if (_activeRealtimeSession._isSpeakingNow?.()) {
              inf('Fn pressed: current reply stopped (barge-in)');
              _activeRealtimeSession._stopSpeakingByUser?.('fn-pressed');
            } else {
              restartFromFn = true;
              const old = _activeRealtimeSession;
              _activeRealtimeSession = null;
              state = 'listening';
              try { old.close(); } catch (_) {}
              triggerVoice('⌨️ Fn hands-free conversation');
              restartFromFn = false;
            }
          } else {
            triggerVoice('⌨️ Fn hands-free conversation');
          }
        } else if (event === 'UP') {
          fnPressed = false;
          // Releasing Fn does not close the turn. The microphone keeps streaming for
          // the whole realtime session; provider VAD emits speech_stopped/transcripts
          // at natural pauses. Fn is not needed for follow-up speech.
        } else if (event === 'RESET') {
          fnPressed = false;
          lastFnDownAt = 0;
        }
      }
    });
    const reconnect = () => {
      fnPressed = false;
      if (fnRetry) return;
      fnRetry = setTimeout(() => { fnRetry = null; connectFnBroker(); }, 3000);
    };
    fnClient.on('error', reconnect);
    fnClient.on('close', reconnect);
  }
  connectFnBroker();

  inf('Mic stream started — listening for "Jarvis"...');
  if (NATIVE_AEC) {
    ensureNativeMicBinary({ onDone: status => {
      if (status === 'built') inf('🎧 Built the Voice Processing helper (native echo cancellation)');
      else if (status.startsWith('build-failed')) wrn('Native echo cancellation unavailable (' + status + '); run: bash scripts/build-voice-io.sh');
    } });
  }
  runtime.heartbeat('microphone', { status: 'streaming' });
  runtime.heartbeat('realtime-api', { status: 'ready', provider: hasVoiceProviders ? 'azure-realtime' : 'gemini-voice' });
  runtime.heartbeat('voice-daemon', { state: 'listening', ...runtimeIdentity() });
  const runtimeHeartbeat = setInterval(() => {
    runtime.heartbeat('voice-daemon', { state, realtime: Boolean(_activeRealtimeSession), ...runtimeIdentity() });
    runtime.heartbeat('microphone', { status: _sox && !_sox.killed ? 'streaming' : 'stopped' });
    if (_detector?.health) runtime.heartbeat('openwakeword', _detector.health());
  }, 5000);
  runtimeHeartbeat.unref();
  if (shouldSendStartupNotice()) sendTelegram('🚀 JARVIS v5.0 is online.');

  return new Promise((resolve, reject) => {
    _soxStream.on('data', (rawChunk) => {
      const now = Date.now();

      // Accumulate into 150ms steps
      stepBuffer = Buffer.concat([stepBuffer, rawChunk]);
      let stepData = null;
      while (stepBuffer.length >= STEP_BYTES) {
        stepData = stepBuffer.slice(0, STEP_BYTES);
        stepBuffer = stepBuffer.slice(STEP_BYTES);
        rolling.push(stepData);
        if (state === 'command_record') cmdBuffers.push(stepData);
        if (state === 'realtime' && _activeRealtimeSession) {
          // DuplexVoiceEngine inside RealtimeSession applies its calibration thresholds
          // in raw microphone RMS units and boosts outgoing speech to the target RMS
          // itself. Applying gain here as well turned room noise into "speech" and
          // left server VAD stuck in speech_started.
          const realtimeChunk = Buffer.from(stepData);
          const queued = !_activeRealtimeSession._nativeAec && typeof _activeRealtimeSession._jarvisQueueWakeAudio === 'function'
            && _activeRealtimeSession._jarvisQueueWakeAudio(realtimeChunk);
          if (!_activeRealtimeSession._nativeAec && !queued && now >= (_activeRealtimeSession._jarvisWakeMuteUntil || 0)) {
            _activeRealtimeSession.feedAudio(realtimeChunk);
          }
        }
        // While idle (listening), also feed the lightweight VoiceLive wake worker
        // so the cloud model can provide robust multilingual wake detection.
        if (state === 'listening' && _voiceLiveWake) {
          try {
            const sent = _voiceLiveWake.feedAudio(stepData);
            if (!sent) wrn('VoiceLive wake worker did not accept audio (ws not ready or queue full)');
          } catch (e) { wrn('VoiceLive wake feedAudio error: ' + (e && e.message ? e.message : String(e))); }
        }
      }

      // ── STATE: LISTENING ──
      if (state === 'listening') {
        // Only check on step boundaries (every 150ms)
        if (now < nextStepTime) return;
        const elapsed = now - nextStepTime + STEP_MS; // simple: if this is a step, process
        if (stepData) {
          nextStepTime = now + STEP_MS;

          // Double clap uses PEAK amplitude (not RMS/getEnergy): a clap is a very
          // short impulse; averaged over a 200 ms window (RMS) it blended into the
          // quiet background and was often missed. Peak keeps the highest spike.
          if (_clap) {
            const stepPeak = getPeakAmplitude(stepData);
            const clapHit = _clap.feedEnergy(stepPeak, now);
            if ((now % 3000) < STEP_MS) inf('Clap peak=' + Math.round(stepPeak) + ' baseline=' + Math.round(_clap.baseline) + ' threshold=' + Math.round(_clap.threshold));
            if (clapHit && (now - lastHotwordTime > HOTWORD_COOLDOWN_MS)) {
              triggerVoice('👏 HOTWORD (ikki marta qarsak)');
              return;
            }
          }

          // Only the new PCM step goes to the local detector; sending the rolling
          // overlap would run inference on the same audio again and again.
          let detected = null;
          if (_detector) {
            detected = _detector.processChunk(applyGain(Buffer.from(stepData), OPENWAKEWORD_INPUT_GAIN));
          }

          // Whisper is an opt-in local transcript fallback, never a parallel
          // command STT. Feed it only while idle/listening; once a realtime
          // conversation begins Azure Realtime owns STT, VAD and barge-in.
          if (_whisperWakeDetector && (!_detector || !_detector.ready)) _whisperWakeDetector.feedChunk(stepData);

          if (detected && (now - lastHotwordTime > HOTWORD_COOLDOWN_MS)) {
              const wakeModel = detected.model || 'hey_jarvis';
              triggerVoice('🔥 HOTWORD: "' + wakeModel.replace(/_/g, ' ') + '" (openWakeWord)', {
                addressedWake: true,
                // The user must know the wake was accepted without looking.
                // After the 180 ms chime, a bounded preroll keeps the command.
                playAck: true,
                seedAudio: rolling.sliceLast(REALTIME_WAKE_PREROLL_MS)
              });
            return;
          }

          // STT backup: runs only while openWakeWord is not ready, or when explicitly enabled.
          const energy = getEnergy(stepData);
          adaptGain(energy);
          if (env('DEBUG_ENERGY') === 'true' && (now % 2000) < 200) inf('Energy=' + Math.round(energy) + ' gain=' + _gain.toFixed(1));

          const enableSttWake = (!_detector || !_detector.ready) || (env('JARVIS_STT_WAKE_BACKUP') === 'true');
          if (enableSttWake) {
            if (!wakeSpeechStartedAt && energy < ambientEnergy * 2.2) ambientEnergy = ambientEnergy * 0.97 + energy * 0.03;
            const adaptiveSttGate = Math.max(ENERGY_MIN_STT, ambientEnergy * 2.5);
            if (!wakeSpeechStartedAt && energy >= adaptiveSttGate) {
              wakeSpeechStartedAt = now;
              wakeSpeechLastVoiceAt = now;
              wakeSpeechBuffers = [Buffer.from(rolling.sliceLast(WAKE_STT_PREROLL_MS))];
            } else if (wakeSpeechStartedAt) {
              wakeSpeechBuffers.push(Buffer.from(stepData));
              if (energy >= Math.max(ENERGY_MIN_STT * 0.8, ambientEnergy * 1.7)) wakeSpeechLastVoiceAt = now;

              const speechAge = now - wakeSpeechStartedAt;
              const silenceAge = now - wakeSpeechLastVoiceAt;
              if ((silenceAge >= WAKE_STT_SILENCE_MS && speechAge >= WAKE_STT_MIN_SPEECH_MS) || speechAge >= WAKE_STT_MAX_MS) {
                const speechPcm = Buffer.concat(wakeSpeechBuffers);
                const speechEnergy = getEnergy(speechPcm);
                wakeSpeechBuffers = [];
                wakeSpeechStartedAt = 0;
                wakeSpeechLastVoiceAt = 0;
                submitWakeStt(speechPcm, speechEnergy);
              }
            }
          }
        }
      }

      // ── STATE: COMMAND RECORDING ──
      else if (state === 'command_record') {
        const elapsed = now - cmdStartTime;

        // Energy check every ~120ms
        if (elapsed % 120 < 30 && cmdBuffers.length > 2) {
          const recentPCM = Buffer.concat(cmdBuffers.slice(-3));
          const energy = getEnergy(recentPCM);
          if (energy > VOICE_ACTIVITY_THRESHOLD) {
            cmdSpeechStarted = true;
            lastVoiceTime = now;
          }
        }

        const silence = now - lastVoiceTime;
        const currentSilenceThreshold = inConversation ? 280 : Math.min(320, SILENCE_MS);
        const speechDone = cmdSpeechStarted
          ? (silence > currentSilenceThreshold && elapsed > 400)
          : (elapsed > (inConversation ? 4000 : 2500));

        if ((!fnPressed && speechDone) || elapsed > CMD_MAX * 1000) {
          if (!cmdSpeechStarted) {
            inConversation = false;
            state = 'listening';
            cmdBuffers = [];
            inf('Conversation ended automatically (silence)');
            return;
          }
          state = 'processing';
          const totalPCM = Buffer.concat(cmdBuffers);
          const wavBuf = pcmToWavBuffer(totalPCM);
          inf('Transcribing...');
          _sttPool.recognize(wavBuf, 'auto').then(r => {
            nextStepTime = Date.now(); // reset timing
            if (r && r.status === 'ok' && r.text && r.text.length > 1) {
              const cmd = r.text.trim();
              if (/^(\[(?:BLANK_AUDIO|no speech detected)\]|\([^)]+\)|\*+|\s*|\.+|\?+)$/i.test(cmd)) {
                if (inConversation) resumeConversationListening(); else state = 'listening';
                return;
              }
              ok('Buyruq: "' + cmd + '"');
              processCommand(cmd).catch(err => {
                er('processCommand error: ' + (err.message || err));
                if (inConversation) resumeConversationListening(); else state = 'listening';
              });
            } else {
              wrn('STT returned no result');
              if (inConversation) resumeConversationListening();
              else state = 'listening';
            }
          }).catch(err => {
            er('STT error: ' + (err.message || err));
            if (inConversation) resumeConversationListening();
            else state = 'listening';
          });
        }
      }
    });

    _soxStream.on('error', (err) => {
      er('Stream error: ' + err.message);
      reject(err);
    });

    _soxStream.on('end', () => {
      inf('Stream ended');
      resolve();
    });
  });
}

// ════════════════════════════════════════════
// PROCESS COMMAND
// ════════════════════════════════════════════
async function processCommand(command) {
  const acceptedCommand = runtime.acceptCommand(command, { source: 'batch-stt' });
  if (!acceptedCommand.accepted) {
    wrn('Takror batch buyruq tashlandi: ' + command);
    if (inConversation) resumeConversationListening(); else state = 'listening';
    return;
  }
  const batchTurnId = turnJournal.createTurn('batch-voice');
  turnJournal.append(batchTurnId, 'user.accepted', { text: command, source: 'batch-stt' });
  runtime.setConversationMode('thinking');
  const commandStartedAt = Date.now();
  inf('>>> ' + command); sendTelegram('🎙 ' + command);
  if (!fs.existsSync(path.join(PROJECT_DIR, '.jarvis-onboarded'))) {
    await fs.promises.writeFile(path.join(PROJECT_DIR, '.jarvis-onboarded'), 'true'); writeMemory('Onboard', 'start');
    const ap = await ttsToFile('Hello. I am Jarvis.'); if (ap) await execFileAsync('afplay', [ap]).catch(() => {});
  }

  // Stop/Standby intent
  if (/^(?:rahmat|bo'?ldi|to'?xtat|to'?xta|stop|cancel|goodbye|bye)\b/i.test(command)) {
    inConversation = false;
    state = 'listening';
    const ap = await ttsToFile('Standing by, sir.');
    if (ap) {
      await execFileAsync('afplay', [ap]).catch(() => {});
      try { fs.unlinkSync(ap); } catch (_) {}
    }
    turnJournal.append(batchTurnId, 'assistant.completed', { text: 'Standing by, sir.' });
    return;
  }

  // Quick commands
  if (/eslab qol|esda tut/i.test(command) && command.length > 15) {
    const cl = command.replace(/eslab qol|esda tut/gi, '').trim();
    writeMemory('Voice', cl, ['voice']); sendTelegram('✅ Remembered.');
    const ap = await ttsToFile('Remembered.'); if (ap) await execFileAsync('afplay', [ap]).catch(() => {});
    turnJournal.append(batchTurnId, 'assistant.completed', { text: 'Remembered.' });
    if (inConversation) resumeConversationListening(); else state = 'listening';
    return;
  }
  if (/kuzatishni (boshla|yo?qish)/i.test(command)) {
    await runNodeWithInput('skills/screen-monitor/index.js', '{"action":"start"}\n').catch(() => {});
    const ap = await ttsToFile('Monitoring enabled.'); if (ap) await execFileAsync('afplay', [ap]).catch(() => {});
    turnJournal.append(batchTurnId, 'assistant.completed', { text: 'Monitoring enabled.' });
    if (inConversation) resumeConversationListening(); else state = 'listening';
    return;
  }
  if (/kuzatishni (to.xtat|o.chir)/i.test(command)) {
    await runNodeWithInput('skills/screen-monitor/index.js', '{"action":"stop"}\n').catch(() => {});
    const ap = await ttsToFile('Monitoring disabled.'); if (ap) await execFileAsync('afplay', [ap]).catch(() => {});
    turnJournal.append(batchTurnId, 'assistant.completed', { text: 'Monitoring disabled.' });
    if (inConversation) resumeConversationListening(); else state = 'listening';
    return;
  }

  const appMatch = command.match(/(?:can you open|please open|open|och|ishga tushir)\s+(?:the\s+)?([a-z0-9\s_-]+)/i);
  if (appMatch) {
    const appName = appMatch[1].trim();
    if (appName && !['door', 'window', 'file', 'link', 'url'].includes(appName.toLowerCase())) {
      try {
        const { execSync } = require('child_process');
        execSync(`open -a "${appName}"`, { timeout: 3000, stdio: 'ignore' });
        const ap = await ttsToFile(`Opening ${appName}.`);
        if (ap) await execFileAsync('afplay', [ap]).catch(() => {});
        turnJournal.append(batchTurnId, 'assistant.completed', { text: `Opening ${appName}.` });
        if (inConversation) resumeConversationListening(); else state = 'listening';
        return;
      } catch (_) {}
    }
  }

  // Agent
  let mem = '';
  try {
    const q = command.split(/\s+/).filter(w => w.length > 3 && !['qanday','nima','kim'].includes(w.toLowerCase())).slice(0, 3).join(' ');
    if (q.length > 2) { const f = searchMemory(q, 3); if (f && f.status === 'ok' && f.results.length) mem = '\n[Xotira]:\n' + f.results.map(r => r.matches.map(m => m.text).join(' | ')).join('\n') + '\n'; }
  } catch(e){}

  // Route hard/complex tasks to the big model (Antigravity/Gemini Pro) in the background, without speaking them aloud
  const isHardTask = isComplexTask(command) || /\b(yoz|tuzat|kod|dastur|tekshir|skript|fayl|terminal|build|deploy|code|fix|refactor|analyze|investigate|git|clone|search|qidir|yarat|arxitektura|yozib ber)\b/i.test(command);
  if (isHardTask) {
    const ack = 'Right away, sir. Processing your task in the background. What else can I do for you?';
    const ackAudio = await ttsToFile(ack);
    if (ackAudio) {
      await execFileAsync('afplay', [ackAudio], { timeout: 10000 }).catch(() => {});
      try { fs.unlinkSync(ackAudio); } catch (_) {}
    }
    sendTelegram('⚙️ Started: ' + command);

    (async () => {
      try {
        let taskResult = null;
        try {
          const agySkill = require('./skills/antigravity');
          const agyRes = await agySkill.executePrompt(command, { effort: 'medium', timeoutMs: 180000 });
          if (agyRes && agyRes.output) taskResult = agyRes.output;
        } catch (_) {}
        if (!taskResult) {
          taskResult = await askAgent(mem + command, undefined, { source: 'background-task', routeText: command, persistent: true });
        }

        if (taskResult) {
          sendTelegram('✅ Task completed:\n\n' + taskResult.slice(0, 4000));
          turnJournal.append(batchTurnId, 'assistant.completed', { text: taskResult.slice(0, 4000) });
          if (state !== 'command_record') {
            const doneVoice = 'Task completed, sir. Full report sent to Telegram.';
            const doneAudio = await ttsToFile(doneVoice);
            if (doneAudio) {
              await execFileAsync('afplay', [doneAudio], { timeout: 10000 }).catch(() => {});
              try { fs.unlinkSync(doneAudio); } catch (_) {}
            }
          }
        }
      } catch (err) {
        sendTelegram('⚠️ Task failed: ' + err.message);
      }
    })();

    // Keep the conversation going: it does not stop while a background task runs
    if (inConversation) resumeConversationListening(); else state = 'listening';
    return;
  }

  const reply = await askAgent(mem + command, undefined, { source: 'voice', routeText: command });
  runtime.observeLatency('batch-agent', Date.now() - commandStartedAt);
  if (reply) {
    const acceptedResponse = runtime.acceptResponse(reply);
    if (!acceptedResponse.accepted) {
      wrn('Duplicate agent reply was not spoken');
      turnJournal.append(batchTurnId, 'turn.cancelled', { reason: 'duplicate-response' });
      if (inConversation) resumeConversationListening(); else state = 'listening';
      return;
    }
    runtime.setConversationMode('speaking');
    ok('<<< ' + reply.substring(0, 80)); sendTelegram('🤖 ' + reply);
    turnJournal.append(batchTurnId, 'assistant.completed', { text: reply.substring(0, 4000) });
    const audio = await ttsToFile(reply.substring(0, 400));
    if (audio) {
      await execFileAsync('afplay', [audio], { timeout: 15000 }).then(() => ok('🔊 Voice')).catch(() => {});
      (async () => {
        try {
          const ogg = audio.replace(/\.[^.\/]+$/, '') + '.ogg';
          await execFileAsync('ffmpeg', ['-nostdin', '-y', '-i', audio, '-c:a', 'libopus', ogg], { timeout: 6000 });
          await sendTelegramVoice(ogg);
          try { fs.unlinkSync(ogg); } catch(e){}
        } catch(e){}
        try { fs.unlinkSync(audio); } catch(e){}
      })();
    }
    if (inConversation) resumeConversationListening(); else state = 'listening';
  } else {
    const fallback = 'I could not prepare a response. Please say that again.';
    wrn('Agent returned an empty reply');
    turnJournal.append(batchTurnId, 'turn.failed', { reason: 'agent-empty-response' });
    sendTelegram('⚠️ ' + fallback);
    const audio = await ttsToFile(fallback);
    if (audio) {
      await execFileAsync('afplay', [audio], { stdio: 'ignore' }).catch(() => {});
      try { fs.unlinkSync(audio); } catch(e) {}
    }
    if (inConversation) resumeConversationListening(); else state = 'listening';
  }
}

// ════════════════════════════════════════════
// GRACEFUL EXIT
// ════════════════════════════════════════════
function cleanup(exitCode = 0) {
  inf('Shutting down...');
  if (_activeRealtimeSession) { try { _activeRealtimeSession.close(); } catch(e){} }
  if (_sox) { try { _sox.kill(); } catch(e){} }
  if (_detector) { try { _detector.release(); } catch(e){} }
  if (_whisperWakeDetector) { try { _whisperWakeDetector.release(); } catch(e){} }
  if (_sttPool) { _sttPool.killAll(); }
  try { runtime.close(); } catch(e) {}
  process.exit(exitCode);
}
process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));
process.on('SIGHUP', () => inf('SIGHUP received: the next action safety check re-reads the autonomy setting from .env.'));

// ════════════════════════════════════════════
// ENTRY
// ════════════════════════════════════════════
(async () => {
  try {
    await mainLoop();
  } catch (e) {
    er('FATAL: ' + e.message);
    cleanup(1);
  }
})();
