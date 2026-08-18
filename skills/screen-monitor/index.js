#!/usr/bin/env node
/**
 * SCREEN MONITOR Skill — Trigger-asosli ekran kuzatuv
 * Har N soniyada skrinshot + piksel diff
 * Farq > threshold bo'lsa LLM tahliliga yuboradi
 * Foydalanuvchini bezovta qilmaydi (faqat log/memory)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_DIR = '/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS';
const STATE_FILE = path.join(PROJECT_DIR, '.screen-monitor-state');
const LAST_SCREENSHOT = '/tmp/jarvis_prev_screen.png';
const CUR_SCREENSHOT = '/tmp/jarvis_curr_screen.png';

// ── Config (.env dan) ─────────────────────────────────────────────────
const ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8');
function getEnv(key, def) {
  const m = ENV.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim() : def;
}

const INTERVAL_MS = parseInt(getEnv('SCREEN_MONITOR_INTERVAL', '90000'), 10); // 90s default
const DIFF_THRESHOLD = parseFloat(getEnv('SCREEN_MONITOR_THRESHOLD', '15'));   // 15% default
const ENABLED = getEnv('SCREEN_MONITOR_ENABLED', 'true') === 'true';

// ── State ─────────────────────────────────────────────────────────────
let isRunning = false;
let lastLLMCall = 0;
// Oxirgi old oynani process xotirasida saqlaymiz. Rekonstruksiya qilingan
// versiyada ishlatilishi qolib, deklaratsiyasi yo'qolgan edi; birinchi diff
// paytida ReferenceError berib monitorni foydasiz error-loopga tushirardi.
let lastFrontWindow = null;
let llmCooldownMs = parseInt(getEnv('SCREEN_MONITOR_VISION_COOLDOWN', '120000'), 10); // vision chaqiruvlar orasidagi minimal oraliq

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return { enabled: s.enabled !== false, lastTrigger: s.lastTrigger || 0, lastSummary: s.lastSummary || '' };
    }
  } catch (e) {}
  return { enabled: ENABLED, lastTrigger: 0, lastSummary: '' };
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ── Screenshot ────────────────────────────────────────────────────────
function takeScreenshot(outPath) {
  try {
    execSync('screencapture -x "' + outPath + '"');
    return fs.existsSync(outPath);
  } catch (e) { return false; }
}

// ── Piksel diff (ImageMagick yoki oddiy) ──────────────────────────────
function pixelDiff(prevPath, currPath) {
  // ImageMagick compare
  try {
    const result = execSync('compare -metric MAE "' + prevPath + '" "' + currPath + '" /tmp/jarvis_diff.png 2>&1', { encoding: 'utf8', timeout: 10000 });
    // Output: 1234.56 (0.0188321) yoki shunga o'xshash
    const match = result.match(/\(([^)]+)\)/);
    if (match) {
      const normalizedDiff = parseFloat(match[1]) * 100; // 0.0188 -> 1.88%
      return normalizedDiff;
    }
  } catch (e) {
    // ImageMagick yo'q bo'lsa
  }

  // Fallback: oddiy piksel diff (yoki JavaScript'da)
  try {
    // Oddiy file size diff
    const s1 = fs.statSync(prevPath).size;
    const s2 = fs.statSync(currPath).size;
    const max = Math.max(s1, s2);
    if (max === 0) return 100;
    return Math.abs(s1 - s2) / max * 100;
  } catch (e) { return 100; }
}

// ── Vision tahlil (haqiqiy skrinshotni gpt-4.1'ga yuboradi) ───────────
const { describeImage } = require('./../screen-vision/index.js');

async function analyzeScreen(imagePath) {
  const now = Date.now();
  if (now - lastLLMCall < llmCooldownMs) {
    return { status: 'cooldown', message: 'LLM cooldown faol' };
  }

  const prompt = 'Ekran skrinshotini batafsil tahlil qil — foydalanuvchi hozir aniq nima ish qilyapti? ' +
    'Agar bir nechta oyna/ilova ko\'rinsa, HAR BIRINI alohida yoz: qaysi ilova, unda aniq nima ' +
    '(fayl/loyiha nomi, qaysi kod/matn qismi, kim bilan qanday mavzuda gaplashilyapti, qaysi sayt/video va h.k.). ' +
    'Taxmin qilma, faqat aniq ko\'rinib turgan narsani yoz. Konkret va batafsil bo\'lsin, sayoz umumlashtirma. ' +
    'Agar faqat vaqt/soat o\'zgargan bo\'lsa yoki haqiqatan hech qanday mazmunli faoliyat yo\'q bo\'lsa — "hech narsa" deb javob ber.\n\n' +
    'MUHIM: agar ekranda foydalanuvchi DARHOL bilishi kerak bo\'lgan, chindan SHOSHILINCH narsa ko\'rinsa (masalan: ' +
    'xato/crash dialogi, xavfsizlik ogohlantirishi, "usage limit"/kvota tugagani, muhim muddat/deadline yaqinlashgani, ' +
    'to\'lov/hisob bilan bog\'liq ogohlantirish) — javobingizni ANIQ "SHOSHILINCH: " so\'zi bilan boshlang (masalan ' +
    '"SHOSHILINCH: Xcode build xato bilan to\'xtadi"). Oddiy, kutilgan ish jarayoni (kod yozish, brauzerda kezish, ' +
    'suhbat) uchun bu prefiksni HECH QACHON ishlatmang — faqat chindan g\'ayrioddiy, e\'tiborsiz qoldirilsa zarar ' +
    'keltirishi mumkin bo\'lgan holatlarda.';

  try {
    const summary = await describeImage(imagePath, prompt);
    lastLLMCall = Date.now();
    return { status: 'ok', summary };
  } catch (e) {
    lastLLMCall = Date.now();
    return { status: 'error', message: e.message || String(e) };
  }
}

// ── ARZON SIGNAL: old oyna (ilova + sarlavha) ────────────────────────
// Rasm ham, LLM ham kerak emas — ~0.5 soniya, narxi nol. Piksel farqi
// juda dag'al o'lchov: sahifani aylantirish, video ijrosi, matn yozish
// — hammasi katta farq beradi, holbuki foydalanuvchi AYNAN O'SHA ishni
// qilyapti. Shu sabab bugun 52 ta deyarli bir xil vision chaqiruvi
// (har biri pullik) va 52 ta takroriy xotira yozuvi hosil bo'lgan.
// Endi qimmat tahlil faqat KONTEKST chindan almashganda chaqiriladi.
const FRONT_WINDOW_SCRIPT = 'tell application "System Events"\n' +
  '  set frontApp to name of first application process whose frontmost is true\n' +
  '  set winName to ""\n' +
  '  try\n' +
  '    tell process frontApp to set winName to name of front window\n' +
  '  end try\n' +
  'end tell\n' +
  'return frontApp & " | " & winName';

function getFrontWindow() {
  try {
    // timeout: System Events ba'zan javob bermay qolishi mumkin — butun
    // kuzatuv halqasi shu sabab osilib qolmasin.
    return execSync('osascript -e ' + JSON.stringify(FRONT_WINDOW_SCRIPT) + ' 2>/dev/null',
      { encoding: 'utf8', timeout: 5000 }).trim();
  } catch (e) { return null; }
}

// ── Main loop ─────────────────────────────────────────────────────────
async function runLoop() {
  const state = loadState();
  if (!state.enabled) {
    console.log('Screen monitor o\'chirilgan (.screen-monitor-state)');
    return;
  }

  isRunning = true;
  console.log('Screen monitor ishga tushdi. Interval: ' + INTERVAL_MS + 'ms, Threshold: ' + DIFF_THRESHOLD + '%');

  while (isRunning) {
    try {
      const s = loadState();
      if (!s.enabled) { console.log('O\'chirildi'); break; }

      // 1. Skrinshot
      const ok = takeScreenshot(CUR_SCREENSHOT);
      if (!ok) { await sleep(INTERVAL_MS); continue; }

      // 2. Diff (birinchisi o'tkazib yuboriladi)
      if (fs.existsSync(LAST_SCREENSHOT)) {
        const diff = pixelDiff(LAST_SCREENSHOT, CUR_SCREENSHOT);
        const frontWindow = getFrontWindow();
        const contextChanged = frontWindow !== null && frontWindow !== lastFrontWindow;
        if (frontWindow !== null) lastFrontWindow = frontWindow;
        console.log('Diff: ' + diff.toFixed(2) + '% (threshold: ' + DIFF_THRESHOLD + '%)' +
          ' | oyna: ' + (frontWindow || '?') + (contextChanged ? ' [ALMASHDI]' : ''));

        // Qimmat vision tahlili faqat KONTEKST almashganda. Piksel farqi
        // katta bo'lsa-yu, foydalanuvchi o'sha ilova/oynada qolgan bo'lsa —
        // bu yangi ma'lumot emas (aylantirish, video, yozish), o'tkazamiz.
        if (diff > DIFF_THRESHOLD && contextChanged) {
          console.log('  ⚠️ TRIGGER: kontekst almashdi (' + diff.toFixed(1) + '%)');

          // 3. Tahlil (faqat katta o'zgarishda)
          const analysis = await analyzeScreen(CUR_SCREENSHOT);
          if (analysis.status === 'ok' && analysis.summary && analysis.summary.length > 5) {
            const timestamp = new Date().toISOString();
            const logEntry = timestamp + ' | DIFF=' + diff.toFixed(1) + '% | ' + analysis.summary + '\n';

            // "SHOSHILINCH:" prefiksi bo'lsa, alohida #urgent teg bilan
            // belgilanadi — jarvis_daemon.js buni tez-tez (30 daqiqalik
            // umumiy proaktiv tsikldan farqli, bir necha daqiqada) tekshirib,
            // DARHOL ovozli xabar berish uchun ishlatadi.
            const urgentMatch = analysis.summary.match(/^SHOSHILINCH:\s*/i);
            const cleanSummary = urgentMatch ? analysis.summary.slice(urgentMatch[0].length).trim() : analysis.summary;
            const tags = urgentMatch ? ['screen', 'trigger', 'auto', 'urgent'] : ['screen', 'trigger', 'auto'];

            // Memory'ga yozish
            try {
              const memPath = path.join(PROJECT_DIR, 'skills', 'memory', 'index.js');
              if (fs.existsSync(memPath)) {
                const mem = require(memPath);
                mem.writeMemory('Ekran o\'zgarishi', cleanSummary, tags);
              }
            } catch (e) {}

            // State yangilash
            state.lastTrigger = Date.now();
            state.lastSummary = cleanSummary;
            saveState(state);

            // Telegram'ga YUBORMAYMIZ (foydalanuvchini bezovta qilmaydi)
            // Faqat console.log
            console.log('  📋 Tahlil:', analysis.summary.substring(0, 120));
          }
        }
      }

      // 4. Almashtirish
      try { fs.copyFileSync(CUR_SCREENSHOT, LAST_SCREENSHOT); } catch (e) {}

    } catch (e) {
      console.error('Screen monitor xatolik:', e.message);
    }

    await sleep(INTERVAL_MS);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── On/Off ────────────────────────────────────────────────────────────
function setEnabled(val) {
  const s = loadState();
  s.enabled = val;
  saveState(s);
  console.log('Screen monitor:', val ? 'YONDI ✅' : 'O\'CHDI ❌');
}

// ── CLI ───────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const input = fs.readFileSync(0, 'utf8').trim();
  let payload = {};
  try { payload = JSON.parse(input); } catch (e) {}

  const action = payload.action || args[0] || 'status';

  switch (action) {
    case 'start':
      setEnabled(true);
      runLoop();
      break;
    case 'stop':
      setEnabled(false);
      isRunning = false;
      console.log(JSON.stringify({ status: 'ok', enabled: false }));
      break;
    case 'status':
      const s = loadState();
      console.log(JSON.stringify({ status: 'ok', enabled: s.enabled, lastTrigger: s.lastTrigger, lastSummary: s.lastSummary }));
      break;
    case 'toggle':
      const st = loadState();
      setEnabled(!st.enabled);
      console.log(JSON.stringify({ status: 'ok', enabled: !st.enabled }));
      break;
    default:
      console.log(JSON.stringify({ status: 'error', message: 'Noma\'lum action: ' + action }));
  }
}

if (require.main === module) main();

module.exports = { runLoop, setEnabled, pixelDiff, loadState };
