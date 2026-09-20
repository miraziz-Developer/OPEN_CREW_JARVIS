#!/usr/bin/env node
/**
 * REALTIME VOICE — multilingual low-latency voice pipeline.
 *
 * Voice Live gpt-realtime (primary) or gpt-realtime-1.5 (fallback) handles
 * STT, VAD, conversation and speech directly.
 * Complex/grounded questions use the tiered Grok/GPT-5.6 Sol reasoning path and are spoken by
 * the same Realtime session, avoiding a second STT/TTS provider round-trip.
 *
 * Murakkab, ko'p bosqichli vazifalar (brauzer, fayl, ekran) uchun
 * `run_task` funksiyasi orqali mavjud to'liq agentga (gpt-6-astra, barcha
 * skilllar bilan) topshiriladi — shu bilan hech qanday imkoniyat
 * yo'qolmaydi, faqat oddiy suhbat ancha tezlashadi.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const EventEmitter = require('events');
const WebSocketClient = require('ws');
const { DuplexVoiceEngine } = require('../../core/duplex-voice-engine');
const { PcmPlaybackBuffer } = require('../../core/pcm-playback-buffer');
const { classifyUserTurn, isRepeatedResponse } = require('../../core/voice-turn-policy');
const { chooseTranscript, authoritativeTimeoutMs, nativeIsConfident } = require('../../core/stt-recovery');
const { loadCalibration, resolveCalibratedNumber, resolveBargeInResidual } = require('../../core/audio-calibration');
const { ConversationContext } = require('../../core/conversation-context');
const { ActionSafetyPolicy } = require('../../core/action-safety-policy');
const { recordHighRiskCompletion } = require('../../core/autonomous-action-audit');
const { buildVoiceProviders } = require('../../core/voice-provider');
const { createAgentBridge, needsPersistentExecution } = require('../../core/agent-bridge');
const { createSkillPlatform } = require('../platform');

const { PROJECT_DIR } = require('../../core/paths');
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

// Media (video/musiqa) "hali ijro etilyapti" holati — avval bu faqat
// bitta RealtimeSession obyekti ichida (xotirada) saqlanardi. Muammo:
// har bir Fn/hotword chaqiruvi YANGI RealtimeSession yaratadi (avvalgi
// suhbat 20s jimlikdan keyin tugaydi) — shuning uchun video bir
// suhbatda ishga tushirilib, keyingi (yangi) suhbat boshlanganda
// _mediaModeActive qayta false'dan boshlanardi, video esa fonda hali
// ham ijro etilayotgan bo'lardi. Natija: real logda tasdiqlandi — video
// subtitr/outro matnlari (koreys/turk/yapon tillarida) "foydalanuvchi
// gapirdi" deb qayta-qayta noto'g'ri transkript qilingan, chunki YANGI
// suhbat past chegara (0.6) bilan boshlangan. Fayl orqali saqlash bu
// holatni suhbatlar orasida ("session"lar orasida) saqlab qoladi.
const MEDIA_STATE_FILE = path.join(PROJECT_DIR, '.media-playing-state.json');
const MEDIA_STATE_TTL_MS = 40 * 60 * 1000; // 40 daqiqadan keyin eskirgan deb hisoblanadi (video/qo'shiq odatda shuncha davom etmaydi)
function saveMediaState() {
  fs.promises.writeFile(MEDIA_STATE_FILE, JSON.stringify({ active: true, setAt: Date.now() })).catch(() => {});
}
async function isMediaRecentlyLikelyPlaying() {
  try {
    const s = JSON.parse(await fs.promises.readFile(MEDIA_STATE_FILE, 'utf8'));
    return s.active && (Date.now() - s.setAt) < MEDIA_STATE_TTL_MS;
  } catch (e) { return false; }
}

// TIZIM DARAJASIDA media ijro etilayotganini aniqlash. Yuqoridagi fayl-holati
// faqat JARVIS O'ZI video/musiqa ochganda ishlaydi — foydalanuvchi o'zi
// YouTube ochsa, tizim bundan bexabar qolardi. Real logda oqibati ko'rindi:
// mikrofon video ovozini olib, uni "foydalanuvchi gapirdi" deb transkript
// qilgan (turkcha YouTube outro matni aynan shunday tushib qolgan).
//
// macOS bunga aniq signal beradi: media ijro etuvchi ilova (Chrome, Spotify
// va h.k.) "Playing audio" nomli assertion qo'yadi. Sinab tasdiqlandi:
// Jarvisning O'Z ovozi (afplay) bu assertion'ni QO'YMAYDI — ya'ni o'zimizning
// ovozimizdan soxta ishga tushish bo'lmaydi.
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
// OpenAI realtime ovozlari ichida `cedar` va `marin` eng sifatli tavsiya
// etilgan avlodga kiradi. JARVIS uchun tiniqroq, vazmin erkak ohangli cedar
// tanlandi. .env orqali xohlansa keyin A/B almashtirish mumkin.
const VOICE_STYLE = env('JARVIS_VOICE_STYLE', 'cinematic-robot');
// Empty lets the Realtime provider detect the language for multilingual turns.
const TRANSCRIPTION_LANGUAGE = env('REALTIME_TRANSCRIPTION_LANGUAGE', '');
const TRANSCRIPTION_MODEL = env('REALTIME_TRANSCRIPTION_MODEL', 'gpt-4o-transcribe');
// Voice Live'da Azure Speech transkripsiyasi ~0.2 s (gpt-4o-transcribe ~1 s) — o'lchangan.
// Zaxira azure-realtime faqat OpenAI modellarini qabul qiladi.
const VOICE_LIVE_TRANSCRIPTION_MODEL = env('REALTIME_VOICE_LIVE_TRANSCRIPTION_MODEL', 'azure-speech');
// Jarvis gapirib bo'lgach, mikrofon yana necha ms kutib turadi (xona
// akustikasi/karnay ovozi pasayishi uchun) — real foydalanishda 500ms
// yetarli emasligi aniqlandi (Jarvis o'z ovozini qayta eshitib qolgan).
const MIC_MUTE_GRACE_MS = parseInt(env('MIC_MUTE_GRACE_MS'), 10) || 650;
const NORMAL_VAD_THRESHOLD = parseFloat(env('REALTIME_VAD_THRESHOLD')) || 0.55;
const MEDIA_VAD_THRESHOLD = parseFloat(env('REALTIME_MEDIA_VAD_THRESHOLD')) || 0.72;
// Fn/hotword orqali boshlangan oddiy suhbatda turn tez yopilishi kerak.
// 180 ms odatiy gap ichidagi nafas pauzalarini kesmasdan birinchi javobni
// avvalgi 220 ms profilga nisbatan tezroq boshlaydi; media alohida konservativ
// profil bilan himoyalangan.
const NORMAL_VAD_SILENCE_MS = parseInt(env('REALTIME_VAD_SILENCE_MS'), 10) || 180;
const MEDIA_VAD_SILENCE_MS = parseInt(env('REALTIME_MEDIA_VAD_SILENCE_MS'), 10) || 750;
// Realtime'da output token budjeti matn va audioni birga qoplaydi. Live
// telemetry 160 tokenli 7–13 so'z javoblarning ham `max_output_tokens` bilan
// kesilganini ko'rsatdi. Lo'ndalik prompt/policy orqali boshqariladi; texnik
// limit esa tayyor gapni o'rtasida uzmasligi kerak.
const REALTIME_MAX_RESPONSE_TOKENS = parseInt(env('REALTIME_MAX_RESPONSE_TOKENS'), 10) || 1024;
// Realtime audio tokenlari matn tokenlaridan ancha tez sarflanadi. 40 token
// hatto "Hozir soat 20:20" kabi qisqa tasdiqni ham o'rtasida kesib qo'ydi.
// Fast-action javobi qisqa bo'lsa-da, audio to'liq ijro etilishi uchun alohida
// xavfsiz limit ishlatiladi.
const REALTIME_FAST_ACTION_MAX_RESPONSE_TOKENS = parseInt(env('REALTIME_FAST_ACTION_MAX_RESPONSE_TOKENS'), 10) || 256;
// Realtime audio chunklari tarmoqda notekis kelishi mumkin. Audio darhol
// ijro qilinsa sox pipe vaqti-vaqti bilan och qolib, gap o'rtasida jimlik
// paydo qiladi. Kichik boshlang'ich zaxira bu jitter'ni yutadi.
const PLAYBACK_PREBUFFER_MS = Math.max(0, parseInt(env('REALTIME_PLAYBACK_PREBUFFER_MS', '40'), 10) || 0);
const PLAYBACK_MAX_WAIT_MS = Math.max(0, parseInt(env('REALTIME_PLAYBACK_MAX_WAIT_MS', '80'), 10) || 0);
const DUPLEX_ECHO_THRESHOLD = parseFloat(env('DUPLEX_ECHO_THRESHOLD')) || 0.72;
const DUPLEX_BARGE_IN_RMS = resolveBargeInResidual(ENV_VALUES, AUDIO_CALIBRATION, 900);
const DUPLEX_NOISE_FLOOR = resolveCalibratedNumber('DUPLEX_NOISE_FLOOR', ENV_VALUES, AUDIO_CALIBRATION, 80);
const DUPLEX_NOISE_MULTIPLIER = resolveCalibratedNumber('DUPLEX_NOISE_MULTIPLIER', ENV_VALUES, AUDIO_CALIBRATION, 2.4);
// Past Mac mikrofon signali uchun local duplex engine yuborayotgan nutqni
// kuchaytiradi. Echo/noise qarori xom signalda qoladi, shuning uchun preamp
// Jarvisning o'z ovozini barge-in deb noto'g'ri qabul qilishini oshirmaydi.
const REALTIME_INPUT_GAIN = Math.max(1, Math.min(8, resolveCalibratedNumber('REALTIME_INPUT_GAIN', ENV_VALUES, AUDIO_CALIBRATION, 3)));
// Lokal gate server VAD so'ragan jimlikdan oldin audio yuborishni to'xtatsa,
// provider speech_stopped chiqarmaydi va turn idle timeoutgacha ochiq qoladi.
// Media VAD oynasi ustiga bitta daemon audio step (150 ms) qo'shamiz. Oddiy
// dialog esa o'zining qisqaroq hangover'idan foydalanadi; aks holda 900 ms
// local gate 300 ms server VAD optimizatsiyasini samarasiz qilib qo'yardi.
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
// Tabiiy nutq boshidagi undosh yoki juda qisqa pauza energiyani vaqtincha
// pasaytirishi mumkin. Candidate'ni kichik oynada saqlaymiz; uzoq uzilish esa
// alohida echo/shovqin bo'lishi mumkinligi uchun uni reset qiladi.
const BARGE_IN_MAX_GAP_MS = parseInt(env('REALTIME_BARGE_IN_MAX_GAP_MS'), 10) || 80;

const IN_RATE = 16000;   // jarvis_daemon.js mikrofon oqimi shu tezlikda
const OUT_RATE = 24000;  // Realtime API kutgan/qaytaradigan tezlik

// ── 16kHz → 24kHz oddiy chiziqli interpolyatsiya (real-vaqtli, sox spawn qilmasdan) ──
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
  const SESSION_PREFIX_PADDING_MS = parseInt(env('AZURE_VOICELIVE_SESSION_PREFIX_PADDING_MS') || env('AZURE_VOICELIVE_WAKE_PREFIX_PADDING_MS') || '80', 10);
  const SESSION_INTERRUPT = (env('AZURE_VOICELIVE_INTERRUPT_RESPONSE') || 'true') === 'true';

  const turnDetection = options.startMediaAware
    ? { type: 'server_vad', threshold: MEDIA_VAD_THRESHOLD, silence_duration_ms: MEDIA_VAD_SILENCE_MS, prefix_padding_ms: SESSION_PREFIX_PADDING_MS, create_response: false, interrupt_response: SESSION_INTERRUPT }
    : { type: 'server_vad', threshold: NORMAL_VAD_THRESHOLD, silence_duration_ms: NORMAL_VAD_SILENCE_MS, prefix_padding_ms: SESSION_PREFIX_PADDING_MS, create_response: false, interrupt_response: SESSION_INTERRUPT };
  const transcription = {
    model: provider.id === 'voice-live' ? VOICE_LIVE_TRANSCRIPTION_MODEL : TRANSCRIPTION_MODEL,
    ...(TRANSCRIPTION_LANGUAGE ? { language: TRANSCRIPTION_LANGUAGE } : {})
  };
  const common = {
    instructions: options.instructions,
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
      // Azure playgrounddagi kabi: server exo bostirish va chuqur shovqin filtri —
      // JARVIS o'z ovozini eshitib o'zini bo'lib qo'ymasligi uchun.
      ...(provider.id === 'voice-live' ? {
        input_audio_echo_cancellation: { type: 'server_echo_cancellation' },
        input_audio_noise_reduction: { type: 'azure_deep_noise_suppression' }
      } : {})
    }
  };
}

// Suhbat BOSHLANISHIDAN oldin, foydalanuvchi so'nggi soatlarda nima qilgani
// haqidagi qisqa xulosa. Avval har bir suhbat "bo'sh sahifadan" boshlanardi —
// foydalanuvchi "o'sha ishni davom ettir" desa, Jarvis nima haqida ketayotganini
// bilmasdan qayta so'rashi kerak edi. Endi u allaqachon xabardor holda ochiladi.
const RECENT_CONTEXT_HOURS = parseFloat(env('RECENT_CONTEXT_HOURS')) || 2;
const RECENT_CONTEXT_MAX_BLOCKS = 8;

function recentContextBlock() {
  try {
    const mem = require('../memory');
    const now = new Date();
    const items = [];
    // Kun almashgan payt (masalan 00:15) kechagi faylda hali yangi yozuvlar
    // bo'lishi mumkin — shuning uchun ikkala kun ham ko'riladi.
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
        const body = block.replace(/^## .+$/m, '').replace(/\*\*Teglar:\*\*.*$/m, '').trim();
        if (body) items.push({ t: bt, line: m[1] + ':' + m[2] + ' — ' + m[3] + ': ' + body.replace(/\s+/g, ' ').slice(0, 220) });
      }
    }
    if (!items.length) return '';
    items.sort((a, b) => a.t - b.t);
    return "\n\nSO'NGGI FAOLIYAT (foydalanuvchi shu yaqin soatlarda nima qilgani — siz buni ALLAQACHON " +
      "bilasiz, qayta so'ramang; \"o'shani davom ettir\", \"o'sha ish\" desa, shu ro'yxatdan tushuning):\n" +
      items.slice(-RECENT_CONTEXT_MAX_BLOCKS).map(i => '- ' + i.line).join('\n') + '\n\n';
  } catch (e) { return ''; }
}

// FOYDALANUVCHI PROFILI (Jarvis/Profile/User.md) — daily-synthesis har kuni
// yangi sana-bo'limi qo'shib boradi (birlashtirmaydi), shuning uchun fayl
// vaqt o'tishi bilan cheksiz o'sadi. Avval bu profil jonli ovozli suhbatga
// UMUMAN kirmasdi (haqiqiy topilma) — Jarvis foydalanuvchi haqida o'zi
// o'rgangan hech narsani suhbatda ishlatmasdi. Endi qo'lda kiritilgan
// "Odatlar" bo'limi (barqaror) + eng so'nggi bir nechta avtomatik
// o'rganilgan-naqshlar bo'limi (chegaralangan hajmda) qo'shiladi.
const PROFILE_SUMMARY_MAX_SECTIONS = 3;
const PROFILE_SUMMARY_MAX_CHARS = 2000;

function profileSummaryBlock() {
  try {
    const profile = require('../memory').readProfile();
    if (profile.status !== 'ok' || !profile.content) return '';
    const sections = profile.content.split(/^## /m).slice(1);
    if (!sections.length) return '';
    const stable = sections.filter(s => s.trim().startsWith('Odatlar'));
    const recent = sections.filter(s => !s.trim().startsWith('Odatlar')).slice(-PROFILE_SUMMARY_MAX_SECTIONS);
    const combined = [...stable, ...recent].map(s => '## ' + s.trim()).join('\n\n').slice(0, PROFILE_SUMMARY_MAX_CHARS);
    if (!combined) return '';
    return "\n\nFOYDALANUVCHI PROFILI (vaqt o'tishi bilan o'rganilgan odatlar/naqshlar — bu haqiqiy, " +
      "tekshirilgan ma'lumot; foydalaning, lekin \"profilimda yozilishicha\" kabi meta-izoh bermang):\n" +
      combined + '\n\n';
  } catch (e) { return ''; }
}

// SOUL.md ning FAQAT ovozli suhbatga taalluqli bo'limlari. Qolganlari
// (xotira yozish qoidalari, ekran kuzatuv, brauzer/skill ishlatish,
// kunlik vazifalar) — `run_task` ichidagi TO'LIQ AGENTNING ishi, ovozli
// model ularni umuman bajarmaydi. To'liq fayl ~2800 token bo'lib, butun
// yo'riqnomaning 69% ini egallardi va har bir javobda qayta qayta ishlanardi.
const SOUL_VOICE_SECTIONS = ['Klondek harakat qilish', 'Chegaralar', 'Uslub', 'Asl Maqsad'];
const SOUL_FULL_FOR_VOICE = (env('SOUL_FULL_FOR_VOICE') || 'false') === 'true'; // A/B sinov uchun
let SOUL_FOR_VOICE = '';

function loadSoulForVoice() {
  const raw = SOUL_FOR_VOICE;
  if (!raw) return '';
  if (SOUL_FULL_FOR_VOICE) return raw;
  const out = [];
  // Sarlavhagacha bo'lgan kirish qismi (Jarvis kimligi) — qisqa, saqlanadi
  const firstHeading = raw.indexOf('\n## ');
  if (firstHeading > 0) out.push(raw.slice(0, firstHeading).trim());
  for (const part of raw.split(/^## /m).slice(1)) {
    const title = part.split('\n', 1)[0].trim();
    if (SOUL_VOICE_SECTIONS.some(s => title.startsWith(s))) out.push('## ' + part.trim());
  }
  return out.join('\n\n');
}
fs.promises.readFile(path.join(PROJECT_DIR, 'SOUL.md'), 'utf8').then(raw => { SOUL_FOR_VOICE = raw; }).catch(() => {});

function loadLegacyInstructions() {
  const soul = loadSoulForVoice();
  const voiceStyle = '';
  const pronunciationBlock = '';
  return (
      "You are Jarvis, the user's English-speaking realtime voice assistant. Interpret all incoming speech as English and always reply in English. " +
      "Be natural, calm, precise, and conversational. Speak at a measured, slightly slower-than-default pace with varied cadence and natural pauses. Usually answer in one short sentence; use two short sentences only when needed. " +
      "Never add greetings, preambles, status narration, markdown, or unsolicited suggestions. Do not say 'certainly', 'let me', or 'one moment' before acting. " +
      "VOICE CHARACTER: use an original cinematic machine-intelligence persona: deep, controlled, resonant, subtly metallic, authoritative but warm. " +
      "Keep the register low and full, with crisp consonants, measured rhythm, restrained emotion, and a subtle synthetic edge. Do not imitate any real actor or copyrighted character. " +
      "TOOLS: use fast_action for a supported one-step computer action; use run_task for browser interaction, files, coding, forms, or any multi-step task; " +
      "use see_screen when the user asks about what is visible; use recall_memory for older personal context; use ask_expert for serious analysis. " +
      "Call fast tools silently and speak only their result. A run_task may receive one brief acknowledgement, then report the actual result when available. " +
      "MEMORY: treat the recent activity and user profile below as facts you already remember. Use them naturally without saying that you read a memory file. " +
    "o'zing to'g'ridan-to'g'ri javob ber.\n\n" +
    "MUHIM — ko'p vazifali (multi-tasking) ishlash: har bir `run_task` chaqiruvi MUSTAQIL, alohida ishchi sifatida " +
    "fon rejimida ishlaydi va boshqa vazifalarga XALAQIT BERMAYDI. Shuning uchun: agar bitta vazifa (masalan brauzer/ekran " +
    "bilan ishlash) davom etayotgan bo'lsa-yu, foydalanuvchi BOSHQA, mustaqil vazifa so'rasa — birinchisi tugashini KUTMASDAN " +
    "darhol ikkinchi `run_task`'ni ham chaqir. Har biri qachon tugasa, o'sha payt natijasini alohida aytib ber. Faqat ikkinchi " +
    "vazifa BIRINCHISIGA bevosita bog'liq bo'lsa (masalan 'o'sha oynada davom et') — o'shanda birinchisi tugashini kutish kerak. " +
    "Agar foydalanuvchi BITTA GAPDA ikki yoki undan ko'p mustaqil ish aytsa (masalan 'emailni tekshir, kalendarni ko'r va " +
    "hisobot tayyorla'), ularni bitta ulkan descriptionga birlashtirma: HAR MUSTAQIL ISH UCHUN alohida `run_task`ni " +
    "darhol chaqir. Chaqiruvlarni ketma-ket kutma — tool calllarni bir javobning o'zida yubor, ishchilar parallel ishlasin.\n\n" +
    "MUHIM — ORTIQCHA GAPIRMASLIK: siz juda ko'p, keraksiz, takrorlanuvchi gap aytib yuborishga moyilsiz — bu qat'iyan man etiladi. " +
    "Qoidalar: (1) Bir xil fikrni (\"hammasi joyida\", \"davom eting\", \"yordam kerak bo'lsa ayting\") ketma-ket ikkinchi marta " +
    "TAKRORLAMANG — buni faqat bir marta ayting, keyin jim turing. (2) Har javob oxirida \"agar boshqa narsa kerak bo'lsa ayting\" " +
    "kabi odatiy jumla QO'SHMANG — foydalanuvchi buni allaqachon biladi. (3) Foydalanuvchi hech narsa demasa yoki noaniq/tushunarsiz " +
    "tovush eshitilsa (masalan fon shovqini) — O'ZINGIZDAN gapirmang, hech qanday javob yaratmang, jim kuting. (4) Vazifa " +
    "bajarilgach faqat NATIJANI 1 gapda ayting (masalan \"Chrome ochildi.\") — jarayon haqida hikoya qilmang, \"hozir " +
    "tekshiryapman\", \"jarayon davom etyapti\" kabi status-yangilanishlarni faqat foydalanuvchi ANIQ so'rasa ayting. " +
    "(5) ENG MUHIMI — foydalanuvchi sizga shunchaki qisqa tasdiq/aks-sado bersa (\"ha\", \"xo'p\", \"to'g'ri\", \"tushunarli\", " +
    "\"a\", \"mm\", yoki hatto tovush aniq eshitilmasa) — SIZ ALLAQACHON AYTGAN gapni QAYTA AYTMANG. Bunday holatda faqat " +
    "juda qisqa (1-2 so'z: \"xo'p\", \"ha\", yoki hech narsa) javob bering yoki umuman javob bermang — YANGI ma'lumot yo'q " +
    "bo'lsa gapirishning hojati yo'q. NOTO'G'RI MISOL (buni HECH QACHON qilmang): foydalanuvchi \"soat nechchi\" deb so'raydi, " +
    "siz \"Hozir soat 13:07\" deysiz, foydalanuvchi \"ha\" yoki aniqsiz tovush chiqaradi, va siz yana \"Ha, to'g'ri, hozir " +
    "soat 13:07\" deb TAKRORLAYSIZ — bu 3-4 marta ketma-ket takrorlanib, judayam yomon eshitiladi. TO'G'RI: bunday holatda " +
    "sukut saqlang yoki faqat \"xo'p\" deng, raqamni qayta aytmang. " +
    "Maqsad: kino JARVIS kabi — lo'nda, aniq, keraksiz so'zsiz.\n\n" +
    "MUHIM — JIDDIY SAVOLGA O'ZINGIZ JAVOB BERMANG: siz ovoz uchun optimallashtirilgan modelsiz — qisqa " +
    "suhbatda tez va tabiiysiz, lekin ko'p bosqichli FIKRLASHDA sekin va suvli bo'lib qolasiz (real o'lchov: " +
    "bir xil rejalashtirish savoliga siz 15.7 soniya sarfladingiz, `ask_expert` esa 3.5 soniyada aniqroq javob " +
    "berdi). Shuning uchun QUYIDAGI hollarda HAR DOIM `ask_expert` chaqiring, o'zingiz javob berishga URINMANG:\n" +
    "  • tahlil, sabab-oqibat (\"nega bunday bo'lyapti\", \"sabab nima\")\n" +
    "  • maslahat (\"nima qilsam\", \"qanday yaxshilayman\", \"nimani o'zgartiray\")\n" +
    "  • taqqoslash (\"qaysi biri afzal\", \"farqi nima\")\n" +
    "  • rejalashtirish, vaqt/tartib hisobi (\"ulguraman-mi\", \"qanday tartibda\")\n" +
    "  • hisob-kitob, mantiqiy masala, ko'p shartli vaziyat\n" +
    "  • biror mavzuni tushuntirish (\"bu nima\", \"qanday ishlaydi\")\n" +
    "O'ZINGIZ javob beradigan holatlar FAQAT shular: salomlashish, qisqa suhbat, hazil, tasdiq (\"xo'p\", \"ha\"), " +
    "va allaqachon bilgan qisqa fakt (soat nechchi — buni fast_action beradi). Ikkilansangiz — `ask_expert` " +
    "chaqiring, bu deyarli har doim to'g'ri qaror. Javob qaytgach uni qayta yozmang, tabiiy ohangda o'qib bering.\n\n" +
    "MUHIM — FUNKSIYA CHAQIRISHDAN OLDIN JIM BO'LING: `see_screen`, `recall_memory`, `fast_action` kabi TEZ " +
    "funksiyalarni chaqirayotganda, oldindan \"hozir qarayman\", \"bir oz eslab ko'ray\", \"hozir izlab ko'raman\", " +
    "\"bir zum\" kabi HECH QANDAY oraliq gap AYTMANG. Bu funksiyalar bir-ikki soniyada tugaydi — oraliq gap esa " +
    "butun boshqa javob navbatini band qilib, foydalanuvchini QO'SHIMCHA 4-5 soniya bekorga kutdiradi va " +
    "sekinroq taassurot qoldiradi. To'g'ri yo'l: jim chaqiring, natija kelgach faqat ASL javobning o'zini " +
    "ayting. Faqat `run_task` (uzoq, bir necha daqiqalik ish) chaqirilganda qisqa ogohlantirish o'rinli.\n\n" +
    "MUHIM — TUSHUNISH ANIQLIGI: og'zaki o'zbek tilida rus va ingliz tillaridan olingan so'zlar juda ko'p " +
    "ishlatiladi (masalan \"kompyuter\", \"telefon\", \"internet\", \"pochta\" yoki hatto alohida rus so'zlari) — " +
    "bu tabiiy holat, XATOLIK EMAS. Bunday so'zlarni eshitganda chalkashib qolmang, gapni boshqa til deb " +
    "hisoblamang va HECH QACHON shu sabab bilan javob tilini o'zgartirmang. Aksent yoki talaffuz sabab biror " +
    "so'z noaniq eshitilsa, gapning umumiy MA'NOSI va KONTEKSTIDAN (oldingi suhbat, joriy vazifa) foydalanib " +
    "eng ehtimoliy to'g'ri ma'noni tanlang — so'zma-so'z, harfma-harf tushunishga urinmang. Foydalanuvchi " +
    "chindan gapirdi-yu, lekin nima deganini tushunolmasangiz (fon shovqini emas, balki tushunarsiz gap) — " +
    "taxmin qilib noto'g'ri amal bajarishdan ko'ra, qisqa qilib qayta so'rang (masalan \"Kechirasiz, aniqroq " +
    "ayting\").\n\n" +
    "MUHIM — OVOZ OHANGINI SEZISH: siz foydalanuvchining xom ovozini (matn emas) eshitasiz — shundan uning kayfiyati, " +
    "shoshilinchligi va charchoqligini his qiling va shunga moslashing: (1) Ovozi tez, keskin yoki xafa bo'lsa — darhol " +
    "eng qisqa, aniq javob bering, hazil/ortiqcha so'z ishlatmang, tezda yordam bering. (2) Charchagan/xotirjam ovozda " +
    "gapirsa — yumshoqroq, ammo baribir chaqqon ohangda javob bering. (3) Xursand/hazil ohangda gapirsa — siz ham biroz erkinroq, " +
    "iliqroq javob berishingiz mumkin. (4) HECH QACHON \"ovozingiz charchagandek eshitilyapti\" kabi buni ochiqchasiga " +
    "aytmang yoki sharh bermang — faqat o'z javobingiz ohangi va uslubi bilan moslashing, sezilmasdan.\n\n" +
    (voiceStyle ? voiceStyle + '\n\n' : '') +
    pronunciationBlock +
    recentContextBlock() +
    profileSummaryBlock() +
    // Eslatma: avval bu yerda soul.slice(0, 1500) edi — SOUL.md 10.3KB,
    // eng muhim XARAKTER/USLUB bo'limi esa faylning OXIRIDA (~10100-belgida)
    // joylashgan bo'lib chiqdi. Natijada u HECH QACHON real ovozli suhbatga
    // yetib bormagan (haqiqiy topilma, real belgi-hisobi bilan tasdiqlangan)
    // — bu "kino JARVIS kabi hissiyot yo'q" shikoyatining asosiy sababi
    // bo'lgan bo'lishi mumkin. To'liq fayl (~2500 token) bemalol context
    // doirasiga sig'adi, shuning uchun kesish olib tashlandi.
    "To'liq shaxsiyat qoidalari:\n" + soul
  );
}

function loadInstructions() {
  return (
    "You are Jarvis, the user's realtime voice assistant. English is the default response language: reply in natural English regardless of the language, accent, isolated foreign words, quoted text, transcription errors, or background audio in the user's speech. Do not automatically switch to Uzbek, Russian, or any other language. An explicit request to translate into a named language, or to speak or respond in a named language, is the only exception; fulfill that requested translation or language conversation, then return to English unless the user explicitly asks to continue in that language. " +
    "Talk like an attentive, capable person: warm, direct, context-aware, and unforced. Never claim to be human. Use natural contractions, varied sentence length, and brief conversational reactions when they fit; avoid canned assistant phrases and robotic repetition. Prefer concise, colloquial spoken wording over formal written prose; say the useful thing first and stop when the answer is complete. " +
    "Match the answer length to the need: keep simple replies short, but give enough detail to fully answer a real question. Do not force every reply into one sentence and never cut a thought short. Start speaking the first useful answer as soon as it is ready; reason silently, do not narrate thinking, and do not delay a simple answer for extra polish. " +
    "Speak at a calm, comfortable pace with natural pauses and expressive but restrained intonation. Do not use a metallic, synthetic, announcer-like, or theatrical delivery. " +
    "Never add unnecessary greetings, preambles, status narration, markdown, or unsolicited suggestions. Do not say 'certainly', 'let me', or 'one moment' before acting. " +
    "ACTION FIRST: when the user asks you to do something and an available tool can do it, call the tool instead of merely explaining how to do it or promising to do it. " +
    "Use fast_action for a supported one-step computer action; use run_task for browser interaction, files, coding, forms, or multi-step work; " +
    "use see_screen for visible screen content, recall_memory for older personal context, and ask_expert for serious analysis. Treat short deictic questions such as 'what is that?', 'what's this?', 'bu nima?', or 'shu nima?' as screen questions whenever a screen could be the referent: call see_screen silently before answering. Describe only what the screen evidence shows; never guess an object from background audio, a transcript fragment, or an unrelated conversation. " +
    "Call fast tools silently and speak only their result. For a long run_task, one brief acknowledgement is acceptable, but never claim success until the tool returns a successful result. If a tool fails or only partially completes the work, say that plainly. " +
    "Independent run_task calls may run in parallel; report each result when it finishes. Preserve confirmation requirements for destructive, external, or sensitive actions. " +
    "MEMORY: treat recent activity and the user profile below as facts you already remember. Use them naturally without mentioning memory files. " +
    "Resolve references such as 'that task' from recent context; if ambiguity could cause a wrong action, ask one concise clarification. " +
    "During the same live session, treat each new utterance as a natural follow-up without requiring the user to say Jarvis again; preserve context and resolve short follow-ups such as 'yana-chi?' or 'what about tomorrow?'. " +
    "Never invent a remembered fact. Adapt subtly to urgency or mood audible in the user's voice without explicitly commenting on emotion." +
    recentContextBlock() + profileSummaryBlock()
  );
}

function prepareSpokenAnswer(answer) {
  return String(answer || '').trim();
}

// Tools har bir ulanishda YANGIDAN quriladi (statik emas) — shunda
// fast-actions ro'yxatiga yangi o'rganilgan yozuvlar qo'shilsa (qarang:
// skills/fast-actions), keyingi suhbat ularni DARHOL ko'radi, daemon'ni
// qayta ishga tushirish shart emas.
function buildTools() {
  let fastActionIds = [];
  let fastActionsDoc = '';
  try {
    const fa = require('../fast-actions');
    const actions = fa.loadActions();
    fastActionIds = actions.map(a => a.id);
    fastActionsDoc = actions.map(a => a.id + ' — ' + a.uz).join('; ');
  } catch (e) {}

  const tools = [{
    type: 'function',
    name: 'run_task',
    description: "Kompyuterda MURAKKAB, ko'p bosqichli amal bajarish kerak bo'lganda (brauzerda kezish/bosish/forma " +
      "to'ldirish, ekranni ko'rib tahlil qilish, fayl/kod bilan ishlash, eslab qolish/eslab olish, vazifalar ro'yxati, " +
      "internetdan qidirish, va h.k.) shuni chaqir. Oddiy, bir qadamlik amal (dastur ochish, sayt ochish, ovoz, " +
      "skrinshot, vaqt/sana/batareya so'rash) uchun BUNI EMAS, `fast_action`ni ishlating — u ANCHA TEZROQ. " +
      "To'liq imkoniyatli yordamchi vazifani MUSTAQIL, fon rejimida bajaradi (boshqa vazifalarni to'xtatmaydi) va tugagach " +
      "natijani matn sifatida qaytaradi. Bir nechta mustaqil vazifa uchun bir nechta marta chaqirishingiz mumkin — ular " +
      "parallel bajariladi.",
    parameters: {
      type: 'object',
      properties: { description: { type: 'string', description: "Bajarilishi kerak bo'lgan aniq vazifa, foydalanuvchi so'zlari bilan" } },
      required: ['description']
    }
  }, {
    type: 'function',
    name: 'note_pronunciation',
    description: "Foydalanuvchi sizni noto'g'ri tushunganingiz uchun to'g'rilasa (masalan \"yo'q, men ... dedim\", " +
      "\"men ... demadim, ... dedim\", yoki shunga o'xshash tuzatish) — DARHOL shuni chaqiring, hech narsa demasdan " +
      "javob qaytarmang (bu foydalanuvchiga eshitilmaydi, faqat xotiraga yoziladi). Shu bilan xuddi shu so'z keyingi " +
      "safar yana adashib eshitilmaydi.",
    parameters: {
      type: 'object',
      properties: {
        misheard: { type: 'string', description: "Siz avval noto'g'ri tushungan/eshitgan so'z yoki ibora" },
        actual: { type: 'string', description: "Foydalanuvchi aslida nima degani (to'g'rilagandan keyin)" }
      },
      required: ['misheard', 'actual']
    }
  }];

  // Jonli suhbatda EKRANNI KO'RISH — rasm to'g'ridan-to'g'ri shu suhbatga
  // qo'shiladi (real endpoint sinovidan o'tkazilgan: gpt-realtime-2.1 rasmni
  // qabul qiladi va aniq tasvirlaydi). Avval buning yagona yo'li `run_task`
  // orqali alohida vision-modelga yuborish edi — 15-20 soniya; bu esa ~1
  // soniya, va model javob berayotgan paytda ekranni "ko'rib turadi".
  tools.push({
    type: 'function',
    name: 'see_screen',
    description: "Ekranda hozir nima borligini KO'RISH kerak bo'lganda shuni chaqiring — rasm to'g'ridan-to'g'ri " +
      "sizga ko'rsatiladi va uni o'zingiz tahlil qilasiz. Qachon: foydalanuvchi \"bu nima\", \"shu xato nima\", " +
      "\"what is that\", \"what's this\", \"ekranimda nima ko'rinyapti\", \"buni o'qib ber\", \"shu yerda nima yozilgan\" kabi KO'RISHGA oid narsa " +
      "so'raganda, yoki uning gapini tushunish uchun ekran konteksti kerak bo'lganda. Bu `run_task`dan ANCHA " +
      "TEZROQ — ekranni ko'rish uchun HECH QACHON run_task ishlatmang, doim shuni ishlating. Eslatma: bu faqat " +
      "KO'RADI, hech narsani bosmaydi/o'zgartirmaydi — ekranda biror amal bajarish kerak bo'lsa `run_task` kerak. " +
      "MUHIM: chaqirishdan oldin \"hozir qarayman\", \"bir zum ko'ray\" kabi HECH NARSA AYTMANG — jim chaqiring va " +
      "rasmni ko'rgach TO'G'RIDAN-TO'G'RI javobning o'zini ayting. Rasm dalilisiz obyekt nomini taxmin qilmang; background audio yoki matn parchasidan xulosa chiqarmang. Bu oraliq gap ortiqcha bir necha soniya " +
      "kechikish qo'shadi va foydalanuvchini bekorga kutdiradi.",
    parameters: { type: 'object', properties: {}, required: [] }
  });

  // BUTUN TARIX bo'yicha ma'no (semantik) izlash. Instructionsdagi
  // "so'nggi faoliyat" bloki faqat oxirgi bir necha soatni qamraydi —
  // u "hozir nima qilayotgan eding" uchun. Bu tool esa vaqt chegarasiz:
  // kecha, bir hafta, bir yil oldin bo'lganini ham topa oladi, va so'zlar
  // aynan mos kelmasa ham ma'noga qarab qidiradi.
  tools.push({
    type: 'function',
    name: 'recall_memory',
    description: "Foydalanuvchi O'TMISHDAGI biror narsaga ishora qilsa — \"o'sha loyiha\", \"avval nima degandik\", " +
      "\"qachondir aytgan edim\", \"o'tgan hafta/oy\", biror nom/mavzu haqida \"eslaysanmi\" — DARHOL shuni chaqiring. " +
      "Butun xotira tarixi bo'ylab (kecha ham, bir yil oldin ham) MA'NO bo'yicha qidiradi, so'zlar aynan mos " +
      "kelmasa ham topadi. Tez ishlaydi (~1 soniya) — ikkilanmasdan ishlating. Taxmin qilib javob berishdan " +
      "ko'ra, shu bilan ANIQ eslab javob bering. So'nggi bir necha soatlik ish uchun bu shart emas — u " +
      "allaqachon yuqoridagi \"so'nggi faoliyat\" ro'yxatida bor. " +
      "MUHIM: chaqirishdan oldin \"hozir eslab ko'ray\", \"bir oz o'ylab ko'ray\" kabi HECH NARSA AYTMANG — " +
      "jim chaqiring va natijani ko'rgach TO'G'RIDAN-TO'G'RI javobning o'zini ayting. Eslab aytganda, qachon " +
      "bo'lganini ham qisqa qo'shing (masalan \"o'tgan seshanba\", \"13-avgustda\") — bu ishonchni oshiradi.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: "Nimani eslash kerakligi — mavzu/nom/savol, foydalanuvchi so'zlari bilan" } },
      required: ['query']
    }
  });

  // JIDDIY SAVOLLARNI KUCHLI MODELGA yo'naltirish. Siz (realtime model)
  // ovoz uchun optimallashtirilgansiz — qisqa suhbatda tez va tabiiysiz,
  // lekin ko'p bosqichli fikrlashda sekin va suvli bo'lib qolasiz.
  // Murakkab reasoning savolini realtime audio modelida qoldirmaymiz: primary
  // Responses API modeli bu turdagi vazifalar uchun aniqroq optimallashtirilgan.
  tools.push({
    type: 'function',
    name: 'ask_expert',
    description: "Foydalanuvchi CHINDAN FIKRLASH talab qiladigan savol bersa — tahlil, maslahat, taqqoslash, " +
      "rejalashtirish, sabab-oqibat, hisob-kitob, \"nima qilsam yaxshi\", \"nega bunday\", \"qaysi biri afzal\" — " +
      "shuni chaqiring. Savolni TO'LIQ, kerakli kontekst bilan birga bering (foydalanuvchi aytgan raqamlar, " +
      "cheklovlar, vaziyat) — chunki ekspert sizning suhbatingizni ko'rmaydi. Javob qaytgach, uni O'Z SO'ZINGIZ " +
      "bilan qayta aytib bermang — deyarli o'zgartirmasdan, tabiiy ohangda o'qib bering. " +
      "Qachon KERAK EMAS: oddiy suhbat, salomlashish, qisqa faktik savol (soat nechchi, ob-havo), " +
      "kompyuterda amal bajarish (buning uchun run_task yoki fast_action). " +
      "MUHIM: chaqirishdan oldin \"o'ylab ko'ray\" kabi hech narsa demang — jim chaqiring.",
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: "To'liq savol + barcha kerakli kontekst (ekspert suhbatni ko'rmaydi)" } },
      required: ['question']
    }
  });

  tools.push({
    type: 'function',
    name: 'cancel_task',
    description: "Foydalanuvchi bajarilayotgan vazifani TO'XTATISHNI so'rasa (\"to'xtat\", \"bekor qil\", \"kerak emas\", " +
      "\"qo'y\", \"shart emas endi\") — darhol shuni chaqiring. Hozir ishlayotgan barcha `run_task` vazifalari to'xtatiladi. " +
      "Hech qanday vazifa ishlamayotgan bo'lsa ham chaqirsa bo'ladi — shunchaki to'xtatadigan narsa yo'qligini qaytaradi.",
    parameters: { type: 'object', properties: {}, required: [] }
  });

  if (fastActionIds.length) {
    tools.push({
      type: 'function',
      name: 'fast_action',
      // Eslatma: avval bu yerda barcha 115 ta action "id — izoh" ko'rinishida
      // sanab chiqilardi, ustiga yana AYNAN o'sha id'lar quyidagi enum'da
      // takrorlanardi — ya'ni ro'yxat ikki marta yuborilib, har javobda
      // bekorga ~1500 token qayta ishlanardi. id'larning o'zi tushunarli
      // ("open:chrome", "volume:up", "info:battery"), shuning uchun enum
      // yetarli; bu yerda faqat qanday turlari borligi qisqa aytiladi.
      description: "TEZ, ODDIY, bir qadamlik amallar uchun — dastur ochish (open:*), sayt ochish (web:*), " +
        "ovoz balandligi (volume:*), tizim amallari (system:*), ekran surati (screenshot:*), " +
        "Music/Spotify boshqarish (media:*), ma'lumot so'rash — vaqt/sana/batareya/Wi-Fi/disk (info:*). " +
        "`run_task`dan ANCHA TEZROQ ishlaydi (to'liq agent ishga tushirilmaydi) — mos action topilsa, " +
        "har doim buni run_task'dan USTUN qo'ying. Aniq ro'yxat quyidagi `id` maydonining enum'ida.",
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', enum: fastActionIds, description: "Bajarilishi kerak bo'lgan action id'si (ro'yxatdan)" } },
        required: ['id']
      }
    });
  }

  return tools;
}

const RUN_TASK_TIMEOUT_MS = OPENCLAW_AGENT_TIMEOUT_MS;

// Har bir chaqiruv o'ziga xos, izolyatsiyalangan session'da ishlaydi — shu
// bilan bir nechta vazifa CHINDAN parallel, bir-birining kontekstini
// buzmasdan bajarilishi mumkin (bitta umumiy session'ni ishlatishsa,
// bir vaqtda ikkita jarayon uni yozsa, bir-birining natijasini
// buzib qo'yishi mumkin edi).
// onProc — ishga tushgan jarayonni chaqiruvchiga qaytaradi, shunda uni
// keyinroq to'xtatish (foydalanuvchi "to'xtat" desa) yoki suhbat tugaganda
// tozalash mumkin bo'ladi.
function runFullAgent(description, sessionKey, onProc, spawnAgent = spawn, onProgress, bridge = VOICE_AGENT_BRIDGE) {
  if (bridge !== VOICE_AGENT_BRIDGE || spawnAgent !== spawn) {
    return new Promise((resolve) => {
      const proc = spawnAgent('openclaw', ['agent', '--session-key', sessionKey, '--message', '[Language policy: Reply only in natural English. Never answer in Uzbek or imitate an Uzbek accent.]\n\n' + description, '--agent', 'main'], { cwd: PROJECT_DIR, env: { ...process.env, AZURE_OPENAI_KEY: env('AZURE_OPENAI_KEY'), JARVIS_PROJECT_DIR: PROJECT_DIR }, timeout: RUN_TASK_TIMEOUT_MS });
      if (typeof onProc === 'function') onProc(proc);
      let out = ''; proc.stdout.on('data', d => out += d);
      proc.on('close', () => resolve(out.trim() || 'Kechirasiz, bajara olmadim.'));
      proc.on('error', () => resolve('Xatolik yuz berdi.'));
    });
  }
  return bridge.askAgent(description, sessionKey, { source: 'voice-run-task', persistent: needsPersistentExecution(description), onProgress, onLongRunning: onProgress });
  /* Legacy spawn lifecycle intentionally retained below for compatibility reference. */
  /* c8 ignore start */
  return new Promise((resolve) => {
    const englishOnly = '[Language policy: Reply only in natural English. Never answer in Uzbek or imitate an Uzbek accent.]\n\n';
    const proc = spawnAgent('openclaw', ['agent', '--session-key', sessionKey, '--message', englishOnly + description, '--agent', 'main'], {
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
      // Foydalanuvchi o'zi to'xtatgan bo'lsa — bu xato emas, ataylab qilingan.
      if (proc._jarvisCancelled) {
        task.status = 'cancelled'; task.finishedAt = new Date().toISOString(); TASK_CHECKPOINTS.save(task);
        resolve('Vazifa to\'xtatildi.'); return;
      }
      // Vaqt chegarasi: jarayon SIGTERM bilan o'ldirilgan. Bu holda yig'ilgan
      // matn CHALA — avval u to'liq natija sifatida qaytarilardi, ya'ni
      // yarim bajarilgan ish "bajarildi" deb ko'rsatilardi.
      if (signal === 'SIGTERM' && proc.killed) {
        task.status = 'partial'; task.finishedAt = new Date().toISOString(); task.result = clean.slice(0, 12000); TASK_CHECKPOINTS.save(task);
        const mins = Math.round(RUN_TASK_TIMEOUT_MS / 60000);
        resolve(clean
          ? 'Vazifa ' + mins + ' daqiqada tugamadi, to\'xtatildi. Shu yergacha bajarildi: ' + clean
          : 'Vazifa ' + mins + ' daqiqada tugamadi va to\'xtatildi — natija olinmadi.');
        return;
      }
      task.status = code === 0 && clean ? 'completed' : 'failed';
      task.finishedAt = new Date().toISOString();
      task.result = clean.slice(0, 12000);
      TASK_CHECKPOINTS.save(task);
      resolve(clean || "Kechirasiz, bajara olmadim.");
    });
    proc.on('error', () => {
      clearTimeout(noticeTimer);
      task.status = 'failed'; task.finishedAt = new Date().toISOString(); task.error = 'OpenClaw spawn failed'; TASK_CHECKPOINTS.save(task);
      resolve("Xatolik yuz berdi.");
    });
  });
  /* c8 ignore stop */
}

