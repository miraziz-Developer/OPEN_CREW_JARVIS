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
const https = require('https');
const net = require('net');

const PROJECT_DIR = '/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS';
process.chdir(PROJECT_DIR);

const { writeMemory, searchMemory } = require('./skills/memory');

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

// ── Config ──────────────────────────────────────────────
const SAMPLE_RATE = 16000;
const CHUNK_MS = 1200;             // overlap window (ms) — "Jarvis" to'liq sig'ish uchun
const STEP_MS = 200;               // new chunk every (ms)
const ENERGY_MIN_STT = 400;        // STT gate threshold — gapda yaxshi catch qiladi
const ENERGY_TARGET = 1500;        // adaptive gain target — low, no clip
const SILENCE_MS = 500;            // silence = command end
const VOICE_ACTIVITY_THRESHOLD = parseFloat(env('VOICE_ACTIVITY_THRESHOLD')) || 150; // buyruq yozib olishda "gapiryapti" chegarasi
const CMD_MAX = 5.0;               // max command length (s)
const GAIN_MAX = 8, GAIN_MIN = 2; // gain limits — clipping bo'lmasin
const HOTWORD_COOLDOWN_MS = 1500;  // debounce after trigger

const REALTIME_ENABLED = (env('REALTIME_ENABLED') || 'true') !== 'false'; // haqiqiy real-vaqtli (gpt-realtime) suhbat rejimi
const REALTIME_IDLE_MS = parseInt(env('REALTIME_IDLE_MS'), 10) || 20000;  // shuncha vaqt jim bo'lsa, suhbat avtomatik yakunlanadi

// Parallel bajarilayotgan jonli vazifalar (run_task) holati — dashboard
// buni /api/realtime-tasks orqali o'qib, "hozir nima ustida ishlayapti"
// panelini ko'rsatadi. Daemon va dashboard alohida jarayon bo'lgani uchun
// fayl orqali ulanadi (soddaroq, qo'shimcha IPC shart emas).
const REALTIME_TASKS_STATE_FILE = path.join(PROJECT_DIR, '.realtime-tasks-state.json');
const REALTIME_TASKS_MAX = 15;
let _realtimeTasks = [];
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
  if (t) { t.status = 'completed'; t.result = String(result).slice(0, 500); t.completedAt = Date.now(); }
  saveRealtimeTasksState();
}

const CLAP_TRIGGER_ENABLED = (env('CLAP_TRIGGER_ENABLED') || 'true') !== 'false';
const CLAP_SPIKE_RATIO = parseFloat(env('CLAP_SPIKE_RATIO')) || 4;     // spike, tinch fondan necha barobar baland
const CLAP_ABS_FLOOR = parseFloat(env('CLAP_ABS_FLOOR')) || 250;       // mutlaq minimal spike (juda tinch xonada ham)
const CLAP_QUIET_RATIO = 0.4;      // spike'dan oldingi step shundan past bo'lishi kerak
const CLAP_MIN_GAP_MS = 120;       // ikki qarsak orasidagi eng qisqa oraliq
const CLAP_MAX_GAP_MS = 900;       // ikki qarsak orasidagi eng uzoq oraliq (tabiiy ritmga biroz kengroq joy)

let _gain = 2.0;  // START LOW — adapt, don't clip

