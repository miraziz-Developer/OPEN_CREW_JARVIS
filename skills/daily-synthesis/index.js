#!/usr/bin/env node
/**
 * DAILY SYNTHESIS Skill — kunlik xom kuzatuvlardan naqsh (pattern) o'rganish
 *
 * Xom ekran kuzatuvlari `Jarvis/Memory/YYYY-MM-DD.md` ga yig'iladi, lekin
 * ulardan foyda bo'lishi uchun umumlashtirilishi kerak. Bu skill kunlik
 * yozuvlarni o'qib, agentdan barqaror naqshlarni ajratib olishni so'raydi
 * va natijani `Jarvis/Profile/User.md` profiliga qo'shadi — shu tariqa
 * "o'rganish" xotira orqali to'planib boradi.
 *
 * Kirish (stdin JSON): { date?: "YYYY-MM-DD" }  — default: kecha
 * Chiqish: { status, date, learned? , skipped? }
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_DIR = '/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS';
const ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8');
function env(k, def) { const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : def; }

const mem = require(path.join(PROJECT_DIR, 'skills', 'memory'));
const STATE_FILE = path.join(PROJECT_DIR, '.synthesis-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return { done: [] }; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) {}
}

// Mahalliy (timezone) sanani beradi — toISOString() UTC qaytaradi, shuning
// uchun UTC+8'da mahalliy soat 08:00gacha noto'g'ri kunni tanlab qolardi.
function localDateStr(d) {
  d = d || new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDateStr(d);
}

function askAgent(message) {
  return new Promise((resolve) => {
    const proc = spawn('openclaw', ['agent', '--session-key', 'agent:main:jarvis-background', '--message', message, '--agent', 'main'], {
      cwd: PROJECT_DIR,
      env: { ...process.env, AZURE_OPENAI_KEY: env('AZURE_OPENAI_KEY') },
      timeout: 120000
    });
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      const clean = out.split('\n').filter(l => !l.includes('Waiting') && !l.includes('◒') && l.trim()).join('\n').trim();
      resolve(clean || null);
    });
    proc.on('error', () => resolve(null));
  });
}

async function synthesize(date) {
  const state = loadState();
  if (state.done.includes(date)) {
    return { status: 'ok', date, skipped: 'allaqachon bajarilgan' };
  }

  const filePath = path.join(mem.MEMORY_DIR, date + '.md');
  if (!fs.existsSync(filePath)) {
    return { status: 'ok', date, skipped: 'kuzatuv yozuvi yo\'q' };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.trim().length < 100) {
    return { status: 'ok', date, skipped: 'yozuv juda qisqa' };
  }

  const profile = mem.readProfile();
  let existingTasks = [];
  try { existingTasks = require('../tasks').activeTasks(); } catch (e) {}
  const prompt =
    'Quyida ' + date + ' kuni foydalanuvchi kompyuterida kuzatilgan xom yozuvlar bor.\n\n' +
    '=== XOM KUZATUVLAR ===\n' + raw.slice(0, 12000) + '\n\n' +
    '=== MAVJUD PROFIL ===\n' + (profile.content || '(bo\'sh)').slice(0, 4000) + '\n\n' +
    '=== HOZIRGI KUNLIK VAZIFALAR RO\'YXATI ===\n' + (existingTasks.length ? existingTasks.join('\n') : '(bo\'sh)') + '\n\n' +
    'Vazifa 1: shu kundagi kuzatuvlardan foydalanuvchi haqida BARQAROR, kelajakda foydali ' +
    'xulosalar chiqaring (qanday loyihalar ustida ishlaydi, qanday vositalardan foydalanadi, ' +
    'ish uslubi, takrorlanadigan odatlar). Bir martalik tasodifiy narsalarni yozmang.\n\n' +
    'Vazifa 2: agar shu naqshlar orasida SIZ (Jarvis) har kuni mustaqil bajarishingiz mumkin bo\'lgan ' +
    'aniq, takrorlanadigan ish bo\'lsa (masalan muayyan tekshiruv, tozalash, kuzatuv, eslatma) — ' +
    'uni to\'g\'ridan-to\'g\'ri `exec` orqali kunlik vazifalar ro\'yxatiga qo\'shing: ' +
    'echo \'{"action":"add","text":"..."}\' | node skills/tasks/index.js — ' +
    'lekin faqat aniq va foydali bo\'lsa, ro\'yxatda allaqachon bor narsani qayta qo\'shmang.\n\n' +
    'Qoidalar (Vazifa 1 javobi uchun):\n' +
    '- Faqat 2-5 ta eng muhim xulosa, har biri bitta qisqa qatorda, "- " bilan boshlanadi.\n' +
    '- Mavjud profilda allaqachon bor narsani takrorlamang.\n' +
    '- Yangi barqaror xulosa yo\'q bo\'lsa, faqat "YANGI_YOQ" deb yozing, boshqa hech narsa emas.\n' +
    '- Javobingiz FAQAT shu ro\'yxat bo\'lsin (Vazifa 2\'ni bajargan bo\'lsangiz ham, unga izoh yozmang) — kirish/xulosa gapi yo\'q.';

  const reply = await askAgent(prompt);

  // Agent hech qanday javob bermasa (timeout/xatolik) — bu "yangi naqsh
  // yo'q" bilan bir xil emas. Shu kunni "bajarilgan" deb belgilamaymiz,
  // shunda keyingi safar qayta urinib ko'riladi (aks holda vaqtinchalik
  // xatolik tufayli o'sha kun butunlay o'tkazib yuborilgan bo'lardi).
  if (!reply) {
    return { status: 'error', date, message: 'agentdan javob kelmadi (qayta uriniladi)' };
  }

  state.done.push(date);
  if (state.done.length > 90) state.done = state.done.slice(-90);
  saveState(state);

  if (reply.includes('YANGI_YOQ')) {
    return { status: 'ok', date, learned: null };
  }

  const lines = reply.split('\n').map(l => l.trim()).filter(l => l.startsWith('-'));
  if (!lines.length) return { status: 'ok', date, learned: null };

  // updateProfile qiymat oldiga "- " qo'shadi — takror chiziqcha bo'lmasin
  const value = lines.map(l => l.replace(/^-\s*/, '')).join('\n- ');
  mem.updateProfile('O\'rganilgan naqshlar — ' + date, value, 'avtomatik kuzatuv');
  return { status: 'ok', date, learned: lines };
}

async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (e) {}
  try {
    const result = await synthesize(input.date || yesterday());
    console.log(JSON.stringify(result));
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message || String(e) }));
  }
}

if (require.main === module) main();

module.exports = { synthesize, yesterday };
