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

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const PROJECT_DIR = '/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS';
process.chdir(PROJECT_DIR);

const { writeMemory, searchMemory } = require('./skills/memory');
const { RealtimeSession } = require('./skills/realtime-voice');
const { JarvisRuntime } = require('./core/jarvis-runtime');
const { VoiceFlightRecorder } = require('./core/voice-flight-recorder');
const { MissionControl, stableId } = require('./core/mission-control');
const { ProactivePolicy } = require('./core/proactive-policy');
const { createSkillPlatform } = require('./skills/platform');
const { loadCalibration, resolveCalibratedNumber } = require('./core/audio-calibration');
const { ok, er, inf, wrn } = require('./core/log');
const { makeWavHeader, pcmToWavBuffer, getEnergy, getPeakAmplitude } = require('./core/audio-utils');
const { RollingBuffer } = require('./core/rolling-buffer');
const { HotwordDetector } = require('./core/hotword-detector');
const { OpenWakeWordDetector } = require('./core/openwakeword-detector');
const { ClapDetector } = require('./core/clap-detector');
const { STTPool } = require('./core/stt-pool');
const { detectWakeSoundMs, playWakeSound, playSystemSound, playTaskDoneSound } = require('./core/voice-sounds');
const { createAgentBridge } = require('./core/agent-bridge');

const ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8');
function env(k) { const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; }
const ENV_VALUES = Object.fromEntries(ENV.split(/\r?\n/).map(line => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)).filter(Boolean).map(match => [match[1], match[2].trim()]));
const AUDIO_CALIBRATION = loadCalibration(path.join(PROJECT_DIR, '.run', 'audio-calibration.json'));

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

// ── Config ──────────────────────────────────────────────
const SAMPLE_RATE = 16000;
const CHUNK_MS = 1200;             // overlap window (ms) — "Jarvis" to'liq sig'ish uchun
const STEP_MS = 200;               // new chunk every (ms)
const ENERGY_MIN_STT = parseFloat(env('ENERGY_MIN_STT')) || 120; // past mikrofonlarda ham backup ishlasin
const ENERGY_TARGET = 1500;        // adaptive gain target — low, no clip
const SILENCE_MS = 500;            // silence = command end
const VOICE_ACTIVITY_THRESHOLD = parseFloat(env('VOICE_ACTIVITY_THRESHOLD')) || 150; // buyruq yozib olishda "gapiryapti" chegarasi
const CMD_MAX = 5.0;               // max command length (s)
const GAIN_MAX = 8, GAIN_MIN = 2; // gain limits — clipping bo'lmasin
const HOTWORD_COOLDOWN_MS = parseInt(env('HOTWORD_COOLDOWN_MS'), 10) || 3000;
const REALTIME_INPUT_GAIN = Math.max(1, Math.min(8, resolveCalibratedNumber('REALTIME_INPUT_GAIN', ENV_VALUES, AUDIO_CALIBRATION, 3)));
const OPENWAKEWORD_INPUT_GAIN = Math.max(1, Math.min(4, parseFloat(env('OPENWAKEWORD_INPUT_GAIN')) || 2));
const WAKE_STT_SILENCE_MS = 450;
const WAKE_STT_MAX_MS = 2800;
const WAKE_STT_PREROLL_MS = 350;

const REALTIME_ENABLED = (env('REALTIME_ENABLED') || 'true') !== 'false'; // haqiqiy real-vaqtli (gpt-realtime) suhbat rejimi
const REALTIME_IDLE_MS = parseInt(env('REALTIME_IDLE_MS'), 10) || 20000;  // shuncha vaqt jim bo'lsa, suhbat avtomatik yakunlanadi
const REALTIME_WAKE_PREROLL_MS = parseInt(env('REALTIME_WAKE_PREROLL_MS'), 10) || 1800;