// Faqat fikrlash/tahlil uchun kuchli agent. Kompyuterda amal bajarmaydi;
// alohida session ishlatgani uchun jonli suhbat kontekstini ifloslantirmaydi.
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

// Oddiy salomlashish, vaqt yoki bir qadamlik desktop amali Realtime'da tez
// qoladi. O'tmish, loyiha, ekran, sabab/reja/tahlil talab qiladigan savollar
// esa deterministik RAG yo'liga o'tadi — model tool chaqirishni "xohlashi"ga
// bog'liq emas.
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

function needsBackgroundAgentTask(text) {
  const value = String(text || '').trim();
  if (!value || /\?|\b(?:why|how|what|which|should i|advice|explain|nega|qanday|nima|qaysi|maslahat|tushuntir)\b/i.test(value)) return false;
  const action = /\b(?:open|close|click|type|write|create|edit|update|fix|debug|build|test|install|configure|deploy|run|start|launch|search|research|send|upload|download|fill|submit|och|yop|bos|yoz|yarat|tahrir|yangila|tuzat|tekshir|o'rnat|ornat|sozla|ishga tushir|qidir|izla|yubor|yukla|to'ldir|jo'nat|jonat|bajar)\b/i.test(value);
  const work = value.length >= 12 || /\b(?:file|code|project|browser|form|email|report|website|app|fayl|kod|loyiha|brauzer|forma|hisobot|sayt|dastur)\b/i.test(value);
  return action && work;
}

// Eng ko'p ishlatiladigan, xavfsiz va bitta ma'noli desktop buyruqlarni
// Realtime model tool tanlashini kutmasdan bajarish uchun konservativ router.
// Ataylab "yop", "o'chir", fayl yuborish/yozish kabi kontekst yoki zararli
// ta'sir ehtimoli bor amallar bu yerga kiritilmaydi — ular agentda qoladi.
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
    .replace(/\b(jarvis|please|iltimos|marhamat)\b/gi, ' ')
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

  if (/^(?:ovoz|volume)(?:ni)?\s+(?:balandlat|ko'tar|oshir)$/.test(value)) return 'volume:up';
  if (/^(?:ovoz|volume)(?:ni)?\s+(?:pasaytir|kamaytir)$/.test(value)) return 'volume:down';
  if (/^(?:ovoz|volume)(?:ni)?\s+(?:o'chir|ochir|mute)$/.test(value)) return 'volume:mute';
  if (/^(?:ovoz|volume)(?:ni)?\s+(?:yoq|qaytar|unmute)$/.test(value)) return 'volume:unmute';

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
  return null;
}

async function collectGrounding(query, options = {}) {
  const blocks = [];
  try {
    const screen = require('../screen-monitor').loadState();
    if (screen.lastSummary) {
      const ageMinutes = screen.lastTrigger ? Math.max(0, Math.round((Date.now() - screen.lastTrigger) / 60000)) : null;
      blocks.push('ENG SO\'NGGI EKRAN KUZATUVI' + (ageMinutes === null ? '' : ' (' + ageMinutes + ' daqiqa oldin)') + ':\n' +
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
      if (profile) memoryBlocks.push('FOYDALANUVCHI PROFILI:\n' + profile.replace(/\s+/g, ' ').slice(0, 2400));
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
      if (found.length) memoryBlocks.push('LOKAL QIDIRUVDAN MOS YOZUVLAR:\n' + found.map(item => {
        if (item.matches) return '[' + (item.date || item.file) + '] ' + item.matches.map(match => match.text).join(' | ');
        return '[' + (item.layer || 'xotira') + '] ' + (item.title || '') + ': ' + String(item.content || '').slice(0, 650);
      }).join('\n---\n'));
    } catch (e) {}
  }
  blocks.push('OBSIDIAN XOTIRASI HOLATI:\n' + (memoryBlocks.length
    ? 'Qidiruv muvaffaqiyatli bajarildi. Quyidagi yozuvlardan foydalaning:\n' + memoryBlocks.join('\n\n')
    : 'Qidiruv bajarildi, lekin savolga mos yozuv topilmadi. Xotira ishlamadi demang; mos yozuv topilmaganini ayting.'));
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
    this._firstTextObserved = false;
    this._firstAudioObserved = false;
    this._playbackStartedForTurn = false;
    this._pendingFnArgs = {};
    this.provider = null;
    this._providerIndex = -1;
    this._connecting = false;
    this._mediaModeActive = false;
    // Fn hands-free suhbatining o'zi foydalanuvchining aynan Jarvisga
    // murojaatini butun sessiya uchun tasdiqlaydi. Media ijro etilayotgan
    // bo'lsa ham follow-up turnlarga til-marker talab qilmaymiz; echo/noise/ack
    // filtrlari esa hamon qo'llanadi. Wake-word trigger esa avvalgidek faqat
    // birinchi mazmunli turn uchun bir martalik bypass oladi.
    this._explicitUserSession = Boolean(options.explicitUserSession);
    this._explicitUserTurnPending = Boolean(options.explicitUserTrigger);
    this._addressedWakePending = Boolean(options.addressedWakeTrigger);
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
    this._fastActionRunner = typeof options.fastActionRunner === 'function'
      ? options.fastActionRunner : require('../fast-actions').runFastAction;
    this._communicationRunner = typeof options.communicationRunner === 'function'
      ? options.communicationRunner
      : intent => require('../communications').searchYouTube(intent.query);
    this._memoryProvider = options.memoryProvider || require('../memory');
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
      : (description, sessionKey, onProgress) => VOICE_AGENT_BRIDGE.askAgent(description, sessionKey, {
        source: 'voice-background-agent', persistent: true, onProgress, onLongRunning: onProgress
      });
    this._realtimeResponseActive = false;
    this._recentConversation = [];
    // Hozir ishlayotgan run_task jarayonlari (call_id -> {proc, description}).
    // Ikki narsa uchun kerak: (1) foydalanuvchi "to'xtat" desa o'chirish,
    // (2) suhbat tugaganda qolib ketgan jarayonlarni tozalash — avval ular
    // suhbat yopilgandan keyin ham fonda ishlashda davom etardi.
    this._runningTasks = new Map();
    this.duplex = new DuplexVoiceEngine({
      sampleRate: OUT_RATE, echoThreshold: DUPLEX_ECHO_THRESHOLD,
      bargeInResidual: DUPLEX_BARGE_IN_RMS, noiseFloor: DUPLEX_NOISE_FLOOR,
      noiseMultiplier: DUPLEX_NOISE_MULTIPLIER, hangoverMs: NORMAL_DUPLEX_HANGOVER_MS,
      maxEchoLagMs: DUPLEX_MAX_ECHO_LAG_MS,
      maxGain: REALTIME_INPUT_GAIN
    });
  }

  // Ishlayotgan vazifalarni to'xtatadi. Nechtasi to'xtatilganini qaytaradi.
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
      this.emit('error', new Error('AZURE_VOICELIVE_* yoki AZURE_REALTIME_* provider sozlanmagan'));
      return;
    }
    this._startPlayback();
    this._connectProvider(0);
  }

  _connectProvider(index) {
    const provider = VOICE_PROVIDERS[index];
    if (!provider || this.closed) {
      this._connecting = false;
      this.emit('error', new Error('Barcha realtime voice providerlari ishlamadi'));
      return;
    }
    this._providerIndex = index;
    this.provider = provider;
    this._connecting = true;
    const socket = new WebSocketClient(provider.url, { headers: provider.headers, handshakeTimeout: 10000 });
    this.ws = socket;

    // Oldingi (endi tugagan) suhbatda video/musiqa ishga tushirilgan bo'lsa
    // va hali eskirmagan bo'lsa, YANGI suhbat ham boshidanoq yuqori
    // chegara bilan boshlanadi — pastki izohga qarang (MEDIA_STATE_FILE).
    const startMediaAware = this._mediaModeActive;
    isMediaRecentlyLikelyPlaying().then(playing => {
      if (playing === true && !this.closed) this._setMediaLikelyPlaying();
    }).catch(() => {});
    // Fayl holati eskirishi yoki foydalanuvchi videoni o'zi ochishi mumkin.
    // Tizim signalini parallel tekshiramiz; ulanishni kutdirib qo'ymaymiz.
    checkSystemAudioPlaying().then(playing => {
      if (playing === true && !this.closed) this._setMediaLikelyPlaying();
    }).catch(() => {});

    this.ws.addEventListener('open', () => {
      this._connecting = false;
      this.ws.send(JSON.stringify(buildSessionUpdate(provider, {
        startMediaAware: this._mediaModeActive,
        instructions: loadInstructions(),
        tools: buildTools()
      })));
    });

    this.ws.addEventListener('message', (ev) => this._onMessage(ev));
    this.ws.addEventListener('error', (ev) => {
      if (this.ws !== socket) return;
      // Node'ning ErrorEvent'ida .message/.error xususiyatlari ko'pincha
      // enumerable emas — JSON.stringify(ev) shunchaki "{}" berardi, hech
      // narsa ko'rsatmasdan. Xususiyatlarga to'g'ridan-to'g'ri murojaat
      // qilamiz.
      const reason = ev?.error?.message || ev?.message || ev?.error?.code || ev?.type || 'noma\'lum (ws close race bo\'lishi mumkin)';
      if (!this.ready && index + 1 < VOICE_PROVIDERS.length) {
        this.emit('telemetry', 'provider.fallback', { from: provider.id, to: VOICE_PROVIDERS[index + 1].id, reason });
        try { this.ws.close(); } catch (_) {}
        this._connectProvider(index + 1);
        return;
      }
      this.emit('error', new Error(provider.id + ' WebSocket xatolik: ' + reason));
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
        // Serverga avtomatik interrupt qilishga ruxsat berilmaydi: xona aks-
        // sadosi server VAD'dan o'tib qolsa, tayyor javob o'rtasida kesilmasin.
        // Faqat lokal duplex gate yaqinda yetarlicha kuchli, echo'dan qolgan
        // residual emas deb tasdiqlagan audio bo'lsa qo'lda barge-in qilamiz.
        const confirmedBargeIn = this.assistantSpeaking &&
          Date.now() - this._bargeInEvidenceAt <= 1200;
        if (confirmedBargeIn && !this._responseInterrupted) {
          this._responseInterrupted = true;
          try { this.ws.send(JSON.stringify({ type: 'response.cancel' })); } catch (e) {}
          this._flushPlayback();
          this.emit('telemetry', 'barge_in.confirmed', {});
        } else if (confirmedBargeIn) {
          // Lokal duplex gate playback'ni allaqachon kesgan. Provider VAD
          // lifecycle eventini qabul qilamiz, ammo response.cancel/flush'ni
          // takrorlab yangi playback jarayoni bilan poyga yaratmaymiz.
          this.emit('telemetry', 'barge_in.provider_acknowledged', {});
        } else if (this.assistantSpeaking) {
          this.emit('telemetry', 'barge_in.ignored', { reason: 'no-local-speech-evidence' });
        }
        if (this._authoritativeTranscribe) {
          this._sttTurn = { chunks: this._sttPreRoll.splice(0), bytes: this._sttPreRollBytes };
          this._sttPreRollBytes = 0;
        }
        this.emit('user_speaking');
        this.emit('telemetry', 'vad.speech_started', {});
        break;
      case 'input_audio_buffer.speech_stopped':
        this.emit('telemetry', 'vad.speech_stopped', {});
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
          // Native transkript o'zi YETARLICHA aniq bo'lsa yoki konservativ
          // local fast-action matcher uni bitta ma'noli buyruq deb topsa,
          // authoritative Azure STT tugashini kutmasdan darhol boshlaymiz.
          // Ikkinchi shart "Safari och"/"soat nechchi" kabi tabiiy 2-token
          // o'zbekcha buyruqlarga mo'ljallangan: erkin qisqa gaplar undan
          // o'tmaydi va avvalgidek uz-UZ STT'ni kutadi.
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
          this._acceptTranscript(msg.transcript || '');
        }
        break;
      }
      case 'response.created':
        this._responseInterrupted = false;
        this._realtimeResponseActive = true;
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
        if (!this._firstAudioObserved) {
          this._firstAudioObserved = true;
          this.emit('telemetry', 'assistant.audio.first', {});
        }
        this.assistantSpeaking = true;
        this._playChunk(Buffer.from(msg.delta, 'base64'));
        break;
      case 'response.function_call_arguments.delta':
        this._pendingFnArgs[msg.call_id] = (this._pendingFnArgs[msg.call_id] || '') + (msg.delta || '');
        break;
      case 'response.function_call_arguments.done':
        // Ayrim Realtime versiyalarida `done` eventida to'liq arguments
        // kelmaydi, faqat oldingi delta'lar keladi. Yig'ilgan nusxani
        // fallback sifatida biriktirmasak tool bo'sh parametr bilan ishlaydi.
        if (!msg.arguments && this._pendingFnArgs[msg.call_id]) {
          msg.arguments = this._pendingFnArgs[msg.call_id];
        }
        delete this._pendingFnArgs[msg.call_id];
        this._handleFunctionCall(msg);
        break;
      case 'response.done': {
        const responseStatus = msg.response?.status || 'unknown';
        const responseReason = msg.response?.status_details?.reason || '';
        const interrupted = this._responseInterrupted === true;
        // Qisqa javob prebuffer chegarasiga yetmagan bo'lsa, server oqimni
        // tugatishi bilan qolgan PCM'ni darhol karnayga chiqaramiz.
        this.playbackBuffer?.finish();
        // Keyingi response ham o'zining jitter zaxirasini yangidan yig'ishi
        // kerak. Bu sox ichiga allaqachon yozilgan joriy audioga tegmaydi.
        this.playbackBuffer?.reset();
        this.assistantSpeaking = false;
        this._resetBargeInCandidate();
        // response.done server yuborishni tugatganini anglatadi, karnay esa
        // navbatdagi PCM'ni hali ijro etayotgan bo'lishi mumkin. feedAudio()
        // _playbackUntil'ni ham tekshiradi; shu sabab Jarvis o'z ovozining
        // qolgan qismini foydalanuvchi deb qayta eshitmaydi.
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
        if (!this._suppressCurrentResponse && this.assistantTranscript.trim()) {
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
        // Barge-in paytida cancelled response.done yangi speech turni ochib
        // bo'lgandan keyin kelishi mumkin. Statussiz event daemon'da o'sha
        // yangi turnni yolg'on completed qilib qo'yar edi.
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
        // Bular haqiqiy xatolik emas — javob aynan tugab qolgan payt bekor
        // qilishga urinish yoki ikkita response bir vaqtda so'ralishi kabi
        // tabiiy poyga holatlari (Realtime API'ning o'zi shunday ishlaydi).
        // Konsolni chalg'itmasdan jim o'tkazib yuboriladi.
        const benign = /no active response found|already has an active response in progress/i.test(errMsg);
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
        this.emit('turn_suppressed', 'wake-only', text);
        return false;
      }
    }
    const confirmation = this._actionSafety.handleUtterance(this.userTranscript);
    if (confirmation.matched) {
      const pending = this._pendingConfirmedAction;
      this._pendingConfirmedAction = null;
      this.emit('user_transcript', this.userTranscript);
      this._rememberConversationTurn('User', this.userTranscript);
      this.emit('telemetry', confirmation.confirmed ? 'safety.confirmed' : 'safety.rejected', {});
      if (confirmation.confirmed && pending) pending();
      else this._deliverSpokenAnswer('Cancelled.');
      return true;
    }
    const policy = classifyUserTurn(this.userTranscript, {
      lastAssistant: this._lastAssistantTranscript,
      mediaMode: this._mediaModeActive,
      explicitUserTrigger: this._explicitUserSession || this._explicitUserTurnPending,
      conversationActive: this._conversationContext.isActive()
    });
    if (!policy.accept) {
      this.emit('turn_suppressed', policy.reason, this.userTranscript);
      try { this.ws.send(JSON.stringify({ type: 'response.cancel' })); } catch (e) {}
      this._flushPlayback();
      this.userTranscript = '';
      return false;
    }

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
    // Har qanday yangi qabul qilingan turn avvalgi, hali fonda tayyorlanayotgan
    // grounded javobni eskirtiradi. Aks holda foydalanuvchi boshqa buyruqqa
    // o'tib bo'lgach eski savol javobi kutilmaganda gapirib yuborishi mumkin.
    const turnSerial = ++this._groundedTurnSerial;
    const communicationIntent = require('../communications').parseCommunicationIntent(this.userTranscript);
    if (communicationIntent?.kind === 'youtube-search') {
      this.emit('telemetry', 'router.decision', { route: 'direct-communication', action: communicationIntent.kind });
      this._runCommunicationIntent(communicationIntent);
      return true;
    }
    const directAction = matchDirectFastAction(this.userTranscript);
    if (directAction) {
      this.emit('telemetry', 'router.decision', { route: 'direct-fast-action', action: directAction });
      this._runDirectFastAction(directAction);
      return true;
    }
    if (needsBackgroundAgentTask(this.userTranscript)) {
      const authorization = this._actionSafety.authorize({ kind: 'task', description: this.userTranscript });
      if (!authorization.allowed) {
        this._pendingConfirmedAction = () => this._startBackgroundAgentTask(this.userTranscript);
        this.emit('telemetry', 'safety.confirmation_required', { risk: authorization.assessment.risk, kind: 'task' });
        this._deliverSpokenAnswer('This action may have an external, destructive, or permission-changing effect. Say confirm to proceed, or cancel.');
        return true;
      }
      this.emit('telemetry', 'router.decision', { route: 'realtime-with-background-agent' });
      this._respondWithRealtimeBackgroundTask();
      this._startBackgroundAgentTask(this.userTranscript, authorization.assessment);
      return true;
    }
    const reference = this._conversationContext.resolve(this.userTranscript);
    // Live voice must never wait for memory/reasoning. Realtime answers the
    // user immediately; a grounded worker verifies the context in parallel
    // and can provide a follow-up after the current spoken turn is complete.
    if (needsContextGrounding(this.userTranscript) || reference.resolved) {
      this.emit('telemetry', 'router.decision', { route: 'realtime-with-background-grounding' });
      this._respondWithRealtimeConversation();
      this._startBackgroundGrounding(this.userTranscript, turnSerial);
      return true;
    }
    // Keep conversation and tool selection inside the same Realtime session.
    // This preserves run_task for complex computer work without another model
    // or TTS round-trip; deterministic fast actions/Astra routes run above.
    this.emit('telemetry', 'router.decision', { route: 'realtime-conversation' });
    this._respondWithRealtimeConversation();
    return true;
  }

  _respondWithRealtimeConversation() {
    return this._sendResponseCreate({
      max_output_tokens: REALTIME_MAX_RESPONSE_TOKENS,
      tool_choice: 'auto',
      instructions: "Respond to the user's latest turn in natural English by default. Do not switch languages because of the user's language, accent, isolated foreign words, quoted text, transcription errors, or background audio. Translate into or speak in another language only when the user explicitly requested that named language; otherwise answer in English. Sound warm, attentive, and unforced, with natural wording and varied sentence length. Use complete sentences, always finish the thought, and never cut a sentence short; be concise for simple turns, but include enough detail when the question needs it. If the user requested an action, use the appropriate available tool instead of only describing or promising the action, and never claim completion before a successful tool result. Never invent missing facts, and do not use markdown.",
    });
  }

  _respondWithRealtimeBackgroundTask() {
    return this._sendResponseCreate({
      max_output_tokens: REALTIME_FAST_ACTION_MAX_RESPONSE_TOKENS,
      tool_choice: 'none',
      instructions: "Briefly acknowledge that the requested task has started in the background. Do not call tools, do not claim it is complete, and do not add advice or a long explanation. Speak natural English by default unless the user explicitly requested another named language."
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
        const output = String(result || "I couldn't complete that task.").trim();
        if (assessment) await this._auditHighRiskCompletion(assessment, { source: 'voice-background-agent', requestId: callId });
        this.emit('tool_result', output, callId);
        this.emit('telemetry', 'background_agent.completed', { callId, ok: !/^(?:error|failed|i couldn't)/i.test(output) });
        this._backgroundTaskResults.push({ answer: output.slice(0, 7000) });
        this._deliverReadyBackgroundWork();
      })
      .catch(error => {
        const output = 'Error: ' + String(error?.message || error || 'background task failed').slice(0, 500);
        this.emit('tool_result', output, callId);
        this.emit('telemetry', 'background_agent.failed', { callId });
        this._backgroundTaskResults.push({ answer: output });
        this._deliverReadyBackgroundWork();
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
      this._backgroundResearch = { serial, question, answer: answer.slice(0, 7000) };
      this.emit('context_hydration_done', { question, groundingBytes: grounding.length, answer });
      this.emit('telemetry', 'grounding.completed', { durationMs: Date.now() - startedAt, groundingBytes: grounding.length, background: true });
      this._deliverReadyBackgroundResearch();
    }).catch(() => {});
  }

  async _deliverReadyBackgroundResearch() {
    const work = this._backgroundResearch;
    if (!work || this.closed || work.serial !== this._groundedTurnSerial || this._realtimeResponseActive || this.assistantSpeaking) return;
    this._backgroundResearch = null;
    this.emit('telemetry', 'grounding.follow_up.delivered', {});
    await this._deliverSpokenAnswer(work.answer);
  }

  async _deliverReadyBackgroundWork() {
    if (this.closed || this._realtimeResponseActive || this.assistantSpeaking || !this._backgroundTaskResults.length) return;
    const work = this._backgroundTaskResults.shift();
    await this._deliverSpokenAnswer(work.answer);
    this._deliverReadyBackgroundWork();
  }

  _sendResponseCreate(response) {
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
      await this._deliverSpokenAnswer('This action may have an external or destructive effect. Say confirm to proceed, or cancel.');
      return;
    }
    const callId = 'direct-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    this.emit('tool_call', 'fast_action: ' + id, callId);
    if (/^media:/.test(id)) this._setMediaLikelyPlaying();
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
    // TTS ishlamasa tayyor matnni Realtime'ga faqat o'qitish uchun beramiz;
    // u savolga javob bermaydi va mazmunni qayta ishlab chiqmaydi.
    return this._sendResponseCreate({
      max_output_tokens: options.maxOutputTokens || REALTIME_MAX_RESPONSE_TOKENS,
      tool_choice: 'none',
      instructions: "Read the following prepared answer exactly as written, preserving its language. Use a warm, natural conversational voice with a calm pace, natural pauses, and varied cadence. Do not sound metallic, synthetic, theatrical, or like an announcer. Add, remove, and rewrite nothing. Do not translate it:\n\n" + text
    });
  }

  _beginAuthoritativeTranscription(turn) {
    // Oldingi turn favqulodda holatda tugamay qolgan bo'lsa, yangi turn uni
    // almashtiradi; timeout stale callback'ni javob yaratishdan saqlaydi.
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
      // Agar native-fast-path bu turnni allaqachon yakunlagan bo'lsa
      // (pending.settled=true), javobga endi ta'sir qilmaymiz -- lekin
      // authoritative natijani baribir telemetriyaga yozamiz (kelajakda
      // fast-path qarorini tekshirish/tuzatish uchun foydali material).
      // Butunlay BOSHQA (keyingi) turn boshlangan bo'lsa (na settled, na
      // hozirgi pending) -- bu haqiqiy eskirgan chaqiruv, e'tibor bermaymiz.
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

  // Bu funksiya har bir chaqiruv uchun MUSTAQIL ravishda (kutmasdan) chaqiriladi
  // (qarang: _onMessage'dagi 'response.function_call_arguments.done' — await
  // qilinmaydi), shuning uchun bir nechta task chindan parallel ishlaydi.
  // Har biriga o'ziga xos session_key berilishi — ular bir-birining
  // kontekstini buzmasligini kafolatlaydi.
  async _handleFunctionCall(msg) {
    if (msg.name === 'note_pronunciation') { this._handleNotePronunciation(msg); return; }
    if (msg.name === 'fast_action') { this._handleFastAction(msg); return; }
    if (msg.name === 'see_screen') { this._handleSeeScreen(msg); return; }
    if (msg.name === 'cancel_task') { this._handleCancelTask(msg); return; }
    if (msg.name === 'recall_memory') { this._handleRecallMemory(msg); return; }
    if (msg.name === 'ask_expert') { this._handleAskExpert(msg); return; }
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

    // MUHIM: media-tekshiruvi vazifa TUGAGANDAN keyin emas, DARHOL (hali
    // bajarilayotganda) qo'llaniladi — chunki video ko'pincha vazifaning
    // o'zi tugashidan OLDIN, uning ICHIDA (masalan play tugmasi bosilgan
    // zahoti) ijro bo'la boshlaydi. Kech qo'llansa, video allaqachon bir
    // necha soniya ijro bo'lib, noto'g'ri "gapirish" sifatida qabul
    // qilinib ulgurgan bo'lardi (real holatlarda kuzatildi).
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
      : "Savol matni kelmadi.";
    this.emit('tool_result', output.slice(0, 300), msg.call_id);
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output: output.slice(0, 5000) }
      }));
      this._sendResponseCreate();
    } catch (e) {}
  }

  // Butun xotira tarixi bo'ylab ma'no qidiruvi. Indeks fonda (daemon
  // tomonidan) yangilab turilgani uchun bu yerda faqat o'qish bo'ladi —
  // ~1 soniya. run_task orqali qilinsa 15-25 soniya ketardi.
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
        output = 'Bu haqda xotirada hech narsa topilmadi.';
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

  // Foydalanuvchi "to'xtat" deganda — ishlayotgan run_task jarayonlarini
  // darhol o'ldiradi. Avval boshlangan vazifani to'xtatishning umuman
  // iloji yo'q edi: u tugaguncha (3 daqiqagacha) kutish kerak edi.
  _handleCancelTask(msg) {
    this.emit('tool_call', 'cancel_task: running tasks', msg.call_id);
    const n = this.cancelRunningTasks();
    const output = n > 0 ? ('To\'xtatildi (' + n + ' ta vazifa).') : 'Hozir bajarilayotgan vazifa yo\'q edi.';
    this.emit('tool_result', output, msg.call_id);
    try {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output }
      }));
      this._sendResponseCreate();
    } catch (e) {}
  }

  // run_task'dan farqli — bu og'ir sub-agent'ni ishga tushirmaydi, faqat
  // faylga tez yozadi (xotira, LLM chaqiruvi shart emas), shuning uchun
  // to'g'ridan-to'g'ri (await'siz) va sinxron tarzda bajariladi.
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
      // response.create atayin CHAQIRILMAYDI — bu foydalanuvchiga aytiladigan
      // gap emas, faqat ichki xotira yozuvi (tool description'da ham shu
      // aniq aytilgan: "hech narsa demasdan javob qaytarmang").
    } catch (e) {}
  }

  // run_task'ga qaraganda ANCHA tez — to'liq agent (LLM fikrlash zanjiri)
  // ishga tushirilmaydi, to'g'ridan-to'g'ri tizim buyrug'i bajariladi
  // (qarang: skills/fast-actions). "tool_call"/"tool_result" hodisalari
  // atayin run_task bilan BIR XIL nomda emitted qilinadi — shu bilan
  // jarvis_daemon.js'dagi mavjud rtTaskStarted/rtTaskCompleted kuzatuvi
  // (dashboard "JONLI VAZIFALAR" paneli) buni ham avtomatik ko'rsatadi,
  // qo'shimcha ulash shart emas.
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
    // Musiqa/video ijro qiluvchi action'lar ham mikrofonga "sizib kirish"
    // xavfini tug'diradi — run_task'dagi bilan bir xil himoya.
    if (/^media:/.test(id)) this._setMediaLikelyPlaying();
    let result;
    // Ilgari bu yer to'g'ridan-to'g'ri modulni chaqirardi, deterministik
    // router (_runDirectFastAction) ishlatadigan inject qilinadigan
    // this._fastActionRunner seamini chetlab o'tib -- ikkala yo'l endi bir
    // xil (himoyalangan) seamdan o'tadi.
    try { result = await this._fastActionRunner(id); }
    catch (e) { result = { status: 'error', message: e.message }; }
    const output = (result.status === 'ok' ? result.message : ('Xatolik: ' + result.message)) || 'Bajarildi.';
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

  // Ekranni suratga olib, rasmni SHU suhbatga qo'shadi — model uni
  // o'zi ko'radi (alohida vision-model chaqiruvi ham, run_task ham
  // kerak emas). Rasm 900px gacha kichraytiriladi: token narxi va
  // yuborish vaqti ancha kamayadi, matn esa hali o'qish uchun yetarli.
  async _handleSeeScreen(msg) {
    this.emit('tool_call', 'see_screen: ekranga qaraldi', msg.call_id);
    const tmpRaw = path.join('/tmp', 'jarvis-rt-see-' + Date.now() + '.png');
    const tmpSmall = tmpRaw.replace('.png', '-s.png');
    let b64 = null, errMsg = null;
    try {
      await execFileAsync('screencapture', ['-x', tmpRaw], { timeout: 8000 });
      try { await execFileAsync('sips', ['-Z', '900', tmpRaw, '--out', tmpSmall], { timeout: 8000 }); }
      catch (e) { /* sips ishlamasa, asl o'lchamdagi rasm ishlatiladi */ }
      const useFile = await fs.promises.access(tmpSmall).then(() => tmpSmall).catch(() => tmpRaw);
      b64 = (await fs.promises.readFile(useFile)).toString('base64');
    } catch (e) {
      errMsg = 'Ekranni suratga ololmadim: ' + (e.message || '').slice(0, 150);
    }
    await Promise.all([tmpRaw, tmpSmall].map(file => fs.promises.unlink(file).catch(() => {})));

    try {
      // Avval funksiya natijasi (protokol talabi), keyin rasmning o'zi
      // alohida element sifatida qo'shiladi — function_call_output faqat
      // matn qabul qiladi, rasm esa 'user' rolli xabar ichida yuboriladi.
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: msg.call_id, output: errMsg || 'Ekran surati qo\'shildi.' }
      }));
      if (b64) {
        this.ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message', role: 'user',
            content: [
              { type: 'input_image', image_url: 'data:image/png;base64,' + b64 },
              { type: 'input_text', text: '(Foydalanuvchining hozirgi ekrani — savoliga shu asosda javob bering.)' }
            ]
          }
        }));
      }
      this._sendResponseCreate();
    } catch (e) {}
    this.emit('tool_result', errMsg || 'Ekran ko\'rildi', msg.call_id);
  }

  _setMediaLikelyPlaying() {
    saveMediaState(); // keyingi (yangi) suhbatlar ham buni bilishi uchun — connect() dagi izohga qarang
    if (this._mediaModeActive) return;
    this._mediaModeActive = true;
    // Media fonida local gate ham server VAD bilan bir xil konservativ
    // trailing-silence oynaga o'tishi shart; aks holda video shovqini turnni
    // noto'g'ri yopishi yoki keyingi audio lifecycle'ni buzishi mumkin.
    this.duplex.hangoverMs = MEDIA_DUPLEX_HANGOVER_MS;
    try {
      // 0.92 real mikrofon darajasida foydalanuvchini ham deyarli kar qilib
      // qo'ydi. Media paytida uzunroq tasdiq oynasi va echo-mute bilan birga
      // o'rtacha threshold ishlatiladi; qiymat .env orqali sozlanadi.
      this.ws.send(JSON.stringify({
        type: 'session.update',
        session: { turn_detection: { type: 'server_vad', threshold: MEDIA_VAD_THRESHOLD, silence_duration_ms: MEDIA_VAD_SILENCE_MS, prefix_padding_ms: 300, create_response: false, interrupt_response: false } }
      }));
    } catch (e) {}
  }

  // Suhbat davomida foydalanuvchi haqiqatan gapirganda (transkript kelganda)
  // — bu media rejimi kerak bo'lmasligi mumkinligini bildiradi, lekin xato
  // bilan qayta pasaytirib false-negative qilib qo'ymaslik uchun shu
  // holatni qayta oddiy sezgirlikka QAYTARMAYMIZ (mediyaning o'zi
  // to'xtatilmagan bo'lishi mumkin) — session tugaguncha shu darajada qoladi.

  // Mikrofondan kelgan xom 16kHz PCM chunk'ni oqimga qo'shadi. Realtime va
  // Azure TTS playback'ining ikkalasi ham karnayga yuborilgan 24kHz PCM'ni
  // duplex engine'ga reference sifatida beradi; shu sabab playback vaqtida
  // mikrofonni qattiq mute qilmay, haqiqiy barge-in'ni saqlaymiz.
  // Playback tugagach qisqa grace qoladi: xona reverberatsiyasi reference
  // tugaganidan keyin ham mikrofonda eshitilishi mumkin. Playback davomida esa
  // AEC echo'ni kesadi va yetarli residual bo'lsa barge-in'ni o'tkazadi.
  feedAudio(pcm16_16k) {
    if (!this.ready || this.closed) return;
    const now = Date.now();
    const muteUntil = Math.max(this._playbackUntil, this._speakEndedAt) + MIC_MUTE_GRACE_MS;
    const resampled = resample16to24(pcm16_16k);
    const inAcousticGrace = !this.assistantSpeaking && now < muteUntil;
    const processed = this.duplex.process(resampled, { assistantSpeaking: this.assistantSpeaking });
    // Gapirish vaqtida moslashtirilgan AEC barge-in'ni saqlaydi. Gap tugagach
    // grace oynasida esa reference tugab qolgan bo'lishi mumkin; shu davrda
    // qolgan xona aks-sadosini serverga umuman yubormaymiz.
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
    if (this.assistantSpeaking) {
      const chunkMs = pcm16_16k.length / (IN_RATE * 2) * 1000;
      if (!processed.send || processed.reason !== 'barge-in') {
        if (!this._bargeInConfirmed && this._bargeInCandidateMs > 0) {
          this._bargeInGapMs += chunkMs;
          if (this._bargeInGapMs > BARGE_IN_MAX_GAP_MS) this._resetBargeInCandidate();
        }
        return;
      }

      if (!this._bargeInConfirmed) {
        this._bargeInGapMs = 0;
        this._bargeInCandidate.push(Buffer.from(processed.audio));
        this._bargeInCandidateMs += chunkMs;
        if (this._bargeInCandidateMs < BARGE_IN_CONFIRM_MS) return;

        const candidate = Buffer.concat(this._bargeInCandidate);
        this._bargeInCandidate = [];
        this._bargeInCandidateMs = 0;
        // Provider VAD'ni kutish sezilarli kechikish beradi. Mahalliy AEC gate
        // nutqni tasdiqlashi bilan karnayni to'xtatamiz; server event keyinroq
        // faqat turn lifecycle'ni davom ettiradi. _flushPlayback candidate
        // state'ni reset qilgani uchun confirmed/evidence undan KEYIN yoziladi.
        this._responseInterrupted = true;
        try { this.ws.send(JSON.stringify({ type: 'response.cancel' })); } catch (e) {}
        this._flushPlayback();
        this._bargeInConfirmed = true;
        this._bargeInEvidenceAt = now;
        this.emit('telemetry', 'barge_in.confirmed', {
          confirmationMs: BARGE_IN_CONFIRM_MS,
          source: 'local-duplex'
        });
        this._sendInputAudio(candidate);
        return;
      }
      this._bargeInEvidenceAt = now;
    }
    if (!processed.send) return;
    // Server transkripti kechiksa ham daemon sessiyani tirik tutishi uchun
    // faqat echo/noise filtridan o'tgan haqiqiy audio activity yuboriladi.
    this.emit('audio_activity', {
      reason: processed.reason,
      residualRms: processed.residualRms,
      correlation: processed.correlation,
      estimatedNoiseRms: processed.estimatedNoiseRms,
      speechThresholdRms: processed.speechThresholdRms
    });
    this._sendInputAudio(processed.audio);
  }

  _sendInputAudio(audio) {
    if (!audio?.length) return false;
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
    // stdin EPIPE (masalan pleer jarayoni kutilmaganda o'lsa) qo'lga
    // olinmasa butun daemon'ni yiqitadi — shu yerda "yutib" qo'yiladi.
    this.playProc.stdin.on('error', () => {});
  }

  _playChunk(buf) {
    if (this.playProc && this.playProc.stdin.writable) {
      this.playbackBuffer.push(buf);
    }
  }

  _writePlayback(buf) {
    if (!buf?.length || !this.playProc?.stdin?.writable) return false;
    // Deadline audio real ravishda sox'ga berilgan paytdan hisoblanadi;
    // prebufferda kutgan vaqtni playback davomiyligi deb xato sanamaymiz.
    const now = Date.now();
    const durationMs = Math.ceil((buf.length / (OUT_RATE * 2)) * 1000);
    this._playbackUntil = Math.max(now, this._playbackUntil) + durationMs;
    this._lastAudioQueuedAt = now;
    this.duplex.queuePlayback(buf);
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
    this.cancelRunningTasks();
    this._stopPlayback();
    try { this.ws && this.ws.close(); } catch (e) {}
  }
}

module.exports = {
  RealtimeSession, resample16to24, needsGroundedAnswer, needsContextGrounding,
  needsExpertAnswer, needsBackgroundAgentTask, collectGrounding, matchDirectFastAction, prepareSpokenAnswer,
  buildSessionUpdate, loadInstructions, runFullAgent
};
