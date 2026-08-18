#!/usr/bin/env node
/**
 * FAST ACTIONS — tez-tez ishlatiladigan oddiy amallar (dastur ochish,
 * ovoz, ekran surati, ma'lumot so'rash) uchun to'liq agent (openclaw
 * agent, LLM fikrlash zanjiri) ISHGA TUSHIRMASDAN, to'g'ridan-to'g'ri
 * tizim buyrug'i orqali bajariladi — natija soniyaning ulushida qaytadi
 * (run_task orqali bajarilsa 10-25s ketishi mumkin bo'lgan narsa).
 *
 * Ikki qatlam: `actions.json` — qo'lda tekshirilgan, git'ga committed
 * asosiy ro'yxat; `.fast-actions-learned.json` — Jarvisning o'zi vaqt
 * o'tishi bilan (jarvis_daemon.js'dagi davriy tekshiruv orqali)
 * qo'shadigan yangi yozuvlar (faqat xavfsiz "open_app" turi bilan
 * cheklangan — ixtiyoriy shell buyruqlarini avtomatik qo'shmaydi).
 */
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const PROJECT_DIR = '/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS';
const BASE_FILE = path.join(__dirname, 'actions.json');
const LEARNED_FILE = path.join(PROJECT_DIR, '.fast-actions-learned.json');

function loadActions() {
  let base = [];
  try { base = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')); } catch (e) {}
  let learned = [];
  try { learned = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8')); } catch (e) {}
  const seen = new Set(base.map(a => a.id));
  const merged = base.slice();
  for (const a of learned) if (!seen.has(a.id)) { merged.push(a); seen.add(a.id); }
  return merged;
}

function findAction(id) {
  return loadActions().find(a => a.id === id);
}

function runFastAction(id) {
  return new Promise((resolve) => {
    const a = findAction(id);
    if (!a) { resolve({ status: 'error', message: "Noma'lum action: " + id }); return; }

    const done = (status, message) => resolve({ status, message, id, uz: a.uz });

    try {
      switch (a.type) {
        case 'open_app':
          execFile('open', ['-a', a.target], (err) => {
            if (err) done('error', a.target + " topilmadi yoki ochilmadi");
            else done('ok', a.uz + ' — bajarildi');
          });
          break;
        case 'open_url':
          execFile('open', [a.target], (err) => {
            if (err) done('error', 'Ochib bo\'lmadi: ' + a.target);
            else done('ok', a.uz + ' — bajarildi');
          });
          break;
        case 'applescript':
          execFile('osascript', ['-e', a.target], (err) => {
            if (err) done('error', 'AppleScript xatolik: ' + (err.message || '').slice(0, 200));
            else done('ok', a.uz + ' — bajarildi');
          });
          break;
        case 'shell':
          execFile('/bin/bash', ['-c', a.target], (err, stdout) => {
            if (err) done('error', 'Buyruq xatolik: ' + (err.message || '').slice(0, 200));
            else done('ok', (stdout || '').trim() || (a.uz + ' — bajarildi'));
          });
          break;
        case 'screenshot': {
          const args = a.target === 'clipboard' ? ['-c'] : ['-x', path.join(require('os').homedir(), 'Desktop', 'jarvis-screenshot-' + Date.now() + '.png')];
          execFile('screencapture', args, (err) => {
            if (err) done('error', 'Skrinshot olinmadi: ' + err.message);
            else done('ok', a.target === 'clipboard' ? 'Skrinshot olindi, clipboard\'da' : 'Skrinshot olindi, Desktop\'ga saqlandi');
          });
          break;
        }
        default:
          done('error', "Noma'lum action turi: " + a.type);
      }
    } catch (e) {
      done('error', e.message);
    }
  });
}

// Faqat "open_app" turi avtomatik o'rganiladi — bu eng past xavfli
// (mavjud bo'lmagan ilova nomi shunchaki xato qaytaradi, hech qanday
// zararli ta'sir yo'q). Ixtiyoriy shell/applescript buyruqlar hech
// qachon avtomatik qo'shilmaydi.
function learnOpenAppAction(appName) {
  if (!appName || typeof appName !== 'string') return { status: 'error' };
  const clean = appName.trim();
  if (!clean) return { status: 'error' };
  const id = 'open:learned:' + clean.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const existing = loadActions();
  if (existing.some(a => a.id === id || (a.type === 'open_app' && a.target.toLowerCase() === clean.toLowerCase()))) {
    return { status: 'duplicate' };
  }
  let learned = [];
  try { learned = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8')); } catch (e) {}
  learned.push({ id, uz: clean + ' ochish', type: 'open_app', target: clean, learnedAt: new Date().toISOString() });
  fs.writeFileSync(LEARNED_FILE, JSON.stringify(learned, null, 2));
  return { status: 'ok', id };
}

function actionIds() {
  return loadActions().map(a => a.id);
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (e) {}
  (async () => {
    let result;
    switch (input.action) {
      case 'run': result = await runFastAction(input.id); break;
      case 'list': result = { status: 'ok', actions: loadActions() }; break;
      case 'learn_app': result = learnOpenAppAction(input.appName); break;
      default: result = { status: 'error', message: 'Noma\'lum action: ' + input.action };
    }
    console.log(JSON.stringify(result));
  })();
}

if (require.main === module) main();

module.exports = { runFastAction, loadActions, actionIds, learnOpenAppAction, findAction };