// Parallel bajarilayotgan jonli vazifalar (run_task) holati — dashboard
// buni /api/realtime-tasks orqali o'qib, "hozir nima ustida ishlayapti"
// panelini ko'rsatadi. Daemon va dashboard alohida jarayon bo'lgani uchun
// fayl orqali ulanadi (soddaroq, qo'shimcha IPC shart emas).
const REALTIME_TASKS_STATE_FILE = path.join(PROJECT_DIR, '.realtime-tasks-state.json');
const RUNTIME_STATE_FILE = path.join(PROJECT_DIR, '.jarvis-runtime.json');
const VOICE_FLIGHT_RECORDER_FILE = path.join(PROJECT_DIR, '.run', 'voice-flight-recorder.jsonl');
const MISSION_CONTROL_FILE = path.join(PROJECT_DIR, '.mission-control.json');
const REALTIME_TASKS_MAX = 15;
let _realtimeTasks = [];
const runtime = new JarvisRuntime({
  statusFile: RUNTIME_STATE_FILE,
  commandWindowMs: parseInt(env('COMMAND_DEDUP_MS'), 10) || 5000,
  responseWindowMs: parseInt(env('RESPONSE_DEDUP_MS'), 10) || 15000
});
const DAEMON_STARTED_AT = Date.now();
const runtimeIdentity = () => ({ pid: process.pid, startedAt: DAEMON_STARTED_AT });
const missions = new MissionControl({ file: MISSION_CONTROL_FILE, defaultMaxAttempts: 3 });
const skillPlatform = createSkillPlatform();
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
  try { fs.writeFileSync(REALTIME_TASKS_STATE_FILE, JSON.stringify(_realtimeTasks.slice(-REALTIME_TASKS_MAX))); } catch (e) {}
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

// ── UYG'ONISH OVOZI ── Trigger (Fn/hotword/qarsak) ishlagan zahoti, jonli
// suhbat ulanishini kutmasdan, DARHOL eshitilgan tayyor ovoz ("Labbay,
// eshityapman.") — foydalanuvchi trigger chindan ishlaganini, Jarvis
// tinglashga tayyor ekanini bir zumda bilib olishi uchun (avval hech qanday
// tovush chiqmasdan, foydalanuvchi eshityaptimi-yo'qmi bilmay qolardi).
const WAKE_SOUND_PATH = path.join(PROJECT_DIR, 'assets', 'wake-sound.mp3');

// Bu ovoz ijro etilayotgan vaqtda mikrofon jonli sessiyaga UMUMAN
// yuborilmaydi (Jarvis o'z ovozini "foydalanuvchi gapirdi" deb qabul
// qilmasligi uchun) — ya'ni bu butunlay O'LIK vaqt: foydalanuvchi
// gapirsa ham eshitilmaydi. Shuning uchun ovoz imkon qadar QISQA
// bo'lishi kerak (avval "Labbay, eshityapman." 2.18s edi — trigger'dan
// keyin 2.4 soniya davomida gapirib bo'lmasdi, real o'lchov bo'yicha bu
// butun oqimdagi eng katta kechikish edi; hozir "Labbay boss" 0.72s).
// Davomiylik fayldan O'QIB olinadi — fayl almashtirilsa, qo'lda raqam
// yangilash esdan chiqib, mos kelmay qolmasin.
const WAKE_SOUND_MS = detectWakeSoundMs(WAKE_SOUND_PATH);