// ── Colors ──────────────────────────────────────────────
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[36m', X = '\x1b[0m';
function ok(m)  { console.log(G + '✅ ' + m + X); }
function er(m)  { console.error(R + '❌ ' + m + X); }
function inf(m) { console.log(B + 'ℹ️  ' + m + X); }
function wrn(m) { console.log(Y + '⚠️  ' + m + X); }

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
function detectWakeSoundMs() {
  try {
    const out = execSync('afinfo "' + WAKE_SOUND_PATH + '" 2>/dev/null | grep -i "estimated duration"', { encoding: 'utf8' });
    const m = out.match(/([\d.]+)\s*sec/);
    if (m) return Math.round(parseFloat(m[1]) * 1000) + 200; // + kichik zaxira (karnay/ijro kechikishi)
  } catch (e) {}
  return 1000; // afinfo ishlamasa — ehtiyotkor, lekin eski 2400dan ancha kichik qiymat
}
const WAKE_SOUND_MS = detectWakeSoundMs();

function playWakeSound() {
  if (!fs.existsSync(WAKE_SOUND_PATH)) return;
  try {
    const p = spawn('afplay', [WAKE_SOUND_PATH], { stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch (e) {}
}

// ── QOSHIMCHA TOVUSH BELGILARI ── tizimning tayyor (macOS) tovushlaridan
// foydalaniladi — sifatli, yangi audio generatsiya qilish shart emas.
// Sosumi = klassik "diqqat" ogohlantirish tovushi (shoshilinch signal
// oldidan); Glass = yengil, ijobiy "tugadi" tovushi (uzoqroq run_task
// vazifasi tugaganda — HUD-dek "bajarildi" hissi beradi). fast_action
// uchun ATAYIN ishlatilmaydi — u allaqachon deyarli oniy, qo'shimcha
// tovush faqat ortiqcha shovqin bo'lardi.
function playSystemSound(name) {
  const p_ = path.join('/System/Library/Sounds', name + '.aiff');
  if (!fs.existsSync(p_)) return;
  try {
    const p = spawn('afplay', [p_], { stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch (e) {}
}
function playUrgentSound() { playSystemSound('Sosumi'); }
function playTaskDoneSound() { playSystemSound('Glass'); }

// ════════════════════════════════════════════
// TELEGRAM / HELPERS
// ════════════════════════════════════════════
function sendTelegram(text) {
  return new Promise((resolve) => {
    if (!CHAT_ID) { resolve(false); return; }
    const payload = JSON.stringify({ chat_id: CHAT_ID, text: String(text).substring(0, 4096) });
    const req = https.request({ hostname: 'api.telegram.org', path: '/bot' + TOKEN + '/sendMessage', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false)); req.setTimeout(15000, () => { req.destroy(); resolve(false); });
    req.write(payload); req.end();
  });
}
function sendTelegramVoice(oggPath) {
  return new Promise((resolve) => {
    if (!CHAT_ID || !fs.existsSync(oggPath)) { resolve(false); return; }
    try { execSync('curl -s -X POST "https://api.telegram.org/bot' + TOKEN + '/sendVoice" -F "chat_id=' + CHAT_ID + '" -F "voice=@' + oggPath + '" > /dev/null 2>&1'); resolve(true); }
    catch (e) { resolve(false); }
  });
}

async function ttsToFile(text) {
  return new Promise((resolve) => {
    const tmpIn = '/tmp/tts_' + Date.now() + '.json';
    fs.writeFileSync(tmpIn, JSON.stringify({ text }), 'utf8');
    const proc = spawn('node', ['skills/azure-tts/index.js'], {
      cwd: PROJECT_DIR, env: { ...process.env, AZURE_SPEECH_KEY: env('AZURE_SPEECH_KEY'), AZURE_SPEECH_REGION: env('AZURE_SPEECH_REGION'), AZURE_SPEECH_VOICE: env('AZURE_SPEECH_VOICE') || 'uz-UZ-SardorNeural' }
    });
    let out = '';
    proc.stdout.on('data', d => out += d); proc.stderr.on('data', () => {});
    proc.on('close', () => { try { fs.unlinkSync(tmpIn); } catch(e){} try { resolve(JSON.parse(out.trim()).audioFile || null); } catch(e){ resolve(null); } });
    fs.createReadStream(tmpIn).pipe(proc.stdin);
  });
}

async function askAgent(message) {
  return new Promise((resolve) => {
    const proc = spawn('openclaw', ['agent', '--message', message, '--agent', 'main'], { cwd: PROJECT_DIR, env: { ...process.env, AZURE_OPENAI_KEY }, timeout: 15000 });
    let out = '';
    proc.stdout.on('data', d => out += d); proc.stderr.on('data', () => {});
    proc.on('close', () => {
      const clean = out.split('\n').filter(l => !l.includes('Waiting') && !l.includes('◒') && l.trim()).join('\n').trim();
      resolve((!clean || clean.includes("couldn't generate") || clean.includes('tool policy removed')) ? null : clean);
    });
  });
}

// ════════════════════════════════════════════
// PROAKTIV REJIM — davriy ravishda screen-monitor yozgan Obsidian
// xotirasini ko'rib chiqadi; agent chindan foydali narsa topsa,
// Telegram/ovoz orqali taklif qiladi. Hech qachon so'ramasdan
// mustaqil harakat (klik/yozish) qilmaydi — faqat kuzatib, taklif beradi.
// ════════════════════════════════════════════
const PROACTIVE_ENABLED_RT = (env('PROACTIVE_ENABLED') || 'false') === 'true';
const PROACTIVE_INTERVAL_MIN_RT = parseInt(env('PROACTIVE_INTERVAL_MIN'), 10) || 30;
const PROACTIVE_STATE_FILE = path.join(PROJECT_DIR, '.proactive-state.json');

function loadProactiveState() {
  try { return JSON.parse(fs.readFileSync(PROACTIVE_STATE_FILE, 'utf8')); } catch (e) { return { lastCheck: Date.now() }; }
}
function saveProactiveState(s) {
  try { fs.writeFileSync(PROACTIVE_STATE_FILE, JSON.stringify(s)); } catch (e) {}
}

async function checkProactive() {
  const state = loadProactiveState();
  let mem;
  try { mem = require('./skills/memory'); } catch (e) { return; }
  const date = localDateStr();
  const filePath = path.join(mem.MEMORY_DIR, date + '.md');
  if (!fs.existsSync(filePath)) { state.lastCheck = Date.now(); saveProactiveState(state); return; }

  const content = fs.readFileSync(filePath, 'utf8');
  const blocks = content.split(/^---$/m).map(b => b.trim()).filter(Boolean);
  const newBlocks = [];
  const now = new Date();
  for (const block of blocks) {
    const m = block.match(/^## (\d{2}):(\d{2}) — (.+)$/m);
    if (!m) continue;
    const [, hh, mm, topic] = m;
    if (!topic.includes('Ekran')) continue;
    const blockTime = new Date(now); blockTime.setHours(+hh, +mm, 0, 0);
    if (blockTime.getTime() > state.lastCheck) newBlocks.push(block);
  }

  state.lastCheck = Date.now();
  saveProactiveState(state);
  if (!newBlocks.length) return;

  // Ko'p kunlik o'rganilgan naqshlarni ham qo'shamiz — shunda taklif faqat
  // "hozir shu ko'rinyapti" emas, balki "odatda shu vaqt/holatda siz shuni
  // qilasiz" darajasida, haqiqiy odatlarga asoslangan bo'ladi.
  let patternsBlock = '';
  try {
    const profile = mem.readProfile();
    if (profile.status === 'ok') {
      const sections = profile.content.split(/^## /m).slice(1).filter(s => s.startsWith('O\'rganilgan naqshlar') || s.startsWith('Odatlar'));
      if (sections.length) patternsBlock = '\n\n=== SIZNING ODDIY VAQTLARDA O\'RGANILGAN ODATLARINGIZ ===\n' + sections.slice(-5).map(s => '## ' + s).join('\n');
    }
  } catch (e) {}

  const now2 = new Date();
  const prompt = 'Hozirgi vaqt: ' + now2.toTimeString().slice(0, 5) + ' (' + ['Yakshanba','Dushanba','Seshanba','Chorshanba','Payshanba','Juma','Shanba'][now2.getDay()] + ').\n\n' +
    'So\'nggi ' + PROACTIVE_INTERVAL_MIN_RT + ' daqiqada ekranda quyidagi o\'zgarishlar qayd etildi:\n\n' +
    newBlocks.join('\n\n') +
    patternsBlock +
    '\n\nYuqoridagi ODATLARGA qarab, hozirgi vaqt/holat bilan solishtiring: foydalanuvchi odatda shu payt/holatda ' +
    'nima qilishi kerak edi, lekin qilmagandek ko\'rinsa (masalan unutgan, chalg\'igan) — yoki hozirgi ekrandan chindan ' +
    'foydali/muhim bir taklif (xato, unutilgan vazifa, yordam kerak bo\'lgan holat) ko\'rsangiz — qisqa (2-3 gap) taklif ' +
    'qiling, nega bu taklifni berayotganingizni ham qisqa izohlang (masalan "odatda shu vaqt atrofida..."). Aks holda ' +
    'faqat "HECH_NARSA" deb javob bering, boshqa hech narsa yozmang.';
  const reply = await askAgent(prompt, 'agent:main:jarvis-proactive');
  if (reply && !reply.includes('HECH_NARSA') && reply.trim().length > 5) {
    ok('💡 Proaktiv taklif: ' + reply.substring(0, 80));
    sendTelegram('💡 ' + reply);
    const audio = await ttsToFile(reply.substring(0, 300));
    if (audio) { try { execSync('afplay "' + audio + '"'); } catch (e) {} }
  }
}

if (PROACTIVE_ENABLED_RT) {
  inf('Proaktiv rejim yoqilgan — har ' + PROACTIVE_INTERVAL_MIN_RT + ' daqiqada tekshiradi');
  setInterval(() => { checkProactive().catch(() => {}); }, PROACTIVE_INTERVAL_MIN_RT * 60 * 1000);
}

// ── SHOSHILINCH ekran ogohlantirishlari — checkProactive()'ning umumiy
// 30 daqiqalik tsiklidan FARQLI, screen-monitor #urgent deb belgilagan
// (xato/crash, xavfsizlik, muddat kabi) yozuvlarni ANCHA tez-tez (default
// 3 daqiqada) tekshiradi va DARHOL ovozli+Telegram xabar beradi — muhim
// narsa 30 daqiqagacha "kutib qolmasin". Alohida state fayli ishlatadi,
// checkProactive()ning umumiy hisobiga aralashmaydi.
const URGENT_CHECK_ENABLED = (env('URGENT_CHECK_ENABLED') || 'true') !== 'false';
const URGENT_CHECK_INTERVAL_MIN = parseInt(env('URGENT_CHECK_INTERVAL_MIN'), 10) || 3;
const URGENT_STATE_FILE = path.join(PROJECT_DIR, '.urgent-check-state.json');

function loadUrgentState() {
  try { return JSON.parse(fs.readFileSync(URGENT_STATE_FILE, 'utf8')); } catch (e) { return { lastCheck: Date.now() }; }
}
function saveUrgentState(s) {
  try { fs.writeFileSync(URGENT_STATE_FILE, JSON.stringify(s)); } catch (e) {}
}

async function checkUrgentScreen() {
  const state = loadUrgentState();
  let mem;
  try { mem = require('./skills/memory'); } catch (e) { return; }
  const filePath = path.join(mem.MEMORY_DIR, localDateStr() + '.md');
  if (!fs.existsSync(filePath)) { state.lastCheck = Date.now(); saveUrgentState(state); return; }

  const content = fs.readFileSync(filePath, 'utf8');
  const blocks = content.split(/^---$/m).map(b => b.trim()).filter(Boolean);
  const now = new Date();
  const urgentBlocks = [];
  for (const block of blocks) {
    if (!/#urgent\b/.test(block)) continue;
    const m = block.match(/^## (\d{2}):(\d{2}) — (.+)$/m);
    if (!m) continue;
    const [, hh, mm, topic] = m;
    const blockTime = new Date(now); blockTime.setHours(+hh, +mm, 0, 0);
    if (blockTime.getTime() > state.lastCheck) urgentBlocks.push({ topic, block });
  }
  state.lastCheck = Date.now();
  saveUrgentState(state);
  if (!urgentBlocks.length) return;

  for (const { block } of urgentBlocks) {
    const summary = block.replace(/^## .+$/m, '').replace(/\*\*Teglar:\*\*.*$/m, '').trim();
    ok('🚨 Shoshilinch: ' + summary.substring(0, 80));
    playUrgentSound();
    sendTelegram('🚨 ' + summary);
    const audio = await ttsToFile(('Diqqat. ' + summary).substring(0, 300));
    if (audio) { try { execSync('afplay "' + audio + '"'); } catch (e) {} }
  }
}

if (URGENT_CHECK_ENABLED) {
  inf('Shoshilinch ekran ogohlantirishi yoqilgan — har ' + URGENT_CHECK_INTERVAL_MIN + ' daqiqada tekshiradi');
  setInterval(() => { checkUrgentScreen().catch(() => {}); }, URGENT_CHECK_INTERVAL_MIN * 60 * 1000);
}

// ── Kunlik o'rganish: xom kuzatuvlardan barqaror naqshlarni ajratib,
// profilga qo'shadi. Skill o'zi qaysi kunlar bajarilganini eslab qoladi,
// shuning uchun tez-tez chaqirish xavfsiz (takror bajarilmaydi).
const SYNTHESIS_ENABLED = (env('DAILY_SYNTHESIS_ENABLED') || 'true') !== 'false';

async function runDailySynthesis() {
  try {
    const { synthesize, yesterday } = require('./skills/daily-synthesis');
    const r = await synthesize(yesterday());
    if (r && r.learned && r.learned.length) {
      ok('🧠 O\'rganildi (' + r.date + '): ' + r.learned.length + ' ta naqsh profilga qo\'shildi');
      sendTelegram('🧠 Kecha kuzatilganlardan o\'rgandim:\n' + r.learned.join('\n'));
    }
  } catch (e) { er('Kunlik o\'rganish xatolik: ' + (e.message || e)); }
}

if (SYNTHESIS_ENABLED) {
  inf('Kunlik o\'rganish yoqilgan');
  setTimeout(() => { runDailySynthesis(); }, 2 * 60 * 1000);          // ishga tushgach
  setInterval(() => { runDailySynthesis(); }, 60 * 60 * 1000);        // keyin har soatda tekshiradi
}

// ════════════════════════════════════════════
// KUNLIK VAZIFALAR — Obsidian'dagi ro'yxat (skills/tasks).
// Foydalanuvchi Obsidian'da to'g'ridan-to'g'ri qo'shishi mumkin; Jarvis
// ham daily-synthesis orqali o'zi foydali naqshlarni qo'shib boradi.
// Ro'yxatga tushgan narsa uchun alohida ruxsat so'ralmaydi — kun
// davomida navbat bilan avtomatik bajariladi (SOUL.md Chegaralar hali
// kuchda: qaytarib bo'lmaydigan amallar baribir so'raladi).
// ════════════════════════════════════════════
const DAILY_TASKS_ENABLED = (env('DAILY_TASKS_ENABLED') || 'true') !== 'false';
const DAILY_TASK_LEAD_MIN = Math.max(0, parseInt(env('DAILY_TASK_LEAD_MIN'), 10) || 0);
const DAILY_TASKS_STATE_FILE = path.join(PROJECT_DIR, '.daily-tasks-state.json');

function todayStr() { return localDateStr(); }

function loadDailyTasksState() {
  let s;
  try { s = JSON.parse(fs.readFileSync(DAILY_TASKS_STATE_FILE, 'utf8')); } catch (e) { s = null; }
  if (!s || s.date !== todayStr()) s = { date: todayStr(), completed: [] };
  return s;
}
function saveDailyTasksState(s) {
  try { fs.writeFileSync(DAILY_TASKS_STATE_FILE, JSON.stringify(s)); } catch (e) {}
}

// Vazifa matnidagi vaqt belgisi ("Har kuni 19:30 — ...", "soat 11:00 da")
// — shu vaqtdan OLDIN bajarilmasligi kerak. Avval bu umuman qaralmasdi:
// ro'yxatdagi birinchi bajarilmagan vazifa qaysi vaqt bo'lishidan qat'i
// nazar darhol ishga tushardi. Real oqibat (Obsidian yozuvlaridan
// tasdiqlangan): "11:00 — WhatsApp" vazifasi 00:15da, "19:30 — zal
// rejasi" 00:25da bajarilgan. Eslatma noto'g'ri vaqtda kelsa, umuman
// ma'nosini yo'qotadi.
function scheduledMinutes(text) {
  const m = String(text).match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]);
}
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

async function checkDailyTasks() {
  let tasksMod;
  try { tasksMod = require('./skills/tasks'); } catch (e) { return; }
  const active = tasksMod.activeTasks();
  if (!active.length) return;

  const state = loadDailyTasksState();
  const cur = nowMinutes();
  // Vaqti belgilangan vazifa faqat o'sha vaqt kelgach bajariladi. Vaqt
  // yozilmagan vazifa (avvalgidek) istalgan paytda bajarilaveradi.
  // Belgilangan vaqt o'tib ketgan bo'lsa ham bajariladi (masalan kompyuter
  // 19:30da o'chiq bo'lsa, 20:10da yoqilganda baribir eslatadi).
  // Oldindan tayyorlanish: vazifaning o'zi bajarilishi ham vaqt oladi
  // (agent chaqiruvi, brauzer va h.k.), shuning uchun belgilangan vaqtdan
  // DAILY_TASK_LEAD_MIN daqiqa oldin boshlanadi — natija/eslatma
  // foydalanuvchiga aynan kerakli vaqtda yetib borsin, kechikib emas.
  const next = active.find(t => {
    if (state.completed.includes(t)) return false;
    const sched = scheduledMinutes(t);
    return sched === null || cur >= (sched - DAILY_TASK_LEAD_MIN);
  });
  if (!next) return;

  const prompt = 'Kunlik vazifalar ro\'yxatidagi vazifa: "' + next + '". Buni bajaring va natijani qisqa ayting.';
  const reply = await askAgent(prompt, 'agent:main:jarvis-daily-tasks-' + Date.now());
  state.completed.push(next);
  saveDailyTasksState(state);
  if (reply) {
    ok('📋 Vazifa bajarildi: ' + next);
    sendTelegram('✅ "' + next + '":\n' + reply);
    try { writeMemory('Kunlik vazifa bajarildi', 'Vazifa: ' + next + '\nNatija: ' + reply.substring(0, 500), ['daily-task', 'autonomous']); } catch (e) {}
  }
}

if (DAILY_TASKS_ENABLED) {
  inf('Kunlik vazifalar rejimi yoqilgan');
  setTimeout(() => { checkDailyTasks().catch(() => {}); }, 3 * 60 * 1000);
  setInterval(() => { checkDailyTasks().catch(() => {}); }, 20 * 60 * 1000);
}

// ════════════════════════════════════════════
// KUNLIK O'Z-O'ZINI HISOBOT — kun oxirida (mahalliy soat) bugun mustaqil
// bajarilgan barcha ishlar (ovozli buyruqlar, kunlik vazifalar, jonli
// suhbatdagi parallel task'lar) qisqa xulosa qilinib, Telegram+ovoz orqali
// aytiladi. To'liq avtonom ruxsat berilgani uchun — nazorat o'rniga
// shaffoflikni saqlash uchun.
// ════════════════════════════════════════════
const DAILY_REPORT_ENABLED = (env('DAILY_REPORT_ENABLED') || 'true') !== 'false';
const DAILY_REPORT_HOUR = parseInt(env('DAILY_REPORT_HOUR'), 10) || 22; // mahalliy soat
const DAILY_REPORT_STATE_FILE = path.join(PROJECT_DIR, '.daily-report-state.json');
const REPORT_TAGS = ['task', 'daily-task', 'realtime', 'voice', 'autonomous'];

function loadDailyReportState() {
  let s;
  try { s = JSON.parse(fs.readFileSync(DAILY_REPORT_STATE_FILE, 'utf8')); } catch (e) { s = null; }
  if (!s || s.date !== todayStr()) s = { date: todayStr(), sent: false };
  return s;
}
function saveDailyReportState(s) {
  try { fs.writeFileSync(DAILY_REPORT_STATE_FILE, JSON.stringify(s)); } catch (e) {}
}

async function runDailySelfReport() {
  const state = loadDailyReportState();
  if (state.sent) return;
  if (new Date().getHours() < DAILY_REPORT_HOUR) return;

  let mem;
  try { mem = require('./skills/memory'); } catch (e) { return; }
  const filePath = path.join(mem.MEMORY_DIR, todayStr() + '.md');
  if (!fs.existsSync(filePath)) { state.sent = true; saveDailyReportState(state); return; }

  const content = fs.readFileSync(filePath, 'utf8');
  const blocks = content.split(/^---$/m).map(b => b.trim()).filter(Boolean);
  const relevant = blocks.filter(b => REPORT_TAGS.some(t => b.includes('#' + t)));

  state.sent = true; // natijadan qat'iy nazar bugun qayta yubormaymiz
  saveDailyReportState(state);
  if (!relevant.length) return; // bugun mustaqil ish bo'lmagan bo'lsa, hisobot yubormaymiz

  const prompt = 'Bugun quyidagi ishlar (ovozli buyruqlar, mustaqil bajarilgan vazifalar) amalga oshirildi:\n\n' +
    relevant.join('\n\n').slice(0, 8000) +
    '\n\nFoydalanuvchi uchun QISQA (3-6 gap), oddiy tilda, texnik tafsilotsiz kunlik hisobot yozing — nima qilindi, ' +
    'muhim natijalar. Kirish/xulosa jumlasi shart emas, to\'g\'ridan-to\'g\'ri mazmun bilan boshlang.';
  const reply = await askAgent(prompt, 'agent:main:jarvis-daily-report-' + todayStr());
  if (!reply) return;

  ok('📊 Kunlik hisobot tayyor');
  sendTelegram('📊 Bugungi hisobot:\n\n' + reply);
  try { writeMemory('Kunlik hisobot', reply, ['report']); } catch (e) {}
  const audio = await ttsToFile(reply.substring(0, 400));
  if (audio) { try { execSync('afplay "' + audio + '"'); } catch (e) {} }
}

if (DAILY_REPORT_ENABLED) {
  inf('Kunlik hisobot rejimi yoqilgan — har kuni soat ' + DAILY_REPORT_HOUR + ':00dan keyin');
  setInterval(() => { runDailySelfReport().catch(() => {}); }, 15 * 60 * 1000);
}

// ════════════════════════════════════════════
// LOYIHALAR — ko'p bosqichli, kun davomida ketma-ket bajariladigan
// avtonom ishlar (skills/projects). Oddiy kunlik vazifalardan farqi:
// bosqichlar BITTA umumiy session'da (bir-biridan xabardor holda)
// ketma-ket bajariladi, va loyiha tugagach ALOHIDA, konsolidatsiyalangan
// yakuniy hisobot beriladi (har bosqich uchun alohida emas).
// ════════════════════════════════════════════
const PROJECTS_ENABLED = (env('PROJECTS_ENABLED') || 'true') !== 'false';

// Bosqich urinishlari hisobi — daemon qayta ishga tushsa ham saqlanib
// qolishi uchun faylda (xotirada saqlansa, tez-tez restart bo'lganda
// hisob nolga qaytib, cheksiz urinish xavfi qaytadi).
const PROJECT_STEP_MAX_ATTEMPTS = parseInt(env('PROJECT_STEP_MAX_ATTEMPTS'), 10) || 2;
const PROJECT_ATTEMPTS_FILE = path.join(PROJECT_DIR, '.project-step-attempts.json');

function loadProjectAttempts() {
  try { return JSON.parse(fs.readFileSync(PROJECT_ATTEMPTS_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveProjectAttempts(a) {
  try { fs.writeFileSync(PROJECT_ATTEMPTS_FILE, JSON.stringify(a)); } catch (e) {}
}
function projectStepKey(slug, step) { return slug + '|' + String(step).slice(0, 120); }
function bumpProjectStepAttempt(slug, step) {
  const a = loadProjectAttempts();
  const k = projectStepKey(slug, step);
  a[k] = (a[k] || 0) + 1;
  saveProjectAttempts(a);
  return a[k];
}
function clearProjectStepAttempts(slug, step) {
  const a = loadProjectAttempts();
  delete a[projectStepKey(slug, step)];
  saveProjectAttempts(a);
}

async function checkProjects() {
  let projMod;
  try { projMod = require('./skills/projects'); } catch (e) { return; }
  const active = projMod.activeStep();
  if (!active) return;

  const sessionKey = 'agent:main:jarvis-project-' + active.slug;
  const prompt = 'Loyiha "' + active.project + '" ning navbatdagi bosqichi (' + (active.doneSteps + 1) + '/' + active.totalSteps + '): "' +
    active.step + '". Buni bajaring va natijani qisqa ayting. (Oldingi bosqichlar shu sessiyada allaqachon bajarilgan — ' +
    'ularning kontekstidan foydalaning.)';
  const reply = await askAgent(prompt, sessionKey);
  if (!reply) return; // muvaffaqiyatsiz — bosqichni "bajarilgan" deb belgilamaymiz, keyingi tekshiruvda qayta uriniladi

  // Agent xato/cheklov sabab vazifani bajarmaganini aniq aytsa, uni
  // muvaffaqiyatli bosqich sifatida yopib yubormaymiz. Cheksiz loopga
  // tushmaslik uchun urinishlar persistent hisoblanadi.
  const stepIncomplete = /\b(xato|bajarilmadi|uddalay olmadim|muvaffaqiyatsiz|permission denied|ruxsat yo.q)\b/i.test(reply);
  if (stepIncomplete) {
    const attempts = bumpProjectStepAttempt(active.slug, active.step);
    wrn('Loyiha bosqichi bajarilmadi (' + attempts + '/' + PROJECT_STEP_MAX_ATTEMPTS + '): ' + active.step);
    if (attempts < PROJECT_STEP_MAX_ATTEMPTS) return;
  } else {
    clearProjectStepAttempts(active.slug, active.step);
  }

  const result = projMod.completeStep(active.slug, active.step);
  if (result.status !== 'ok') return;

  ok('📁 Loyiha bosqichi ' + (stepIncomplete ? 'chala yopildi' : 'bajarildi') + ': ' + active.project + ' (' + (active.doneSteps + 1) + '/' + active.totalSteps + ')');
  try {
    writeMemory('Loyiha bosqichi: ' + active.project, 'Bosqich: ' + active.step + '\nNatija: ' + reply.substring(0, 500),
      stepIncomplete ? ['project', 'autonomous', 'incomplete'] : ['project', 'autonomous']);
  } catch (e) {}

  if (result.complete) {
    // Barcha bosqichlar tugadi — yakuniy, konsolidatsiyalangan hisobot
    const reportPrompt = 'Loyiha "' + active.project + '" barcha bosqichlari (' + result.allSteps.join(', ') +
      ') muvaffaqiyatli bajarildi (shu sessiyada). Foydalanuvchi uchun QISQA (3-5 gap) yakuniy hisobot yozing — ' +
      'nima qilindi, muhim natijalar. Texnik tafsilotsiz, oddiy tilda.';
    const finalReport = await askAgent(reportPrompt, sessionKey);
    if (finalReport) {
      ok('📁 Loyiha yakunlandi: ' + active.project);
      sendTelegram('📁 Loyiha yakunlandi — "' + active.project + '":\n\n' + finalReport);
      try { writeMemory('Loyiha yakunlandi: ' + active.project, finalReport, ['project', 'report', 'autonomous']); } catch (e) {}
    }
  }
}

if (PROJECTS_ENABLED) {
  inf('Ko\'p bosqichli loyihalar rejimi yoqilgan');
  setTimeout(() => { checkProjects().catch(() => {}); }, 4 * 60 * 1000);
  setInterval(() => { checkProjects().catch(() => {}); }, 15 * 60 * 1000);
}

// ════════════════════════════════════════════
// TEZ AMALLARNI O'RGANISH (fast-actions) — vaqti-vaqti bilan Obsidian
// xotirasidagi so'nggi kunlar vazifalarini (skills/memory'ga
// 'Vazifa boshlandi'/'Vazifa yakunlandi' sifatida yozilgan, qarang:
// startRealtimeSession()) ko'rib, "shunchaki biror dastur ochish"
// turidagi, hali fast-actions ro'yxatida yo'q so'rovlarni topadi va
// avtomatik qo'shadi (faqat "ilova ochish" turi — xavfsiz, chunki
// noto'g'ri/mavjud bo'lmagan nom shunchaki xato qaytaradi, boshqa
// hech qanday amal bajarilmaydi). Shu bilan tizim vaqt o'tishi bilan
// tobora ko'proq amalni to'liq agent ishga tushirmasdan, TEZ bajaradigan
// bo'lib boradi — foydalanuvchi hech narsa qilmasa ham.
// ════════════════════════════════════════════
const FAST_ACTION_LEARN_ENABLED = (env('FAST_ACTION_LEARN_ENABLED') || 'true') !== 'false';
const FAST_ACTION_LEARN_INTERVAL_MIN = parseInt(env('FAST_ACTION_LEARN_INTERVAL_MIN'), 10) || 720; // 12 soatda bir
const FAST_ACTION_LEARN_STATE_FILE = path.join(PROJECT_DIR, '.fast-action-learn-state.json');

function loadFastActionLearnState() {
  try { return JSON.parse(fs.readFileSync(FAST_ACTION_LEARN_STATE_FILE, 'utf8')); } catch (e) { return { lastCheck: 0 }; }
}
function saveFastActionLearnState(s) {
  try { fs.writeFileSync(FAST_ACTION_LEARN_STATE_FILE, JSON.stringify(s)); } catch (e) {}
}

async function checkFastActionLearning() {
  let mem, fa;
  try { mem = require('./skills/memory'); fa = require('./skills/fast-actions'); } catch (e) { return; }
  const state = loadFastActionLearnState();

  // So'nggi 3 kunlik xotiradan vazifa tavsiflarini yig'amiz.
  const descriptions = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const fp = path.join(mem.MEMORY_DIR, localDateStr(d) + '.md');
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, 'utf8');
    const blocks = content.split(/^---$/m);
    for (const b of blocks) {
      const m = b.match(/^## \d{2}:\d{2} — Vazifa (boshlandi|yakunlandi)\n([\s\S]{0,300})/m);
      if (m) descriptions.push(m[2].trim());
    }
  }
  state.lastCheck = Date.now();
  saveFastActionLearnState(state);
  if (descriptions.length < 3) return; // yetarli tarix yo'q, keyingi safar qayta ko'radi

  let existingIds;
  try { existingIds = fa.actionIds().join(', '); } catch (e) { return; }

  const prompt = 'Quyidagi ro\'yxat — foydalanuvchi so\'nggi kunlarda ovozli buyruq bilan so\'ragan vazifalar tavsifi:\n\n' +
    descriptions.slice(-60).map(d => '- ' + d).join('\n') +
    '\n\nHozir tizimda quyidagi TEZ AMALLAR (fast actions) allaqachon mavjud (id ro\'yxati): ' + existingIds +
    '\n\nYuqoridagi vazifalar orasidan, FAQAT "biror kompyuter dasturi/ilovasini shunchaki OCHISH" turidagi ' +
    '(boshqa hech narsa qilmasdan, murakkab bo\'lmagan) so\'rovlarni top, va ular orasida HALI fast actions ' +
    'ro\'yxatida YO\'Q bo\'lgan, ANIQ ilova nomlarini JSON massiv sifatida qaytar (masalan ["Figma","Discord"]). ' +
    'Agar mos keluvchi yangi ilova topilmasa, bo\'sh massiv qaytar: []. Faqat JSON massiv yoz, boshqa hech narsa qo\'shma.';

  const reply = await askAgent(prompt, 'agent:main:jarvis-fast-action-learn');
  if (!reply) return;
  let apps = [];
  try {
    const jsonMatch = reply.match(/\[[\s\S]*\]/);
    if (jsonMatch) apps = JSON.parse(jsonMatch[0]);
  } catch (e) { return; }
  if (!Array.isArray(apps) || !apps.length) return;

  const added = [];
  for (const app of apps.slice(0, 5)) { // bir safarda ko'pi bilan 5 ta — sekin-asta, nazorat ostida o'sish
    if (typeof app !== 'string' || !app.trim()) continue;
    const r = fa.learnOpenAppAction(app.trim());
    if (r.status === 'ok') added.push(app.trim());
  }
  if (added.length) {
    ok('⚡ Yangi tez amallar o\'rganildi: ' + added.join(', '));
    sendTelegram('⚡ So\'rovlaringiz asosida yangi tez amallar qo\'shdim: ' + added.join(', ') + ' — endi bular tezroq bajariladi.');
    try { writeMemory('Tez amal o\'rganildi', 'Avtomatik qo\'shilgan yangi fast-action(lar): ' + added.join(', '), ['fast-action', 'autonomous']); } catch (e) {}
  }
}

if (FAST_ACTION_LEARN_ENABLED) {
  inf('Tez amallarni o\'rganish yoqilgan — har ' + FAST_ACTION_LEARN_INTERVAL_MIN + ' daqiqada tekshiradi');
  setTimeout(() => { checkFastActionLearning().catch(() => {}); }, 10 * 60 * 1000);
  setInterval(() => { checkFastActionLearning().catch(() => {}); }, FAST_ACTION_LEARN_INTERVAL_MIN * 60 * 1000);
}

// ════════════════════════════════════════════
// XOTIRA INDEKSINI FONDA YANGILASH — semantik (ma'no bo'yicha) qidiruv
// butun tarix bo'ylab ishlashi uchun har bir yangi xotira bloki
// indekslanishi kerak. Avval bu indekslash QIDIRUV ichida bajarilardi,
// ya'ni har bir qidiruv yangi bloklarni indekslashni kutardi — real
// o'lchovda 125 SONIYA (qidiruvning o'zi esa atigi 611 ms). Endi u
// shu yerda, fonda, muntazam bajariladi; qidiruv esa doim tayyor
// indeksdan o'qib, bir zumda javob beradi.
// ════════════════════════════════════════════
const EMBED_INDEX_ENABLED = (env('EMBED_INDEX_ENABLED') || 'true') !== 'false';
const EMBED_INDEX_INTERVAL_MIN = parseInt(env('EMBED_INDEX_INTERVAL_MIN'), 10) || 15;
let _embedIndexRunning = false;

async function refreshEmbedIndex() {
  if (_embedIndexRunning) return; // oldingisi hali tugamagan bo'lsa, ustma-ust ishga tushmasin
  _embedIndexRunning = true;
  try {
    const mem = require('./skills/memory');
    const t0 = Date.now();
    const r = await mem.updateEmbedIndex();
    if (r && r.added > 0) inf('🧠 Xotira indeksi yangilandi: +' + r.added + ' (jami ' + r.total + ', ' + Math.round((Date.now() - t0) / 1000) + 's)');
  } catch (e) { wrn('Xotira indeksi yangilanmadi: ' + (e.message || e)); }
  finally { _embedIndexRunning = false; }
}

if (EMBED_INDEX_ENABLED) {
  inf('Xotira indeksi fonda yangilanadi — har ' + EMBED_INDEX_INTERVAL_MIN + ' daqiqada');
  setTimeout(() => { refreshEmbedIndex(); }, 60 * 1000);
  setInterval(() => { refreshEmbedIndex(); }, EMBED_INDEX_INTERVAL_MIN * 60 * 1000);
}

// ════════════════════════════════════════════
// STT PROMISE POOL (pre-spawned children)
// ════════════════════════════════════════════
class STTPool {
  constructor(size = 2) {
    this.size = size;
    this.pool = [];
    this.env = { ...process.env, AZURE_SPEECH_KEY: env('AZURE_SPEECH_KEY'), AZURE_SPEECH_REGION: env('AZURE_SPEECH_REGION') };
    for (let i = 0; i < size; i++) this._spawn(i);
  }

  _spawn(idx) {
    const proc = spawn('node', ['skills/azure-stt/index.js'], { cwd: PROJECT_DIR, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    proc._busy = false;
    proc._idx = idx;
    proc._buffer = '';
    // stdout listener recognize() ichida qo'shiladi — bu yerda emas
    // (ikkalasi baravar bo'lsa har bir chunk ikki marta buffer'ga
    // qo'shilib, JSON'ni buzib, timeout'gacha "natija topilmadi" bergan)
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', () => {}); // EPIPE qo'lga olinmasa butun daemon'ni yiqitadi
    proc.on('error', () => { this._respawn(idx); });
    proc.on('exit', () => { this._respawn(idx); });
    this.pool[idx] = proc;
  }

  _respawn(idx) {
    try { this.pool[idx]?.kill?.(); } catch(e){}
    this._spawn(idx);
  }

  async recognize(audioWavBuffer, locale = 'uz-UZ') {
    // find idle child
    let child = this.pool.find(p => !p._busy);
    if (!child) {
      // all busy, just take the one with most data
      child = this.pool.reduce((a, b) => (a._buffer.length < b._buffer.length ? a : b));
      child._buffer = '';
    }
    child._busy = true;
    child._buffer = '';

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.stdout.off('data', onData); // aks holda listener to'planib, keyingi chaqiruvlarni buzadi
        child._busy = false;
        resolve({ status: 'error', text: '', reason: 'timeout' });
      }, 12000);
      const onData = (d) => {
        child._buffer += d;
        const lines = child._buffer.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.status || parsed.error) {
              clearTimeout(timeout);
              child.stdout.off('data', onData);
              child._busy = false;
              resolve(parsed.status === 'ok' ? parsed : { status: 'error', text: '', reason: parsed.error || 'unknown' });
              return;
            }
          } catch(e) {}
        }
      };
      child.stdout.on('data', onData);
      child.stdin.write(JSON.stringify({ audioBase64: audioWavBuffer.toString('base64'), locale }) + '\n');
    });
  }

  killAll() { this.pool.forEach(p => { try { p.kill('SIGKILL'); } catch(e){} }); }
}

// ════════════════════════════════════════════
// AUDIO UTILITIES (buffer-based, zero disk)
// ════════════════════════════════════════════
function makeWavHeader(dataLen, sampleRate = 16000, channels = 1, bits = 16) {
  const blockAlign = channels * bits / 8;
  const byteRate = sampleRate * blockAlign;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);        // subchunk1Size
  buf.writeUInt16LE(1, 20);         // audioFormat PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

function pcmToWavBuffer(pcm16leBuffer) {
  return Buffer.concat([makeWavHeader(pcm16leBuffer.length, 16000, 1, 16), pcm16leBuffer]);
}

function getEnergy(pcm16leBuffer) {
  if (pcm16leBuffer.length < 2) return 0;
  const samples = pcm16leBuffer.length / 2;
  let sum = 0;
  for (let i = 0; i < pcm16leBuffer.length; i += 2) {
    const v = pcm16leBuffer.readInt16LE(i);
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

// Qarsak — juda qisqa (bir necha millisekund) zarba. getEnergy() (RMS)
// butun 200ms oynani o'rtachalashtiradi, shuning uchun qisqa zarba tinch
// fon bilan aralashib, "yumshab" ketadi va chegaradan pastda qolib
// ketishi mumkin edi. Peak (eng baland cho'qqi) qarsakni yo'qotmaydi.
function getPeakAmplitude(pcm16leBuffer) {
  let peak = 0;
  for (let i = 0; i < pcm16leBuffer.length; i += 2) {
    const v = Math.abs(pcm16leBuffer.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
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
// ROLLING PCM BUFFER (overlap chunking)
// ════════════════════════════════════════════
class RollingBuffer {
  constructor(maxDurationMs = 5000) {
    this.maxSamples = (maxDurationMs * SAMPLE_RATE) / 1000;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) { this.buf = Buffer.concat([this.buf, chunk]).slice(-this.maxSamples * 2); }
  get samples() { return Math.floor(this.buf.length / 2); }

  // Extract last N milliseconds as PCM
  sliceLast(ms) {
    const bytes = (ms * SAMPLE_RATE * 2) / 1000;
    return this.buf.slice(-bytes);
  }

  clear() { this.buf = Buffer.alloc(0); }
}

// ════════════════════════════════════════════
// PORCUPINE HOTWORD (frame-level, real-time)
// ════════════════════════════════════════════
class HotwordDetector {
  constructor(accessKey, PorcupineClass, keywordPath) {
    this.porcupine = new PorcupineClass(accessKey, [keywordPath], [0.7]);
    this.frameLength = this.porcupine.frameLength;  // e.g. 512 samples
    this.sampleRate = this.porcupine.sampleRate;    // 16000
    this.remainder = Buffer.alloc(0);
  }

  // Process new PCM chunk. Returns true once when hotword detected.
  processChunk(pcm16Buffer) {
    const pcm = Buffer.concat([this.remainder, pcm16Buffer]);
    const frameLen = this.frameLength * 2; // bytes per frame
    let detected = false;
    for (let i = 0; i + frameLen <= pcm.length; i += frameLen) {
      const frame = new Int16Array(this.frameLength);
      for (let j = 0; j < this.frameLength; j++) {
        frame[j] = pcm.readInt16LE(i + j * 2);
      }
      const keywordIndex = this.porcupine.process(frame);
      if (keywordIndex >= 0) { detected = true; }
    }
    this.remainder = pcm.slice(Math.floor(pcm.length / frameLen) * frameLen);
    return detected;
  }

  release() { this.porcupine.release(); }
}

// Bepul va to'liq lokal hey_jarvis modeli. Python worker ishlamay qolsa
// daemon qulamaydi: Azure STT backup hotword ishlashda davom etadi.
class OpenWakeWordDetector {
  constructor() {
    this.detected = false;
    this.ready = false;
    this.closed = false;
    this.lineBuffer = '';
    this.worker = spawn(OPENWAKEWORD_PYTHON, ['-u', path.join(PROJECT_DIR, 'scripts', 'openwakeword-worker.py')], {
      cwd: PROJECT_DIR,
      env: { ...process.env, OPENWAKEWORD_THRESHOLD: env('OPENWAKEWORD_THRESHOLD') || '0.55' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.worker.stdout.on('data', data => this._handleOutput(data.toString()));
    this.worker.stderr.on('data', data => {
      const text = data.toString().trim();
      if (text) wrn('openWakeWord: ' + text.split('\n').pop());
    });
    this.worker.on('error', error => {
      this.closed = true;
      wrn('openWakeWord worker ishga tushmadi: ' + error.message);
    });
    this.worker.on('close', code => {
      this.closed = true;
      this.ready = false;
      if (code !== 0) wrn('openWakeWord worker to\'xtadi (code=' + code + ') — STT fallback faol');
    });
  }

  _handleOutput(text) {
    this.lineBuffer += text;
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop();
    for (const line of lines) {
      if (line === 'READY') {
        this.ready = true;
        ok('openWakeWord "hey Jarvis" modeli tayyor (lokal, bepul)');
      } else if (line.startsWith('DETECT ')) {
        this.detected = true;
        inf('openWakeWord score=' + line.slice(7));
      } else if (line.startsWith('ERROR ')) {
        wrn('openWakeWord: ' + line.slice(6));
      }
    }
  }

  processChunk(pcm16Buffer) {
    if (!this.closed && this.worker.stdin.writable && this.worker.stdin.writableLength < SAMPLE_RATE * 2) {
      this.worker.stdin.write(pcm16Buffer);
    }
    const result = this.detected;
    this.detected = false;
    return result;
  }

  release() {
    this.closed = true;
    try { this.worker.stdin.end(); } catch (e) {}
    try { this.worker.kill(); } catch (e) {}
  }
}

// ════════════════════════════════════════════
// IKKI MARTA QARSAK TRIGGER (ovozsiz chaqirish)
// Har step'da hisoblangan xom energiyani kuzatadi: tinch → keskin spike
// ikki marta ketma-ket bo'lsa — hotword bilan bir xil trigger ishlaydi.
// Yangi audio pipeline shart emas, mavjud getEnergy() qiymatidan foydalanadi.
// ════════════════════════════════════════════
class ClapDetector {
  constructor() {
    this.prevEnergy = 0;
    this.baseline = 40;     // tinch fon energiyasi — sekin adaptatsiya qilinadi
    this.threshold = CLAP_ABS_FLOOR;
    this.firstClapAt = 0;
    this.recentLoud = [];   // so'nggi steplar "baland bo'ldimi" tarixi — uzluksiz gapirishni sezish uchun
  }

  // Har step'da chaqiriladi. Ikkinchi qarsak aniqlansa true qaytaradi.
  feedEnergy(energy, now) {
    // Baseline faqat tinch paytlarda (spike emasda) sekin yangilanadi,
    // shunda turli mikrofon sezgirligi/xona shovqiniga o'zi moslashadi.
    if (energy < this.baseline * 2.5) this.baseline = this.baseline * 0.95 + energy * 0.05;
    this.threshold = Math.max(CLAP_ABS_FLOOR, this.baseline * CLAP_SPIKE_RATIO);
    const quietCutoff = this.threshold * CLAP_QUIET_RATIO;

    const isTransient = energy > this.threshold && this.prevEnergy < quietCutoff;
    this.prevEnergy = energy;

    // Uzluksiz gapirishda ham ayrim bo'g'inlar orasida qisqa "tinch"
    // moment bo'lib, tasodifan "tinch->spike" ko'rinishini hosil qilishi
    // mumkin (ayniqsa peak asosidagi o'lchovda). Shuni ajratish uchun:
    // so'nggi ~1.2s (6 step) ichida necha marta baland bo'lganini
    // kuzatamiz — agar ko'p bo'lsa (uzluksiz faol tovush, ya'ni gapirish),
    // bu vaqt oralig'ida yangi qarsak-trigger qabul qilinmaydi. Haqiqiy
    // qarsak esa aksincha, tinch fonda YAKKA holda sodir bo'ladi.
    this.recentLoud.push(energy > quietCutoff);
    if (this.recentLoud.length > 6) this.recentLoud.shift();
    const busyLikelySpeech = this.recentLoud.filter(Boolean).length >= 4;

    if (!isTransient || busyLikelySpeech) {
      if (this.firstClapAt && (now - this.firstClapAt) > CLAP_MAX_GAP_MS) this.firstClapAt = 0;
      return false;
    }

    if (!this.firstClapAt) {
      this.firstClapAt = now;
      return false;
    }

    const gap = now - this.firstClapAt;
    this.firstClapAt = 0;
    return gap >= CLAP_MIN_GAP_MS && gap <= CLAP_MAX_GAP_MS;
  }
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
  _sttPool = new STTPool(2);
  _clap = CLAP_TRIGGER_ENABLED ? new ClapDetector() : null;
  if (OPENWAKEWORD_ENABLED && fs.existsSync(OPENWAKEWORD_PYTHON)) {
    _detector = new OpenWakeWordDetector();
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
  let state = 'listening'; // 'listening' | 'command_record' | 'processing'
  let cmdBuffers = [];
  let lastVoiceTime = 0;
  let cmdStartTime = 0;
  let pttActive = false; // Fn tugmasi bosib turilganda true — avto-sukunat kesish o'chadi

  // Barcha triggerlar bitta state transition'dan o'tadi. Rekonstruksiya
  // qilingan snapshotda triggerVoice chaqiriqlari qolib, funksiyaning o'zi
  // yo'qolgan edi — Porcupine/qarsak topilganda ReferenceError bo'lib daemon
  // qular edi. Fn DOWN/UP ham pause-sentinel brokeridan shu yerga keladi.
  function triggerVoice(reason) {
    if (state !== 'listening') return false;
    const now = Date.now();
    lastHotwordTime = now;
    state = 'command_record';
    cmdBuffers = [];
    cmdStartTime = now;
    lastVoiceTime = now;
    playWakeSound();
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
    fnClient.on('connect', () => inf('Fn-key broker ulandi'));
    fnClient.on('data', (data) => {
      fnBuf += data.toString();
      const lines = fnBuf.split('\n');
      fnBuf = lines.pop();
      for (const raw of lines) {
        const event = raw.trim();
        if (event === 'DOWN') {
          pttActive = true;
          triggerVoice('⌨️ Fn push-to-talk');
        } else if (event === 'UP') {
          pttActive = false;
          // Tugma qo'yib yuborilganda yozuv tabiiy silence chegarasidan tez
          // yakunlansin; data loop STT'ni xavfsiz ravishda boshlaydi.
          lastVoiceTime = Date.now() - SILENCE_MS - 1;
        }
      }
    });
    const reconnect = () => {
      if (fnRetry) return;
      fnRetry = setTimeout(() => { fnRetry = null; connectFnBroker(); }, 3000);
    };
    fnClient.on('error', reconnect);
    fnClient.on('close', reconnect);
  }
  connectFnBroker();

  inf('Mic stream started — listening for "Jarvis"...');
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
        if (state !== 'listening') cmdBuffers.push(stepData);
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
          const chunkPCM = Buffer.from(rolling.sliceLast(CHUNK_MS));
          if (_detector) {
            detected = _detector.processChunk(stepData);
          }

          if (detected && (now - lastHotwordTime > HOTWORD_COOLDOWN_MS)) {
            triggerVoice('🔥 HOTWORD: "Hey Jarvis" (openWakeWord)');
            return;
          }

          // STT backup hotword every step
          // Energy adapt on NON-amplified audio (real mic level)
          const rawPCM = Buffer.from(rolling.sliceLast(CHUNK_MS));
          const energy = getEnergy(rawPCM);
          adaptGain(energy);
          // Debug: energy log every 2 sec
          if ((now % 2000) < 200) inf('Energy=' + Math.round(energy) + ' gain=' + _gain.toFixed(1));
          if (energy >= ENERGY_MIN_STT && (now - lastSttCheck > 600)) {
            lastSttCheck = now;
            const wavBuf = pcmToWavBuffer(Buffer.from(chunkPCM));
            inf('STT backup hotword check (energy=' + Math.round(energy) + ')...');
            _sttPool.recognize(wavBuf, 'en-US').then(r => {
              if (r && r.status === 'ok' && r.text) {
                const t = r.text.toLowerCase();
                if (['jarvis','jar vis','jarviz','cervis','jervis','djervis','yarvis','jorvis','djarvis','jarv'].some(w => t.includes(w))) {
                  if ((Date.now() - lastHotwordTime) > HOTWORD_COOLDOWN_MS) {
                    triggerVoice('🔥 HOTWORD (STT backup): "' + r.text + '"');
                  }
                }
              } else {
                wrn('STT backup: javob yo\'q yoki xatolik');
              }
            }).catch(e => er('STT backup xatolik: ' + (e.message || e)));
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
          if (energy > 300) lastVoiceTime = now;
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
  if (reply) {
    ok('<<< ' + reply.substring(0, 80)); sendTelegram('🤖 ' + reply);
    try { writeMemory('Ovozli buyruq', 'Foydalanuvchi: ' + command + '\nJarvis: ' + reply.substring(0, 500), ['voice', 'buyruq']); } catch (e) {}
    const audio = await ttsToFile(reply.substring(0, 400));
    if (audio) {
      try { execSync('afplay "' + audio + '"'); ok('🔊 Ovoz'); } catch(e){}
      const ogg = audio.replace(/\.mp3$/, '.ogg');
      try { execSync('ffmpeg -y -i "' + audio + '" -c:a libopus "' + ogg + '" 2>/dev/null'); sendTelegramVoice(ogg); } catch(e){}
      [ogg, audio].forEach(p => { try { fs.unlinkSync(p); } catch(e){} });
    }
  } else { er('Xatolik'); sendTelegram('❌ Xatolik'); }
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
