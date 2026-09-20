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

const { writeMemory, searchMemory, upsertTurnMemory } = require('./skills/memory');
const { RealtimeSession } = require('./skills/realtime-voice');
const { NativeMic } = require('./core/native-mic');
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
const { createAgentBridge } = require('./core/agent-bridge');
const { resolveOpenClawEnvironment } = require('./core/openclaw-credentials');
const { conversationIdleDelay } = require('./core/voice-turn-policy');
const { createWakeAudioHandoff } = require('./core/wake-audio-handoff');
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

// Mahalliy (timezone) sanani beradi — toISOString() UTC qaytaradi, shuning
// uchun UTC+8'da mahalliy soat 08:00gacha Obsidian yozuvlari "kechagi kun"
// fayliga tushib qolardi.
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
const CHUNK_MS = 1200;             // overlap window (ms) — "Jarvis" to'liq sig'ish uchun
const STEP_MS = 150;               // faster wake inference cadence without reducing confidence
const ENERGY_MIN_STT = parseFloat(env('ENERGY_MIN_STT')) || 120; // past mikrofonlarda ham backup ishlasin
const ENERGY_TARGET = 1500;        // adaptive gain target — low, no clip
const SILENCE_MS = 500;            // silence = command end
const VOICE_ACTIVITY_THRESHOLD = parseFloat(env('VOICE_ACTIVITY_THRESHOLD')) || 150; // buyruq yozib olishda "gapiryapti" chegarasi
const CMD_MAX = 5.0;               // max command length (s)
const GAIN_MAX = 8, GAIN_MIN = 2; // gain limits — clipping bo'lmasin
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
const WAKE_STT_SILENCE_MS = 420;
const WAKE_STT_MAX_MS = 2200;
const WAKE_STT_PREROLL_MS = 450;
const WAKE_STT_MIN_SPEECH_MS = 480;

const REALTIME_ENABLED = (env('REALTIME_ENABLED') || 'true') !== 'false'; // haqiqiy real-vaqtli (gpt-realtime) suhbat rejimi
const NATIVE_AEC = (env('JARVIS_NATIVE_AEC') || 'true') !== 'false';
const REALTIME_IDLE_MS = parseInt(env('REALTIME_IDLE_MS'), 10) || 20000;  // shuncha vaqt jim bo'lsa, suhbat avtomatik yakunlanadi
// Provider VAD `speech_stopped` hodisasini yo'qotsa idle timer qayta
// qurollanmay qolishi mumkin. Bu mustaqil watchdog stuck realtime sessiyani
// tiklaydi; oddiy 20s follow-up oynasidan ancha uzun, shuning uchun tabiiy
// suhbatni uzmaydi.
const REALTIME_STALE_SESSION_MS = Math.max(75000, parseInt(env('REALTIME_STALE_SESSION_MS'), 10) || 75000);
// Provider `speech_started` yuborib `speech_stopped`ni yo'qotsa normal idle
// timer ataylab qurollanmaydi. Bunday stuck VAD holati keyingi Fn triggerlarni
// bloklamasligi uchun bitta nutq turni qancha davom etishi mumkinligini cheklaymiz.
const REALTIME_MAX_USER_SPEECH_MS = Math.max(30000, parseInt(env('REALTIME_MAX_USER_SPEECH_MS'), 10) || 45000);
const REALTIME_WAKE_PREROLL_MS = parseInt(env('REALTIME_WAKE_PREROLL_MS'), 10) || 1800;
const CONVERSATION_FOLLOWUP_MS = parseInt(env('CONVERSATION_FOLLOWUP_MS'), 10) || 60000;
const ACTION_CONFIRMATION_TTL_MS = parseInt(env('ACTION_CONFIRMATION_TTL_MS'), 10) || 30000;
const TURN_STALE_TIMEOUT_MS = Math.max(30000, parseInt(env('TURN_STALE_TIMEOUT_MS'), 10) || 600000);