// ════════════════════════════════════════════
// TELEGRAM / TTS / AGENT BRIDGE (core/agent-bridge.js)
// ════════════════════════════════════════════
const { sendTelegram, sendTelegramVoice, ttsToFile, askOpenClaw, agentProviders, askAgent } = createAgentBridge({
  chatId: CHAT_ID, token: TOKEN, projectDir: PROJECT_DIR, env, azureOpenAiKey: AZURE_OPENAI_KEY, skillPlatform, runtime
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
  dailySuggestionBudget: parseInt(env('PROACTIVE_DAILY_BUDGET'), 10) || 8
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
const fastActionLearnJob = createFastActionLearnJob({ projectDir: PROJECT_DIR, localDateStr, askAgent, sendTelegram, writeMemory });
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
  const ffmpeg = spawn('sox', [
    '-d',                              // default device
    '-t', 'raw',                        // output raw PCM
    '-r', String(SAMPLE_RATE),
    '-c', '1',
    '-b', '16',
    '-e', 'signed',
    '-'                                 // stdout
  ]);
  ffmpeg.on('error', (err) => er('Mic process error: ' + err.message));
  ffmpeg.stderr.on('data', () => {});
  return ffmpeg;
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
  let pttActive = false; // Fn tugmasi bosib turilganda true — avto-sukunat kesish o'chadi
  let lastFnDownAt = 0;
  // Mac mikrofonining real tinch RMS'i sinovda 100–200 oralig'ida chiqdi.
  // 40 dan boshlash shovqinni nutq deb olib, uzluksiz STT segment yuborardi.
  let ambientEnergy = ENERGY_MIN_STT;

  function isWakePhrase(text) {
    const normalized = String(text || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const compact = normalized.replace(/\s+/g, '');
    return ['jarvis', 'jarviz', 'jervis', 'djervis', 'yarvis', 'jorvis', 'djarvis', 'charvis', 'jarv'].some(word =>
      normalized.includes(word) || compact.includes(word)
    );
  }

  function submitWakeStt(pcm, measuredEnergy) {
    if (!pcm.length || sttBackupInFlight || Date.now() - lastSttCheck < 900) return;
    lastSttCheck = Date.now();
    sttBackupInFlight = true;
    const gain = Math.max(1, Math.min(5, ENERGY_TARGET / Math.max(measuredEnergy, 1)));
    const wavBuf = pcmToWavBuffer(applyGain(Buffer.from(pcm), gain));
    inf('STT wake segment (' + Math.round(pcm.length / (SAMPLE_RATE * 2) * 1000) + 'ms, energy=' + Math.round(measuredEnergy) + ')...');
    _sttPool.recognize(wavBuf, 'en-US').then(r => {
      if (r && r.status === 'ok' && r.text) {
        inf('STT wake heard: "' + r.text + '"');
        if (isWakePhrase(r.text) && state === 'listening' && Date.now() - lastHotwordTime > HOTWORD_COOLDOWN_MS) {
          triggerVoice('🔥 HOTWORD (STT backup): "' + r.text + '"');
        }
      } else if (r && r.reason && !['NoMatch', 'nomatch', 'unknown'].includes(r.reason) && Date.now() - lastSttBackupNotice > 60000) {
        lastSttBackupNotice = Date.now();
        wrn('STT backup vaqtincha javob bermadi: ' + r.reason);
      }
    }).catch(e => {
      if (Date.now() - lastSttBackupNotice > 60000) {
        lastSttBackupNotice = Date.now();
        wrn('STT backup vaqtincha ishlamadi: ' + (e.message || e));
      }
    }).finally(() => { sttBackupInFlight = false; });
  }

  // Wake-word'dan keyin eski batch STT → agent → TTS yo'li emas, mavjud
  // gpt-realtime sessiyasi ishga tushadi. Realtime modul audio streaming,
  // barge-in va run_task/fast_action vositalarini o'zi boshqaradi; daemon esa
  // mikrofon oqimi, idle timeout va dashboard task holatini ulaydi.
  function startRealtimeSession(reason) {
    if (_activeRealtimeSession || state !== 'listening') return false;

    const session = new RealtimeSession({
      transcribeUzbek: async (pcm16) => {
        if (!pcm16?.length || !_sttPool) return { text: '', confidence: 0 };
        const result = await _sttPool.recognize(pcmToWavBuffer(pcm16), 'uz-UZ');
        if (!result || result.status !== 'ok') return { text: '', confidence: 0 };
        return { text: result.text || '', confidence: result.confidence || 0 };
      },
      // Default RealtimeSession'ning o'z ichki askExpert()'i `openclaw agent`
      // CLI'ni (run_task bilan bir xil, Kimi-K2.6) spawn qiladi — haqiqiy
      // kuchli `deep-think` (gpt-5.4, to'g'ridan-to'g'ri Azure Chat
      // Completions, tool-loop'siz — shu sabab 3-4 baravar tezroq ham)
      // hech qachon ishlatilmasdi. Shu yerga ulash orqali `ask_expert` va
      // deterministik expert/grounding yo'li ham haqiqiy kuchli modelga boradi.
      expertAnswer: async (question, callId, grounding) => {
        try {
          return await skillPlatform.invoke('deep-think', 'askExpert', { question, context: grounding });
        } catch (e) {
          return "Ekspert bilan bog'lanib bo'lmadi.";
        }
      }
    });
    const flightRecorder = new VoiceFlightRecorder({ file: VOICE_FLIGHT_RECORDER_FILE });
    flightRecorder.beginSession({ trigger: reason, mode: reason.includes('Fn') ? 'push-to-talk' : 'wake-word' });
    runtime.beginConversation(reason.includes('Fn') ? 'push-to-talk' : 'wake-word');
    const connectStartedAt = Date.now();
    _activeRealtimeSession = session;
    state = 'realtime';
    lastHotwordTime = Date.now();
    // Hotword ham, Fn ham foydalanuvchiga darhol bir xil qisqa ovozli tasdiq
    // beradi: assets/wake-sound.mp3 ("Labbay, boss").
    // Ack davomida mikrofon oqimini tashlaymiz: aks holda karnaydagi "Labbay,
    // boss" preroll'ga kirib, server uni foydalanuvchi nutqi deb qabul qiladi.
    // Ack tugagach, ulanish hali tayyor bo'lmasa haqiqiy buyruq bounded
    // preroll'ga yig'iladi va ready bo'lgan zahoti yuboriladi.
    const wakeMuteUntil = Date.now() + WAKE_SOUND_MS + 80;
    playWakeSound(WAKE_SOUND_PATH);
    let idleTimer = null;
    let finished = false;
    let sessionWasReady = false;
    let lastUserTranscript = '';
    let activeToolCount = 0;
    let wakeAudioPending = true;
    const wakePreroll = [];
    let wakePrerollBytes = 0;
    let speechStoppedAt = 0;
    let transcriptAcceptedAt = 0;
    let firstAudioObserved = false;
    const maxWakePrerollBytes = Math.ceil(SAMPLE_RATE * 2 * REALTIME_WAKE_PREROLL_MS / 1000);

    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        // Sessiyani yopish running run_task jarayonlarini cancel qiladi.
        // Natija kelguncha timeout'ni uzaytirib turamiz.
        if (activeToolCount > 0) return armIdleTimer();
        finishRealtimeSession('jimlik timeout');
      }, REALTIME_IDLE_MS);
    };
    const finishRealtimeSession = (why) => {
      if (finished) return;
      finished = true;
      flightRecorder.endSession(why);
      clearTimeout(idleTimer);
      if (_activeRealtimeSession === session) _activeRealtimeSession = null;
      try { session.close(); } catch (e) {}
      state = 'listening';
      runtime.endConversation(why);
      runtime.heartbeat('voice-daemon', { state, ...runtimeIdentity() });
      nextStepTime = Date.now();
      inf('Realtime suhbat yakunlandi: ' + why);
    };

    session.on('ready', () => {
      sessionWasReady = true;
      _realtimeFailureCount = 0;
      _realtimeDisabledUntil = 0;
      runtime.observeLatency('realtime-connect', Date.now() - connectStartedAt);
      runtime.setConversationMode('listening');
      runtime.heartbeat('realtime-api', { status: 'ready' });
      ok('Realtime ovoz sessiyasi ulandi');
      // Wake chime/handshake vaqtida aytilgan "Hey Jarvis, ..." buyrug'ini
      // yo'qotmasdan sessiya tayyor bo'lgach uzatamiz.
      if (wakePreroll.length) {
        for (const chunk of wakePreroll) session.feedAudio(chunk);
        wakePreroll.length = 0;
        wakePrerollBytes = 0;
      }
      wakeAudioPending = false;
      armIdleTimer();
    });
    session.on('audio_activity', armIdleTimer);
    session.on('user_speaking', () => {
      flightRecorder.beginTurn({ source: 'realtime', trigger: reason });
      runtime.setConversationMode('user-speaking');
      clearTimeout(idleTimer);
    });
    session.on('user_speech_stopped', () => {
      speechStoppedAt = Date.now();
      transcriptAcceptedAt = 0;
      firstAudioObserved = false;
      armIdleTimer();
    });
    session.on('turn_suppressed', (reason, text) => {
      flightRecorder.textEvent('turn.suppressed', text, { reason });
      inf('🔇 Realtime turn bloklandi (' + reason + '): ' + String(text || '').slice(0, 100));
      runtime.setConversationMode('listening');
      armIdleTimer();
    });
    session.on('user_transcript', (text) => {
      const clean = String(text || '').trim();
      if (!clean) return;
      const accepted = runtime.acceptCommand(clean, { source: 'realtime-transcript' });
      if (!accepted.accepted) {
        wrn('Takror realtime transkript tashlandi: ' + clean);
        return;
      }
      lastUserTranscript = clean;
      transcriptAcceptedAt = Date.now();
      if (speechStoppedAt) runtime.observeLatency('speech-to-transcript', transcriptAcceptedAt - speechStoppedAt);
      flightRecorder.textEvent('command.accepted', clean, { source: 'realtime-transcript' });
      runtime.setConversationMode('thinking');
      inf('🎙 Realtime: ' + clean);
      sendTelegram('🎙 ' + clean);
      armIdleTimer();
    });
    session.on('assistant_transcript', (text) => {
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
      try {
        writeMemory('Ovozli suhbat', 'Foydalanuvchi: ' + (lastUserTranscript || '(transkript yo\'q)') + '\nJarvis: ' + clean.substring(0, 700), ['voice', 'realtime']);
      } catch (e) {}
      lastUserTranscript = '';
      armIdleTimer();
    });
    session.on('turn_done', () => {
      flightRecorder.event('turn.completed');
      armIdleTimer();
    });
    session.on('telemetry', (type, data) => {
      flightRecorder.event(type, data);
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
    });
    session.on('tool_call', (description, callId) => {
      activeToolCount += 1;
      flightRecorder.event('tool.started', { description, callId });
      runtime.requestTask(description, { id: callId, source: 'realtime' });
      runtime.transitionTask(callId, 'running');
      beginSingleStepMission(description, {
        id: stableId('realtime', callId), source: 'realtime', idempotencyKey: 'realtime:' + callId
      });
      rtTaskStarted(callId, description);
      inf('🛠 Jonli vazifa: ' + description);
      armIdleTimer();
    });
    session.on('tool_result', (result, callId) => {
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
      const finishedTask = _realtimeTasks.find(t => t.callId === callId);
      if (finishedTask?.status === 'completed' && !/^fast_action:/i.test(String(finishedTask.description || ''))) playTaskDoneSound();
      armIdleTimer();
    });
    session.on('error', (err) => {
      flightRecorder.event('turn.failed', { error: String(err.message || err) });
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
        runtime.heartbeat('realtime-api', {
          status: sessionWasReady ? 'degraded' : 'error',
          reason: 'socket-closed-unexpectedly'
        });
        if (sessionWasReady) {
          playSystemSound('Basso');
          sendTelegram('⚠️ Ovozli suhbat kutilmaganda uzildi — keyingi chaqiruvda qayta ulanadi.');
        }
      }
      finishRealtimeSession('ulanish yopildi');
    });

    inf(reason + ' — realtime suhbat ulanmoqda');
    session.connect();
    armIdleTimer();

    // Marker saqlanadi, lekin shu oraliqdagi audio endi tashlanmaydi — bounded
    // preroll'ga yig'iladi va ready eventida ketma-ket yuboriladi.
    session._jarvisWakeMuteUntil = wakeMuteUntil;
    session._jarvisQueueWakeAudio = (chunk) => {
      if (!wakeAudioPending || !chunk?.length) return false;
      // `true` qaytarish daemon'ga bu chunk bilan boshqa ish qilmaslikni
      // bildiradi. Ack tugamaguncha chunk ataylab saqlanmaydi.
      if (Date.now() < wakeMuteUntil) return true;
      wakePreroll.push(Buffer.from(chunk));
      wakePrerollBytes += chunk.length;
      while (wakePrerollBytes > maxWakePrerollBytes && wakePreroll.length > 1) {
        wakePrerollBytes -= wakePreroll.shift().length;
      }
      return true;
    };
    return true;
  }

  // Barcha triggerlar bitta state transition'dan o'tadi. Rekonstruksiya
  // qilingan snapshotda triggerVoice chaqiriqlari qolib, funksiyaning o'zi
  // yo'qolgan edi — Porcupine/qarsak topilganda ReferenceError bo'lib daemon
  // qular edi. Fn DOWN/UP ham pause-sentinel brokeridan shu yerga keladi.
  function triggerVoice(reason) {
    if (state !== 'listening') return false;
    // Lokal model va STT fallback parallel tinglaydi. Ulardan biri trigger
    // qilishi bilan ikkinchisining yarim yig'ilgan segmentini tashlaymiz;
    // aks holda realtime tugagach eski “Hey Jarvis” keyingi nutqqa qo'shiladi.
    wakeSpeechBuffers = [];
    wakeSpeechStartedAt = 0;
    wakeSpeechLastVoiceAt = 0;
    if (REALTIME_ENABLED && Date.now() >= _realtimeDisabledUntil) return startRealtimeSession(reason);
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
    playWakeSound(WAKE_SOUND_PATH);
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
      pttActive = false;
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
          if (pttActive || Date.now() - lastFnDownAt < 250) continue;
          pttActive = true;
          lastFnDownAt = Date.now();
          triggerVoice('⌨️ Fn push-to-talk');
        } else if (event === 'UP') {
          pttActive = false;
          // Tugma qo'yib yuborilganda yozuv tabiiy silence chegarasidan tez
          // yakunlansin; data loop STT'ni xavfsiz ravishda boshlaydi.
          lastVoiceTime = Date.now() - SILENCE_MS - 1;
        } else if (event === 'RESET') {
          pttActive = false;
          lastFnDownAt = 0;
        }
      }
    });
    const reconnect = () => {
      pttActive = false;
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
  }, 5000);
  runtimeHeartbeat.unref();
  sendTelegram('🚀 Jarvis v5.0 BLAZING faol');

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
          const realtimeChunk = applyGain(Buffer.from(stepData), REALTIME_INPUT_GAIN);
          const queued = typeof _activeRealtimeSession._jarvisQueueWakeAudio === 'function'
            && _activeRealtimeSession._jarvisQueueWakeAudio(realtimeChunk);
          if (!queued && now >= (_activeRealtimeSession._jarvisWakeMuteUntil || 0)) {
            _activeRealtimeSession.feedAudio(realtimeChunk);
          }
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
          let detected = false;
          if (_detector) {
            detected = _detector.processChunk(applyGain(Buffer.from(stepData), OPENWAKEWORD_INPUT_GAIN));
          }

          if (detected && (now - lastHotwordTime > HOTWORD_COOLDOWN_MS)) {
            triggerVoice('🔥 HOTWORD: "Hey Jarvis" (openWakeWord)');
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
            if ((silenceAge >= WAKE_STT_SILENCE_MS && speechAge >= 400) || speechAge >= WAKE_STT_MAX_MS) {
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
        if ((!pttActive && elapsed > 800 && silence > SILENCE_MS) || elapsed > CMD_MAX * 1000) {
          state = 'processing';
          const totalPCM = Buffer.concat(cmdBuffers);
          const wavBuf = pcmToWavBuffer(totalPCM);
          inf('STT ishlanyapti...');
          _sttPool.recognize(wavBuf, 'uz-UZ').then(r => {
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
  runtime.setConversationMode('thinking');
  const commandStartedAt = Date.now();
  inf('>>> ' + command); sendTelegram('🎙 ' + command);
  if (!fs.existsSync(path.join(PROJECT_DIR, '.jarvis-onboarded'))) {
    fs.writeFileSync(path.join(PROJECT_DIR, '.jarvis-onboarded'), 'true'); writeMemory('Onboard', 'start');
    const ap = await ttsToFile('Salom, men Jarvisman'); if (ap) try { execSync('afplay "' + ap + '"'); } catch(e){}
  }

  // Quick commands
  if (/eslab qol|esda tut/i.test(command) && command.length > 15) {
    const cl = command.replace(/eslab qol|esda tut/gi, '').trim();
    writeMemory('Voice', cl, ['voice']); sendTelegram('✅ Eslab qoldim');
    const ap = await ttsToFile('Eslab qoldim'); if (ap) try { execSync('afplay "' + ap + '"'); } catch(e){}
    return;
  }
  if (/kuzatishni (boshla|yo?qish)/i.test(command)) {
    try { execSync('echo \'{"action":"start"}\' | node skills/screen-monitor/index.js', { cwd: PROJECT_DIR }); } catch(e){}
    const ap = await ttsToFile('Kuzatuv yoqildi'); if (ap) try { execSync('afplay "' + ap + '"'); } catch(e){}
    return;
  }
  if (/kuzatishni (to.xtat|o.chir)/i.test(command)) {
    try { execSync('echo \'{"action":"stop"}\' | node skills/screen-monitor/index.js', { cwd: PROJECT_DIR }); } catch(e){}
    const ap = await ttsToFile('Kuzatuv o.chirildi'); if (ap) try { execSync('afplay "' + ap + '"'); } catch(e){}
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
      return;
    }
    runtime.setConversationMode('speaking');
    ok('<<< ' + reply.substring(0, 80)); sendTelegram('🤖 ' + reply);
    try { writeMemory('Ovozli buyruq', 'Foydalanuvchi: ' + command + '\nJarvis: ' + reply.substring(0, 500), ['voice', 'buyruq']); } catch (e) {}
    const audio = await ttsToFile(reply.substring(0, 400));
    if (audio) {
      try { execSync('afplay "' + audio + '"'); ok('🔊 Ovoz'); } catch(e){}
      const ogg = audio.replace(/\.mp3$/, '.ogg');
      try { execSync('ffmpeg -y -i "' + audio + '" -c:a libopus "' + ogg + '" 2>/dev/null'); sendTelegramVoice(ogg); } catch(e){}
      [ogg, audio].forEach(p => { try { fs.unlinkSync(p); } catch(e){} });
    }
  } else {
    const fallback = 'Hozir javobni tayyorlay olmadim. Iltimos, yana bir marta ayting.';
    wrn('Agent bo\'sh javob qaytardi');
    sendTelegram('⚠️ ' + fallback);
    const audio = await ttsToFile(fallback);
    if (audio) {
      try { execSync('afplay "' + audio + '"', { stdio: 'ignore' }); } catch(e) {}
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
  if (_sttPool) { _sttPool.killAll(); }
  try { runtime.close(); } catch(e) {}
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

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
