#!/usr/bin/env node
/**
 * SCREEN MONITOR Skill — Trigger-asosli ekran kuzatuv
 * Har N soniyada skrinshot + piksel diff
 * Farq > threshold bo'lsa LLM tahliliga yuboradi
 * Foydalanuvchini bezovta qilmaydi (faqat log/memory)
 */

const { spawn, execSync } = require('child_process');
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
const AZURE_OPENAI_KEY = getEnv('AZURE_OPENAI_KEY');

// ── State ─────────────────────────────────────────────────────────────
let isRunning = false;
let lastLLMCall = 0;
let llmCooldownMs = 300000; // 5 daqiqa cooldown (LLM chaqirish orasida)

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

// ── LLM tahlil (odda, faqat muhim hodisalar uchun) ────────────────────
async function analyzeScreen(imagePath) {
  // Hozircha oddiy: desktop control orqali o'tkazamiz
  // Lekin desktop control screenshot + analysis
  // Soddalashtirish: faqat logga yozamiz, ovoz chiqarmaymiz

  const now = Date.now();
  if (now - lastLLMCall < llmCooldownMs) {
    return { status: 'cooldown', message: 'LLM cooldown faol' };
  }

  // Desktop control orqali so'rash
  return new Promise((resolve) => {
    const prompt = '[SYSTEM: Ekran skrinshotini ko\'rib, nima o\'zgarishini qisqa (3-5 gap) yoz. Faqat muhim narsalarni ayt. Agar faqat vaqt/soat o\'zgargan bo\'lsa "hech narsa" deb javob ber.]';
    const env = { ...process.env, AZURE_OPENAI_KEY };
    const proc = spawn('openclaw', ['agent', '--message', prompt, '--agent', 'main'], {
      cwd: PROJECT_DIR, env, timeout: 30000
    });
    let out = '';
    proc.stdout.on('data', d => (out += d.toString()));
    proc.stderr.on('data', d => {});
    proc.on('close', () => {
      const clean = out.split('\n').filter(l => l.trim() && !l.includes('Waiting') && !l.includes('◒')).join('\n').trim();
      lastLLMCall = Date.now();
      resolve({ status: 'ok', summary: clean });
    });
  });
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
        console.log('Diff: ' + diff.toFixed(2) + '% (threshold: ' + DIFF_THRESHOLD + '%)');

        if (diff > DIFF_THRESHOLD) {
          console.log('  ⚠️ TRIGGER: Ekran o\'zgarishi aniqlandi (' + diff.toFixed(1) + '%)');

          // 3. Tahlil (faqat katta o'zgarishda)
          const analysis = await analyzeScreen(CUR_SCREENSHOT);
          if (analysis.status === 'ok' && analysis.summary && analysis.summary.length > 5) {
            const timestamp = new Date().toISOString();
            const logEntry = timestamp + ' | DIFF=' + diff.toFixed(1) + '% | ' + analysis.summary + '\n';

            // Memory'ga yozish
            try {
              const memPath = path.join(PROJECT_DIR, 'skills', 'memory', 'index.js');
              if (fs.existsSync(memPath)) {
                const mem = require(memPath);
                mem.writeMemory('Ekran o\'zgarishi', analysis.summary, ['screen', 'trigger', 'auto']);
              }
            } catch (e) {}

            // State yangilash
            state.lastTrigger = Date.now();
            state.lastSummary = analysis.summary;
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