// Parallel bajarilayotgan jonli vazifalar (run_task) holati — dashboard
// buni /api/realtime-tasks orqali o'qib, "hozir nima ustida ishlayapti"
// panelini ko'rsatadi. Daemon va dashboard alohida jarayon bo'lgani uchun
// fayl orqali ulanadi (soddaroq, qo'shimcha IPC shart emas).
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
const conversationContext = new ConversationContext({ windowMs: CONVERSATION_FOLLOWUP_MS });
const turnJournal = new TurnJournal({
  file: path.join(PROJECT_DIR, '.run', 'addressed-turns.jsonl'),
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
runtime.on('runtime.error', error => console.error('Jarvis runtime state xatoligi:', error.message));

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
  if (!resultLooksSuccessful(result)) return missions.failStep(missionId, stepId, result || 'Bo‘sh natija');
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

// Qarsak klaviatura/stol zarbalarida ko'p false-trigger bergani uchun opt-in.
// Asosiy ishonchli triggerlar: Hey Jarvis va Fn push-to-talk.
const CLAP_TRIGGER_ENABLED = (env('CLAP_TRIGGER_ENABLED') || 'false') === 'true';
const CLAP_SPIKE_RATIO = parseFloat(env('CLAP_SPIKE_RATIO')) || 4;     // spike, tinch fondan necha barobar baland
const CLAP_ABS_FLOOR = parseFloat(env('CLAP_ABS_FLOOR')) || 250;       // mutlaq minimal spike (juda tinch xonada ham)
// Qolgan qarsak-vaqt konstantalari (quiet ratio, min/max gap) core/clap-detector.js
// ichida saqlanadi — o'sha modulning o'z default qiymatlari shu yerdagi eski
// qiymatlar bilan bir xil.

let _gain = 2.0;  // START LOW — adapt, don't clip

inf('JARVIS v5.1 BLAZING — 16 kHz stream | local wake-word | STT fallback');

// ── UYG'ONISH OVOZI ── Trigger ishlagan zahoti Realtime ulanishini kutmasdan
// qisqa original synthetic acknowledgement chime eshitiladi. Oldindan yozilgan
// odam ovozi Cedar bilan tembr jihatdan mos kelmasdi va mikrofonni 0.94s band
// qilardi; 180ms chime barcha og'zaki javoblarni canonical voice'da qoldiradi.
const WAKE_SOUND_PATH = path.join(PROJECT_DIR, 'assets', 'wake-chime.wav');

// Bu ovoz ijro etilayotgan vaqtda mikrofon jonli sessiyaga UMUMAN
// yuborilmaydi (Jarvis o'z ovozini "foydalanuvchi gapirdi" deb qabul
// qilmasligi uchun) — ya'ni bu butunlay O'LIK vaqt: foydalanuvchi
// gapirsa ham eshitilmaydi. Shuning uchun ovoz imkon qadar QISQA
// bo'lishi kerak (avvalgi spoken acknowledgement 0.84s edi; yangi chime 0.18s).
// Davomiylik fayldan O'QIB olinadi — fayl almashtirilsa, qo'lda raqam
// yangilash esdan chiqib, mos kelmay qolmasin.
const WAKE_SOUND_MS = detectWakeSoundMs(WAKE_SOUND_PATH);

// ════════════════════════════════════════════
// TELEGRAM / TTS / AGENT BRIDGE (core/agent-bridge.js)
// ════════════════════════════════════════════
const { sendTelegram, sendTelegramVoice, ttsToFile, askOpenClaw, agentProviders, askAgent } = createAgentBridge({
  chatId: CHAT_ID, token: TOKEN, projectDir: PROJECT_DIR, env, azureOpenAiKey: AZURE_OPENAI_KEY,
  openClawEnvironment: resolveOpenClawEnvironment({ projectDir: PROJECT_DIR }),
  skillPlatform, runtime, telemetry: runtimeTelemetry
});

// ════════════════════════════════════════════
// FON JOB'LARI (core/background-jobs/*.js) — har biri o'z holat faylini
// va bog'liqliklarini o'zi oladi; bu yerda faqat yoqish/rejalashtirish
// qoladi. proactivePolicy ikkalasiga (proactive + urgent) umumiy.
// ════════════════════════════════════════════
const { createProactiveCheckJob } = require('./core/background-jobs/proactive-check');
const { createUrgentCheckJob } = require('./core/background-jobs/urgent-check');
const { createDailySynthesisJob } = require('./core/background-jobs/daily-synthesis-job');
const { createDailyTasksJob } = require('./core/background-jobs/daily-tasks-job');
const { createDailyReportJob } = require('./core/background-jobs/daily-report-job');
const { createProjectsJob } = require('./core/background-jobs/projects-job');
const { createFastActionLearnJob } = require('./core/background-jobs/fast-action-learn-job');
const { createEmbedIndexJob } = require('./core/background-jobs/embed-index-job');

// PROAKTIV REJIM — davriy ravishda screen-monitor yozgan Obsidian
// xotirasini ko'rib chiqadi; agent chindan foydali narsa topsa,
// Telegram/ovoz orqali taklif qiladi. Hech qachon so'ramasdan mustaqil
// harakat (klik/yozish) qilmaydi — faqat kuzatib, taklif beradi.
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
  inf('Proaktiv rejim yoqilgan — har ' + PROACTIVE_INTERVAL_MIN_RT + ' daqiqada tekshiradi');
  setInterval(() => { proactiveCheckJob.run().catch(() => {}); }, PROACTIVE_INTERVAL_MIN_RT * 60 * 1000);
}

// SHOSHILINCH ekran ogohlantirishlari — proaktiv rejimning umumiy 30
// daqiqalik tsiklidan FARQLI, screen-monitor #urgent deb belgilagan
// (xato/crash, xavfsizlik, muddat kabi) yozuvlarni ANCHA tez-tez (default
// 3 daqiqada) tekshiradi va DARHOL ovozli+Telegram xabar beradi.
const URGENT_CHECK_ENABLED = (env('URGENT_CHECK_ENABLED') || 'true') !== 'false';
const URGENT_CHECK_INTERVAL_MIN = parseInt(env('URGENT_CHECK_INTERVAL_MIN'), 10) || 3;
const urgentCheckJob = createUrgentCheckJob({ projectDir: PROJECT_DIR, localDateStr, proactivePolicy, askAgent, sendTelegram, ttsToFile });
if (URGENT_CHECK_ENABLED) {
  inf('Shoshilinch ekran ogohlantirishi yoqilgan — har ' + URGENT_CHECK_INTERVAL_MIN + ' daqiqada tekshiradi');
  setInterval(() => { urgentCheckJob.run().catch(() => {}); }, URGENT_CHECK_INTERVAL_MIN * 60 * 1000);
}

// Kunlik o'rganish: xom kuzatuvlardan barqaror naqshlarni ajratib,
// profilga qo'shadi. Skill o'zi qaysi kunlar bajarilganini eslab qoladi,
// shuning uchun tez-tez chaqirish xavfsiz (takror bajarilmaydi).
const SYNTHESIS_ENABLED = (env('DAILY_SYNTHESIS_ENABLED') || 'true') !== 'false';
const dailySynthesisJob = createDailySynthesisJob({ sendTelegram });
if (SYNTHESIS_ENABLED) {
  inf('Kunlik o\'rganish yoqilgan');
  setTimeout(() => { dailySynthesisJob.run(); }, 2 * 60 * 1000);          // ishga tushgach
  setInterval(() => { dailySynthesisJob.run(); }, 60 * 60 * 1000);        // keyin har soatda tekshiradi
}

// KUNLIK VAZIFALAR — Obsidian'dagi ro'yxat (skills/tasks). Ro'yxatga
// tushgan narsa uchun alohida ruxsat so'ralmaydi — kun davomida navbat
// bilan avtomatik bajariladi (SOUL.md Chegaralar hali kuchda: qaytarib
// bo'lmaydigan amallar baribir so'raladi).
const DAILY_TASKS_ENABLED = (env('DAILY_TASKS_ENABLED') || 'true') !== 'false';
const DAILY_TASK_LEAD_MIN = Math.max(0, parseInt(env('DAILY_TASK_LEAD_MIN'), 10) || 0);
const dailyTasksJob = createDailyTasksJob({
  projectDir: PROJECT_DIR, localDateStr, leadMin: DAILY_TASK_LEAD_MIN, stableId, beginSingleStepMission, recordMissionResult, askAgent, sendTelegram, writeMemory
});
if (DAILY_TASKS_ENABLED) {
  inf('Kunlik vazifalar rejimi yoqilgan');
  setTimeout(() => { dailyTasksJob.run().catch(() => {}); }, 3 * 60 * 1000);
  setInterval(() => { dailyTasksJob.run().catch(() => {}); }, 20 * 60 * 1000);
}

// KUNLIK O'Z-O'ZINI HISOBOT — kun oxirida (mahalliy soat) bugun mustaqil
// bajarilgan barcha ishlar qisqa xulosa qilinib, Telegram+ovoz orqali
// aytiladi. To'liq avtonom ruxsat berilgani uchun — nazorat o'rniga
// shaffoflikni saqlash uchun.
const DAILY_REPORT_ENABLED = (env('DAILY_REPORT_ENABLED') || 'true') !== 'false';
const DAILY_REPORT_HOUR = parseInt(env('DAILY_REPORT_HOUR'), 10) || 22; // mahalliy soat
const dailyReportJob = createDailyReportJob({
  projectDir: PROJECT_DIR, localDateStr, reportHour: DAILY_REPORT_HOUR, askAgent, sendTelegram, writeMemory, ttsToFile
});
if (DAILY_REPORT_ENABLED) {
  inf('Kunlik hisobot rejimi yoqilgan — har kuni soat ' + DAILY_REPORT_HOUR + ':00dan keyin');
  setInterval(() => { dailyReportJob.run().catch(() => {}); }, 15 * 60 * 1000);
}

// LOYIHALAR — ko'p bosqichli, kun davomida ketma-ket bajariladigan
// avtonom ishlar (skills/projects). Bosqichlar BITTA umumiy session'da
// ketma-ket bajariladi, loyiha tugagach ALOHIDA yakuniy hisobot beriladi.
const PROJECTS_ENABLED = (env('PROJECTS_ENABLED') || 'true') !== 'false';
const PROJECT_STEP_MAX_ATTEMPTS = parseInt(env('PROJECT_STEP_MAX_ATTEMPTS'), 10) || 2;
const projectsJob = createProjectsJob({
  missions, stableId, beginSingleStepMission, recordMissionResult, stepMaxAttempts: PROJECT_STEP_MAX_ATTEMPTS, askAgent, sendTelegram, writeMemory
});
if (PROJECTS_ENABLED) {
  inf('Ko\'p bosqichli loyihalar rejimi yoqilgan');
  setTimeout(() => { projectsJob.run().catch(() => {}); }, 4 * 60 * 1000);
  setInterval(() => { projectsJob.run().catch(() => {}); }, 15 * 60 * 1000);
}

// TEZ AMALLARNI O'RGANISH (fast-actions) — vaqti-vaqti bilan Obsidian
// xotirasidagi so'nggi kunlar vazifalarini ko'rib, "shunchaki biror
// dastur ochish" turidagi, hali fast-actions ro'yxatida yo'q so'rovlarni
// topadi va avtomatik qo'shadi.
const FAST_ACTION_LEARN_ENABLED = (env('FAST_ACTION_LEARN_ENABLED') || 'true') !== 'false';
const FAST_ACTION_LEARN_INTERVAL_MIN = parseInt(env('FAST_ACTION_LEARN_INTERVAL_MIN'), 10) || 720; // 12 soatda bir
const fastActionLearnJob = createFastActionLearnJob({ projectDir: PROJECT_DIR, localDateStr, askAgent, sendTelegram, writeMemory, skillPlatform });
if (FAST_ACTION_LEARN_ENABLED) {
  inf('Tez amallarni o\'rganish yoqilgan — har ' + FAST_ACTION_LEARN_INTERVAL_MIN + ' daqiqada tekshiradi');
  setTimeout(() => { fastActionLearnJob.run().catch(() => {}); }, 10 * 60 * 1000);
  setInterval(() => { fastActionLearnJob.run().catch(() => {}); }, FAST_ACTION_LEARN_INTERVAL_MIN * 60 * 1000);
}

// XOTIRA INDEKSINI FONDA YANGILASH — semantik (ma'no bo'yicha) qidiruv
// butun tarix bo'ylab ishlashi uchun har bir yangi xotira bloki
// indekslanishi kerak; bu fonda, muntazam bajariladi, qidiruv esa doim
// tayyor indeksdan o'qib, bir zumda javob beradi.
const EMBED_INDEX_ENABLED = (env('EMBED_INDEX_ENABLED') || 'true') !== 'false';
const EMBED_INDEX_INTERVAL_MIN = parseInt(env('EMBED_INDEX_INTERVAL_MIN'), 10) || 15;
const embedIndexJob = createEmbedIndexJob();
if (EMBED_INDEX_ENABLED) {
  inf('Xotira indeksi fonda yangilanadi — har ' + EMBED_INDEX_INTERVAL_MIN + ' daqiqada');
  setTimeout(() => { embedIndexJob.run(); }, 60 * 1000);
  setInterval(() => { embedIndexJob.run(); }, EMBED_INDEX_INTERVAL_MIN * 60 * 1000);
}
const replayResult = turnJournal.replay();
turnJournal.startWatchdog({ maxAgeMs: TURN_STALE_TIMEOUT_MS, reason: 'turn watchdog timeout' });
runtime.heartbeat('memory-recovery', { status: 'ready', ...replayResult });
if (replayResult.replayed > 0) {
  inf(`Turn journal recovery: ${replayResult.replayed} ta terminal turn qayta materialize qilindi`);
  if (EMBED_INDEX_ENABLED) setTimeout(() => embedIndexJob.run(), 500).unref?.();
}

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
    wrn('openWakeWord o\'rnatilmagan — STT backup faol. scripts/setup-openwakeword.sh ni ishga tushiring');
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
      onReady: () => ok('whisper.cpp lokal wake transcript detector tayyor'),
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
    const vlProvider = VOICE_PROVIDERS.find(p => p.id === 'voice-live');
    const wakeEnabled = (env('AZURE_VOICELIVE_WAKE_ENABLED') || 'true') !== 'false';
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
  let state = 'listening'; // 'listening' | 'realtime' | 'command_record' | 'processing'
  let cmdBuffers = [];
  let lastVoiceTime = 0;
  let cmdStartTime = 0;
  // Fn push-to-talk emas: u hands-free realtime suhbatini ochadigan trigger.
  // Sessiya ochilgach server VAD tabiiy pauzalarda turnlarni o'zi ajratadi.
  let fnPressed = false;
  let lastFnDownAt = 0;
  let restartFromFn = false;
  // Mac mikrofonining real tinch RMS'i sinovda 100–200 oralig'ida chiqdi.
  // 40 dan boshlash shovqinni nutq deb olib, uzluksiz STT segment yuborardi.
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
      _sttPool.recognize(wavBuf, 'en-US'),
      _sttPool.recognize(wavBuf, 'uz-UZ')
    ]).then(results => {
      const heard = results.filter(r => r && r.status === 'ok' && r.text);
      if (heard.length) {
        inf('STT wake heard: ' + heard.map(r => '"' + r.text + '"').join(' / '));
        const wake = findWakeRecognition(heard);
        if (wake && state === 'listening' && Date.now() - lastHotwordTime > HOTWORD_COOLDOWN_MS) {
          triggerVoice('🔥 HOTWORD (hybrid STT): "' + wake.text + '"', {
            addressedWake: true,
            // Wake fallback aynan chaqiruv segmentini taniydi. STT qo'shib
            // yuborgan tasodifiy trailing so'zni buyruq deb bajarmaymiz;
            // chime'dan keyingi alohida turn haqiqiy buyruq hisoblanadi.
            initialTranscript: '',
            playAck: true
          });
        }
      } else {
        const failed = results.find(r => r && r.reason && !['NoMatch', 'nomatch', 'unknown'].includes(r.reason));
        if (!failed || Date.now() - lastSttBackupNotice <= 60000) return;
        lastSttBackupNotice = Date.now();
        wrn('STT backup vaqtincha javob bermadi: ' + failed.reason);
      }
    }).catch(e => {
      if (Date.now() - lastSttBackupNotice > 60000) {
        lastSttBackupNotice = Date.now();
        wrn('STT backup vaqtincha ishlamadi: ' + (e.message || e));
      }
    }).finally(() => { sttBackupInFlight = false; });
  }

  // English Realtime owns STT, VAD, conversation and speech. Grok Fast handles
  // normal reasoning, GPT-5.6 Sol handles complex reasoning and executable tasks.
  function startRealtimeSession(reason, trigger = {}) {
    if (_activeRealtimeSession || state !== 'listening') return false;

    const session = new RealtimeSession({
      // Fn hands-free trigger butun ochiq sessiya davomida foydalanuvchi
      // Jarvisga murojaat qilayotganini tasdiqlaydi. Shuning uchun media
      // background gate follow-up gaplarni bloklamaydi. Wake-word trigger
      // esa faqat birinchi mazmunli turn uchun bir martalik bypass oladi.
      explicitUserSession: reason.includes('Fn'),
      explicitUserTrigger: Boolean(trigger.addressedWake),
      addressedWakeTrigger: Boolean(trigger.addressedWake && !trigger.initialTranscript),
      initialTranscript: trigger.initialTranscript || '',
      // English Realtime STT is the single source of truth for both wake-word
      // and push-to-talk sessions. Do not add a second language decoder here:
      // competing transcripts increase latency and can route the wrong action.
      conversationContext,
      actionConfirmationTtlMs: ACTION_CONFIRMATION_TTL_MS,
      // Default RealtimeSession'ning o'z ichki askExpert()'i `openclaw agent`
      // CLI'ni (run_task bilan bir xil primary model) spawn qiladi — haqiqiy
      // kuchli `deep-think` (Grok Fast yoki GPT-5.6 Sol, to'g'ridan-to'g'ri Azure Responses
      // API, tool-loop'siz — shu sabab tezroq)
      // hech qachon ishlatilmasdi. Shu yerga ulash orqali `ask_expert` va
      // deterministik expert/grounding yo'li ham haqiqiy kuchli modelga boradi.
      expertAnswer: async (question, callId, grounding) => {
        try {
          return await skillPlatform.invoke('deep-think', 'askExpert', { question, context: grounding });
        } catch (e) {
          return "I couldn't reach the reasoning service.";
        }
      },
      // fast-actions endi SkillPlatform orqali chaqiriladi -- osilib qolgan
      // holat (masalan ruxsat dialogi kutayotgan osascript) platformaning
      // timeout/circuit-breaker'i bilan himoyalanadi, o'zi hech qachon
      // reject qilmasa ham.
      fastActionRunner: (id) => skillPlatform.invoke('fast-actions', 'runFastAction', { id })
    });
    const flightRecorder = new VoiceFlightRecorder({ file: VOICE_FLIGHT_RECORDER_FILE });
    const voiceTelemetry = new VoiceTelemetry({
      file: path.join(PROJECT_DIR, '.run', 'voice-latency.jsonl'),
      sessionId: flightRecorder.beginSession({ trigger: reason, mode: reason.includes('Fn') ? 'fn-hands-free' : 'wake-word' })
    });
    voiceTelemetry.event(VOICE_MILESTONES.WAKE_DETECTED, { trigger: reason.includes('Fn') ? 'fn' : 'wake-word' });
    runtime.beginConversation(reason.includes('Fn') ? 'fn-hands-free' : 'wake-word');
    const connectStartedAt = Date.now();
    _activeRealtimeSession = session;
    // macOS Voice Processing (FaceTime darajasidagi exo bostirish): tayyor bo'lguncha va ishlamay qolsa
    // oddiy mikrofon + mahalliy AEC yo'li ishlayveradi.
    let nativeMic = null;
    let nativeMicLastAt = 0;
    if (NATIVE_AEC && NativeMic.isSupported()) {
      nativeMic = new NativeMic();
      nativeMic.on('data', chunk => {
        if (session.closed) return;
        nativeMicLastAt = Date.now();
        if (!session._nativeAec) { session.enableNativeAec(); inf('🎧 Native AEC (Voice Processing) yoqildi'); }
        const queued = typeof session._jarvisQueueWakeAudio === 'function' && session._jarvisQueueWakeAudio(Buffer.from(chunk));
        if (!queued && Date.now() >= (session._jarvisWakeMuteUntil || 0)) session.feedAudio(chunk);
      });
      nativeMic.on('exit', info => {
        session.disableNativeAec('helper-exit');
        if (!session.closed) wrn('Native AEC to\'xtadi (' + (info.error || info.code) + ') — oddiy mikrofon yo\'liga qaytildi');
      });
      nativeMic.on('unavailable', reason => { wrn('Native AEC mavjud emas: ' + reason); });
      nativeMic.start();
    }
    state = 'realtime';
    lastHotwordTime = Date.now();
    // Hotword ham, Fn ham foydalanuvchiga darhol bir xil qisqa synthetic chime
    // beradi. Ack davomida mikrofon oqimini tashlaymiz: aks holda karnaydagi
    // chime preroll'ga kirib, server uni foydalanuvchi nutqi deb qabul qiladi.
    // Ack tugagach, ulanish hali tayyor bo'lmasa haqiqiy buyruq bounded
    // preroll'ga yig'iladi va ready bo'lgan zahoti yuboriladi.
    // WAKE_SOUND_MS ichida audio-driver uchun 100ms guard allaqachon bor.
    // Bu yerda ikkinchi guard qo'shish foydalanuvchining birinchi so'zlarini
    // keraksiz tashlab yuborar edi.
    const shouldPlayAck = trigger.playAck !== false;
    const wakeMuteUntil = shouldPlayAck ? Date.now() + WAKE_SOUND_MS : 0;
    if (shouldPlayAck) playWakeSound(WAKE_SOUND_PATH);
    let idleTimer = null;
    let staleSessionTimer = null;
    let lastRealtimeActivityAt = Date.now();
    let finished = false;
    let sessionWasReady = false;
    let lastUserTranscript = '';
    let currentTurnId = '';
    const pendingTurnIds = [];
    let activeToolCount = 0;
    let awaitingFollowup = false;
    // Provider VAD session.updated/ready'dan oldin speech_started yuborishi
    // mumkin. Bu holatda ready handler idle timer o'rnatib, hali davom
    // etayotgan gapni REALTIME_IDLE_MS o'tgach noto'g'ri yopmasligi kerak.
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
      // Faol VAD turni uchun jimlik timeri bo'lmaydi. speech_stopped
      // transcription oynasini yakunlagach ushbu timer yana qurollanadi.
      if (userSpeaking) return;
      const delay = conversationIdleDelay({
        now: Date.now(),
        idleMs: REALTIME_IDLE_MS,
        followupMs: CONVERSATION_FOLLOWUP_MS,
        playbackUntil: session._playbackUntil,
        awaitingFollowup
      });
      idleTimer = setTimeout(() => {
        // Sessiyani yopish running run_task jarayonlarini cancel qiladi.
        // Natija kelguncha timeout'ni uzaytirib turamiz.
        if (activeToolCount > 0) return armIdleTimer();
        finishRealtimeSession('jimlik timeout');
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
      const inactiveMs = Date.now() - lastRealtimeActivityAt;
      if (inactiveMs < REALTIME_STALE_SESSION_MS) return;
      wrn('Realtime sessiya faolliksiz qolgan (' + Math.round(inactiveMs / 1000) + 's) — tiklanish uchun yopilyapti');
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
      inf('Realtime suhbat yakunlandi: ' + why);
      if (restartFromFn) {
        restartFromFn = false;
        // close() callbacklari tugab state listening holatiga o'tgach yangi
        // session ochiladi. Shu sabab Fn stuck realtime sessiyani tiklaydi.
        setTimeout(() => triggerVoice('⌨️ Fn hands-free conversation'), 0);
      }
    };

    session.on('ready', () => {
      markRealtimeActivity();
      sessionWasReady = true;
      _realtimeFailureCount = 0;
      _realtimeDisabledUntil = 0;
      runtime.observeLatency('realtime-connect', Date.now() - connectStartedAt);
      runtime.setConversationMode('listening');
      runtime.heartbeat('realtime-api', { status: 'ready' });
      ok('Realtime ovoz sessiyasi ulandi');
      // Wake chime/handshake vaqtida aytilgan "Hey Jarvis, ..." buyrug'ini
      // yo'qotmasdan sessiya tayyor bo'lgach uzatamiz.
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
      flightRecorder.textEvent('turn.suppressed', text, { reason });
      inf('🔇 Realtime turn bloklandi (' + reason + '): ' + String(text || '').slice(0, 100));
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
        wrn('Takror realtime javob log/xotiraga yozilmadi');
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
      // Cancelled/incomplete response.done barge-in ochgan keyingi speech
      // turniga kechikib kelishi mumkin. Faqat provider tasdiqlagan successful
      // response aktiv turnni completed qilsin.
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
      flightRecorder.event('tool.started', { description, callId });
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
      inf('🛠 Jonli vazifa: ' + description);
      armIdleTimer();
    });
    session.on('tool_result', (result, callId) => {
      markRealtimeActivity();
      activeToolCount = Math.max(0, activeToolCount - 1);
      flightRecorder.event('tool.completed', { result, callId });
      try { runtime.completeTask(callId, result); } catch (e) { wrn('Task ledger: ' + e.message); }
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
      er('Realtime xatolik: ' + (err.message || err));
      const shouldFallback = !sessionWasReady;
      finishRealtimeSession('xatolik');
      if (shouldFallback && state === 'listening') {
        // Ulanishning o'zi ishlamasa foydalanuvchini tashlab qo'ymaymiz:
        // wake sound'dan keyingi audioni batch STT orqali yozib olamiz.
        state = 'command_record';
        cmdBuffers = [];
        cmdStartTime = Date.now();
        lastVoiceTime = cmdStartTime;
        wrn('Realtime ulanmagan — batch STT fallback tinglayapti');
      }
    });
    session.on('close', () => {
      // WebSocket ko'pincha 'error' chiqarmasdan to'g'ridan-to'g'ri 'close'
      // bilan uziladi (server-tomonidan yopilish/tarmoq uzilishi) — bu holda
      // heartbeat oxirgi 'ready' holatida yopishib qolib, diagnose-voice.js
      // muammoni ko'rmay qolardi. `finished` hali false bo'lsa (ya'ni 'error'
      // yoki idle-timeout orqali allaqachon yakunlanmagan bo'lsa) — bu
      // kutilmagan uzilish, holatni to'g'ri belgilaymiz.
      if (!finished) {
        if (currentTurnId) turnJournal.append(currentTurnId, 'turn.failed', { error: 'socket-closed-unexpectedly' });
        runtime.heartbeat('realtime-api', {
          status: sessionWasReady ? 'degraded' : 'error',
          reason: 'socket-closed-unexpectedly'
        });
        if (sessionWasReady) {
          playSystemSound('Basso');
          sendTelegram('⚠️ The voice session disconnected unexpectedly. It will reconnect on the next invocation.');
        }
      }
      finishRealtimeSession('ulanish yopildi');
    });

    inf(reason + ' — realtime suhbat ulanmoqda');
    session.connect();
    armIdleTimer();
    return true;
  }

  // Barcha triggerlar bitta state transition'dan o'tadi. Rekonstruksiya
  // qilingan snapshotda triggerVoice chaqiriqlari qolib, funksiyaning o'zi
  // yo'qolgan edi — Porcupine/qarsak topilganda ReferenceError bo'lib daemon
  // qular edi. Fn DOWN hands-free suhbatni shu yer orqali ochadi.
  function triggerVoice(reason, trigger = {}) {
    if (state !== 'listening') return false;
    inf('[triggerVoice] ' + reason + ' @' + new Date().toISOString() + ' trigger=' + JSON.stringify(trigger).slice(0,200));
    // Lokal model va STT fallback parallel tinglaydi. Ulardan biri trigger
    // qilishi bilan ikkinchisining yarim yig'ilgan segmentini tashlaymiz;
    // aks holda realtime tugagach eski “Hey Jarvis” keyingi nutqqa qo'shiladi.
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
      wrn('Realtime vaqtincha bloklangan — batch STT fallback ishlatiladi');
    }
    const now = Date.now();
    lastHotwordTime = now;
    state = 'command_record';
    cmdBuffers = [];
    cmdStartTime = now;
    lastVoiceTime = now;
    if (trigger.playAck !== false) playWakeSound(WAKE_SOUND_PATH);
    inf(reason + ' — buyruq tinglanyapti');
    return true;
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
      inf('Fn-key broker ulandi');
    });
    fnClient.on('data', (data) => {
      fnBuf += data.toString();
      const lines = fnBuf.split('\n');
      fnBuf = lines.pop();
      for (const raw of lines) {
        const event = raw.trim();
        if (event === 'DOWN') {
          // flagsChanged dublikat hodisasi ikkinchi realtime sessiya ochmasin.
          if (fnPressed || Date.now() - lastFnDownAt < 250) continue;
          fnPressed = true;
          lastFnDownAt = Date.now();
          if (state === 'realtime' && _activeRealtimeSession) {
            // Fn har doim yangi suhbatni boshlash tugmasi bo'lishi kerak. Idle
            // timer/VAD sessionni hali yopmagan bo'lsa, u keyingi Fn'ni oldin
            // jim rad etardi. Faol agent vazifasini esa hech qachon bekor
            // qilmaymiz; bunday holatda mavjud sessiya saqlanadi.
            if (_activeRealtimeSession._runningTasks?.size) {
              inf('Fn qabul qilindi: faol vazifa bor, mavjud realtime suhbat saqlanadi');
            } else {
              restartFromFn = true;
              _activeRealtimeSession.close();
            }
          } else triggerVoice('⌨️ Fn hands-free conversation');
        } else if (event === 'UP') {
          fnPressed = false;
          // Fn qo'yib yuborilishi suhbat turnini yopmaydi. Mikrofon realtime
          // sessiya davomida oqishda qoladi; provider VAD tabiiy pauzada
          // speech_stopped/transkript chiqaradi. Keyingi gaplar uchun Fn kerak emas.
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
  runtime.heartbeat('microphone', { status: 'streaming' });
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
          // RealtimeSession ichidagi DuplexVoiceEngine calibration thresholdlarini
          // xom mikrofon RMS birliklarida qo'llaydi va yuboriladigan nutqni o'zi
          // target RMS'ga kuchaytiradi. Bu yerda oldindan gain berish xona fonini
          // ham "speech" qilib, server VAD'ni speech_started holatida qoldirardi.
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

          // Ikki marta qarsak — PEAK amplitudadan (RMS/getEnergy emas):
          // qarsak juda qisqa zarba, 200ms oyna bo'yicha o'rtachalashtirilsa
          // (RMS) tinch fon bilan aralashib "yumshab" ketardi va ko'p marta
          // sezilmay qolardi. Peak eng baland cho'qqini yo'qotmaydi.
          if (_clap) {
            const stepPeak = getPeakAmplitude(stepData);
            const clapHit = _clap.feedEnergy(stepPeak, now);
            if ((now % 3000) < STEP_MS) inf('Clap peak=' + Math.round(stepPeak) + ' baseline=' + Math.round(_clap.baseline) + ' threshold=' + Math.round(_clap.threshold));
            if (clapHit && (now - lastHotwordTime > HOTWORD_COOLDOWN_MS)) {
              triggerVoice('👏 HOTWORD (ikki marta qarsak)');
              return;
            }
          }

          // Lokal detektorga faqat yangi PCM step yuboriladi; rolling overlap
          // yuborilsa bir audio qayta-qayta inference qilinardi.
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
                // Foydalanuvchi wake qabul qilinganini ko'rmasdan bilishi kerak.
                // 180ms chime tugagach bounded preroll buyruqni saqlab qoladi.
                playAck: true,
                seedAudio: rolling.sliceLast(REALTIME_WAKE_PREROLL_MS)
              });
            return;
          }

          // STT backup: har rolling oynani qayta-qayta yubormaymiz. Nutqning
          // boshlanishi va jimlik bilan tugashini topib, aynan bitta segmentni
          // tanitamiz — “Hey Jarvis” sukunat ichida yo'qolib ketmaydi.
          const energy = getEnergy(stepData);
          if (!wakeSpeechStartedAt && energy < ambientEnergy * 2.2) ambientEnergy = ambientEnergy * 0.97 + energy * 0.03;
          const adaptiveSttGate = Math.max(ENERGY_MIN_STT, ambientEnergy * 2.5);
          adaptGain(energy);
          // Debug: energy log every 2 sec
          if ((now % 2000) < 200) inf('Energy=' + Math.round(energy) + ' gain=' + _gain.toFixed(1));
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

      // ── STATE: COMMAND RECORDING ──
      else if (state === 'command_record') {
        const elapsed = now - cmdStartTime;

        // Energy check every ~120ms
        if (elapsed % 120 < 30 && cmdBuffers.length > 2) {
          const totalPCM = Buffer.concat(cmdBuffers);
          const energy = getEnergy(totalPCM);
          if (energy > VOICE_ACTIVITY_THRESHOLD) lastVoiceTime = now;
        }

        const silence = now - lastVoiceTime;
        if ((!fnPressed && elapsed > 800 && silence > SILENCE_MS) || elapsed > CMD_MAX * 1000) {
          state = 'processing';
          const totalPCM = Buffer.concat(cmdBuffers);
          const wavBuf = pcmToWavBuffer(totalPCM);
          inf('STT ishlanyapti...');
          _sttPool.recognize(wavBuf, 'en-US').then(r => {
            state = 'listening';
            nextStepTime = Date.now(); // reset timing
            if (r && r.status === 'ok' && r.text && r.text.length > 1) {
              const cmd = r.text.trim();
              ok('Buyruq: "' + cmd + '"');
              processCommand(cmd).catch(() => {});
            } else {
              wrn('STT natija topilmadi');
            }
          }).catch(err => {
            state = 'listening';
            er('STT xatolik: ' + (err.message || err));
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

  // Quick commands
  if (/eslab qol|esda tut/i.test(command) && command.length > 15) {
    const cl = command.replace(/eslab qol|esda tut/gi, '').trim();
    writeMemory('Voice', cl, ['voice']); sendTelegram('✅ Remembered.');
    const ap = await ttsToFile('Remembered.'); if (ap) await execFileAsync('afplay', [ap]).catch(() => {});
    turnJournal.append(batchTurnId, 'assistant.completed', { text: 'Remembered.' });
    return;
  }
  if (/kuzatishni (boshla|yo?qish)/i.test(command)) {
    await runNodeWithInput('skills/screen-monitor/index.js', '{"action":"start"}\n').catch(() => {});
    const ap = await ttsToFile('Monitoring enabled.'); if (ap) await execFileAsync('afplay', [ap]).catch(() => {});
    turnJournal.append(batchTurnId, 'assistant.completed', { text: 'Monitoring enabled.' });
    return;
  }
  if (/kuzatishni (to.xtat|o.chir)/i.test(command)) {
    await runNodeWithInput('skills/screen-monitor/index.js', '{"action":"stop"}\n').catch(() => {});
    const ap = await ttsToFile('Monitoring disabled.'); if (ap) await execFileAsync('afplay', [ap]).catch(() => {});
    turnJournal.append(batchTurnId, 'assistant.completed', { text: 'Monitoring disabled.' });
    return;
  }

  // Agent
  let mem = '';
  try {
    const q = command.split(/\s+/).filter(w => w.length > 3 && !['qanday','nima','kim'].includes(w.toLowerCase())).slice(0, 3).join(' ');
    if (q.length > 2) { const f = searchMemory(q, 3); if (f && f.status === 'ok' && f.results.length) mem = '\n[Xotira]:\n' + f.results.map(r => r.matches.map(m => m.text).join(' | ')).join('\n') + '\n'; }
  } catch(e){}
  const reply = await askAgent(mem + command);
  runtime.observeLatency('batch-agent', Date.now() - commandStartedAt);
  if (reply) {
    const acceptedResponse = runtime.acceptResponse(reply);
    if (!acceptedResponse.accepted) {
      wrn('Takror agent javobi ovozga chiqarilmadi');
      turnJournal.append(batchTurnId, 'turn.cancelled', { reason: 'duplicate-response' });
      return;
    }
    runtime.setConversationMode('speaking');
    ok('<<< ' + reply.substring(0, 80)); sendTelegram('🤖 ' + reply);
    turnJournal.append(batchTurnId, 'assistant.completed', { text: reply.substring(0, 4000) });
    const audio = await ttsToFile(reply.substring(0, 400));
    if (audio) {
      await execFileAsync('afplay', [audio]).then(() => ok('🔊 Ovoz')).catch(() => {});
      const ogg = audio.replace(/\.[^.\/]+$/, '') + '.ogg';
      await execFileAsync('ffmpeg', ['-y', '-i', audio, '-c:a', 'libopus', ogg]).then(() => sendTelegramVoice(ogg)).catch(() => {});
      [ogg, audio].forEach(p => { try { fs.unlinkSync(p); } catch(e){} });
    }
  } else {
    const fallback = 'I could not prepare a response. Please say that again.';
    wrn('Agent bo\'sh javob qaytardi');
    turnJournal.append(batchTurnId, 'turn.failed', { reason: 'agent-empty-response' });
    sendTelegram('⚠️ ' + fallback);
    const audio = await ttsToFile(fallback);
    if (audio) {
      await execFileAsync('afplay', [audio], { stdio: 'ignore' }).catch(() => {});
      try { fs.unlinkSync(audio); } catch(e) {}
    }
  }
}

// ════════════════════════════════════════════
// GRACEFUL EXIT
// ════════════════════════════════════════════
function cleanup() {
  inf('To\'xtatilmoqda...');
  if (_activeRealtimeSession) { try { _activeRealtimeSession.close(); } catch(e){} }
  if (_sox) { try { _sox.kill(); } catch(e){} }
  if (_detector) { try { _detector.release(); } catch(e){} }
  if (_whisperWakeDetector) { try { _whisperWakeDetector.release(); } catch(e){} }
  if (_sttPool) { _sttPool.killAll(); }
  try { runtime.close(); } catch(e) {}
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('SIGHUP', () => inf('SIGHUP qabul qilindi: keyingi action safety tekshiruvi .env dan yangi autonomy holatini o‘qiydi.'));

// ════════════════════════════════════════════
// ENTRY
// ════════════════════════════════════════════
(async () => {
  try {
    await mainLoop();
  } catch (e) {
    er('FATAL: ' + e.message);
    cleanup();
  }
})();
