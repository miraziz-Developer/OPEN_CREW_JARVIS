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
const { execFile } = require('child_process');

const { PROJECT_DIR } = require('../../core/paths');
const BASE_FILE = path.join(__dirname, 'actions.json');
const LEARNED_FILE = path.join(PROJECT_DIR, '.fast-actions-learned.json');

let cachedActions = [];
let actionsReady = null;

async function refreshActions() {
  const [baseResult, learnedResult] = await Promise.all([
    fs.promises.readFile(BASE_FILE, 'utf8').catch(() => '[]'),
    fs.promises.readFile(LEARNED_FILE, 'utf8').catch(() => '[]')
  ]);
  let base = [];
  let learned = [];
  try { base = JSON.parse(baseResult); } catch (_) {}
  try { learned = JSON.parse(learnedResult); } catch (_) {}
  const seen = new Set(base.map(a => a.id));
  const merged = base.slice();
  for (const a of learned) if (!seen.has(a.id)) { merged.push(a); seen.add(a.id); }
  cachedActions = merged;
  return cachedActions;
}

function preloadActions() {
  if (!actionsReady) actionsReady = refreshActions().catch(() => cachedActions);
  return actionsReady;
}

let syncFallbackTried = false;

function loadActionsSync() {
  let base = [];
  let learned = [];
  try { base = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')); } catch (_) {}
  try { learned = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8')); } catch (_) {}
  const seen = new Set(base.map(a => a.id));
  const merged = base.slice();
  for (const a of learned) if (!seen.has(a.id)) { merged.push(a); seen.add(a.id); }
  return merged;
}

function loadActions() {
  // Realtime yo'li xotiradagi nusxani oladi; asinxron preload modul yuklanganda boshlanadi. Modul aynan shu
  // sessiya ochilayotganda birinchi marta yuklansa, nusxa hali bo'sh bo'ladi va fast_action tool'i ro'yxatsiz
  // qolib, JARVIS oddiy amallarni sekin run_task'ga yuborardi — shuning uchun bo'sh bo'lsa bir marta sinxron o'qiymiz.
  if (!cachedActions.length && !syncFallbackTried) {
    syncFallbackTried = true;
    const merged = loadActionsSync();
    if (merged.length) cachedActions = merged;
  }
  return cachedActions;
}
preloadActions();

function setProtocolState(mode, name, color) {
  try {
    fs.writeFileSync(path.join(PROJECT_DIR, '.jarvis-protocol.json'), JSON.stringify({
      mode,
      name,
      color,
      at: Date.now()
    }, null, 2));
  } catch (_) {}
}

function findProject(name) {
  const os = require('os');
  const home = os.homedir();
  const searchDirs = [path.join(home, 'projects'), home];
  
  if (!name || name === 'latest' || name === 'recent') {
    let best = null;
    let bestTime = 0;
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
          const full = path.join(dir, ent.name);
          try {
            const stat = fs.statSync(full);
            if (stat.mtimeMs > bestTime) {
              if (fs.existsSync(path.join(full, '.git')) || fs.existsSync(path.join(full, 'package.json')) || fs.existsSync(path.join(full, 'requirements.txt'))) {
                bestTime = stat.mtimeMs;
                best = { path: full, name: ent.name };
              }
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
    return best || { path: path.join(home, 'OPEN_CREW_JARVIS'), name: 'OPEN_CREW_JARVIS' };
  }

  const clean = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const entClean = ent.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (entClean.includes(clean) || clean.includes(entClean)) {
          return { path: path.join(dir, ent.name), name: ent.name };
        }
      }
    } catch (_) {}
  }
  const words = String(name).toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 3);
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const entLower = ent.name.toLowerCase();
        if (words.some(w => entLower.includes(w) || entLower.includes(w.slice(0, 5)))) {
          return { path: path.join(dir, ent.name), name: ent.name };
        }
      }
    } catch (_) {}
  }
  return { path: path.join(home, 'OPEN_CREW_JARVIS'), name: 'OPEN_CREW_JARVIS' };
}

function findAction(id) {
  const dynamicVol = String(id || '').match(/^volume:(\d+)$/);
  if (dynamicVol) {
    const level = Math.min(100, Math.max(0, parseInt(dynamicVol[1], 10)));
    return {
      id: `volume:${level}`,
      en: `Volume set to ${level}%.`,
      uz: `Ovoz ${level}% ga sozlandi`,
      type: 'applescript',
      target: `set volume output volume ${level}`
    };
  }
  if (id === 'protocol:combat') {
    return {
      id: 'protocol:combat',
      en: 'Combat mode engaged, sir. All defense protocols active and systems online.',
      uz: 'Jang rejimi faollashtirildi, ser. Barcha himoya protokollari shay holatda.',
      type: 'protocol',
      mode: 'combat',
      name: 'Combat Protocol 07',
      color: '#ff3b30',
      sound: '/System/Library/Sounds/Hero.aiff',
      script: 'tell application "System Events" to tell appearance preferences to set dark mode to true\nset volume output volume 85'
    };
  }
  if (id === 'protocol:standby') {
    return {
      id: 'protocol:standby',
      en: 'Standing down. Systems back to nominal standby.',
      uz: 'Standart rejimga qaytildi. Tizimlar barqaror holatda.',
      type: 'protocol',
      mode: 'standby',
      name: 'Nominal Standby',
      color: '#00e5ff',
      sound: '/System/Library/Sounds/Ping.aiff',
      script: 'set volume output volume 50'
    };
  }
  if (id === 'protocol:lockdown') {
    return {
      id: 'protocol:lockdown',
      en: 'Lockdown protocol executed. Standing by for biometric authorization.',
      uz: 'Tizim to\'liq qulflandi. Biometrik tasdiq kutilmoqda.',
      type: 'protocol',
      mode: 'lockdown',
      name: 'Emergency Lockdown',
      color: '#ff2a2a',
      sound: '/System/Library/Sounds/Sosumi.aiff',
      shell: 'sleep 1 && pmset displaysleepnow'
    };
  }
  if (id === 'protocol:focus') {
    return {
      id: 'protocol:focus',
      en: 'Focus mode engaged. Minimizing background distractions.',
      uz: 'Fokus rejimi yoqildi. Chalg\'ituvchi omillar cheklandi.',
      type: 'protocol',
      mode: 'focus',
      name: 'Deep Focus',
      color: '#a855f7',
      sound: '/System/Library/Sounds/Purr.aiff',
      script: 'set volume output volume 35'
    };
  }
  if (id === 'tasks:list') {
    return {
      id: 'tasks:list',
      uz: "Bugungi vazifalar ro'yxati",
      en: 'Daily tasks list',
      type: 'custom',
      handler: async () => {
        const tasks = require('../tasks');
        const list = tasks.listTasks().tasks;
        const pending = list.filter(t => !t.done);
        if (!pending.length) {
          return { status: 'ok', uz: 'Bugungi barcha vazifalar bajarilgan, ser.', en: 'All daily tasks are completed, sir.' };
        }
        const formatTask = (txt) => {
          const parts = txt.split(/—|\./);
          if (parts.length > 1 && parts[0].length < 60) {
            return (parts[0].trim() + ' — ' + (parts[1] || '').trim()).slice(0, 100);
          }
          return txt.length > 90 ? (txt.slice(0, 87) + '...') : txt;
        };
        const summary = pending.map((t, idx) => `${idx + 1}-vazifa: ${formatTask(t.text)}`).join('. ');
        return {
          status: 'ok',
          uz: `Bugungi kutilayotgan ${pending.length} ta vazifangiz bor: ${summary}.`,
          en: `You have ${pending.length} pending tasks: ${summary}.`
        };
      }
    };
  }
  if (id === 'dev:git_status') {
    return {
      id: 'dev:git_status',
      uz: 'Git status tekshirish',
      en: 'Git status check',
      type: 'custom',
      handler: async () => {
        const { exec } = require('child_process');
        return new Promise((resolve) => {
          exec('cd /Users/mirazizerkinaliyev_dev/OPEN_CREW_JARVIS && git status --short', (err, stdout) => {
            if (err) {
              resolve({ status: 'error', uz: 'Git tekshirishda xatolik: ' + err.message, en: 'Git error: ' + err.message });
              return;
            }
            const lines = (stdout || '').trim().split('\n').filter(Boolean);
            if (!lines.length) {
              resolve({ status: 'ok', uz: 'Git toza, kiritilmagan o\'zgarishlar yo\'q.', en: 'Git working tree is clean, no uncommitted changes.' });
            } else {
              resolve({ status: 'ok', uz: `Gitda ${lines.length} ta o'zgargan fayl bor.`, en: `Git working tree has ${lines.length} modified files.` });
            }
          });
        });
      }
    };
  }
  const workMatch = String(id || '').match(/^workspace:start_work(?::(.+))?$/);
  if (workMatch) {
    const projQuery = workMatch[1] || 'latest';
    const proj = findProject(projQuery);
    return {
      id: `workspace:start_work`,
      uz: `Ish rejimini faollashtirish (${proj.name})`,
      en: `Work mode engaged (${proj.name})`,
      type: 'custom',
      handler: async () => {
        setProtocolState('focus', 'Deep Focus', '#a855f7');
        const { exec } = require('child_process');
        exec('open "http://localhost:7890"');
        exec(`open -a "Visual Studio Code" "${proj.path}"`);
        exec('open -a "Claude"');
        exec('open -a "Antigravity"');
        exec('osascript -e "set volume output volume 45"');
        exec('open "https://www.youtube.com/watch?v=Zi_XLOBDo_Y"');
        return {
          status: 'ok',
          uz: `Ish rejimi faollashtirildi, ser. Dashboard tayyor, ${proj.name} loyihasi VS Code'da ochildi, Claude va Antigravity ishga tushirildi, hamda Billie Jean ijro etilmoqda.`,
          en: `Work mode engaged, sir. Dashboard online, project ${proj.name} loaded in Visual Studio Code, Claude and Antigravity launched, and Billie Jean is playing. Ready for work.`
        };
      }
    };
  }

  const openProjMatch = String(id || '').match(/^workspace:open_project(?::(.+))?$/);
  if (openProjMatch) {
    const projQuery = openProjMatch[1] || 'latest';
    const proj = findProject(projQuery);
    return {
      id: `workspace:open_project`,
      uz: `${proj.name} loyihasini ochish`,
      en: `Opening project ${proj.name}`,
      type: 'custom',
      handler: async () => {
        const { exec } = require('child_process');
        exec(`open -a "Visual Studio Code" "${proj.path}"`);
        return {
          status: 'ok',
          uz: `${proj.name} loyihasi Visual Studio Code'da ochildi.`,
          en: `Project ${proj.name} opened in Visual Studio Code, sir.`
        };
      }
    };
  }

  if (id === 'workspace:coding') {
    return {
      id: 'workspace:coding',
      uz: 'Dasturlash muhitini ishga tushirish',
      en: 'Preparing developer workspace',
      type: 'custom',
      handler: async () => {
        setProtocolState('focus', 'Deep Focus', '#a855f7');
        const { exec } = require('child_process');
        exec('open -a "Visual Studio Code" /Users/mirazizerkinaliyev_dev/OPEN_CREW_JARVIS && osascript -e "set volume output volume 40"');
        return { status: 'ok', uz: 'Dasturlash muhiti tayyorlandi, VS Code ochildi va fokus rejimi yoqildi.', en: 'Developer workspace ready. Visual Studio Code opened and focus mode engaged.' };
      }
    };
  }
  if (id === 'info:diagnostics') {
    return {
      id: 'info:diagnostics',
      uz: 'Tizim diagnostikasi',
      en: 'System diagnostics',
      type: 'custom',
      handler: async () => {
        const { exec } = require('child_process');
        return new Promise((resolve) => {
          exec("BATT=$(pmset -g batt | grep -Eo '[0-9]+%' | head -1); DISK=$(df -h / | tail -1 | awk '{print $4}'); UPTIME=$(uptime | sed 's/.*up //;s/,.*load.*//'); echo \"Batareya: $BATT, Bo'sh disk: $DISK, Ish vaqti: $UPTIME\"", (err, stdout) => {
            const out = (stdout || '').trim();
            resolve({ status: 'ok', uz: `Tizim holati: ${out}`, en: `System diagnostics: ${out}` });
          });
        });
      }
    };
  }
  return loadActions().find(a => a.id === id);
}

function runFastAction(id) {
  return new Promise((resolve) => {
    preloadActions().then(async () => {
      const a = findAction(id);
      if (!a) { resolve({ status: 'error', message: "Noma'lum action: " + id }); return; }

    const done = (status, message) => resolve({ status, message, id, uz: a.uz });

      try {
      switch (a.type) {
        case 'custom': {
          if (typeof a.handler === 'function') {
            const res = await a.handler();
            done(res.status || 'ok', res.uz || res.en || res.message || 'Bajarildi');
          } else {
            done('error', 'Handler topilmadi');
          }
          break;
        }
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
            else done('ok', a.en || (a.uz + ' — bajarildi'));
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
        case 'protocol': {
          setProtocolState(a.mode, a.name, a.color);
          if (a.sound) {
            execFile('afplay', [a.sound], () => {});
          }
          if (a.script) {
            execFile('osascript', ['-e', a.script], () => {
              if (a.shell) execFile('/bin/bash', ['-c', a.shell], () => {});
              done('ok', a.en);
            });
          } else if (a.shell) {
            execFile('/bin/bash', ['-c', a.shell], () => {});
            done('ok', a.en);
          } else {
            done('ok', a.en);
          }
          break;
        }
        default:
          done('error', "Noma'lum action turi: " + a.type);
      }
      } catch (e) {
        done('error', e.message);
      }
    });
  });
}

// Faqat "open_app" turi avtomatik o'rganiladi — bu eng past xavfli
// (mavjud bo'lmagan ilova nomi shunchaki xato qaytaradi, hech qanday
// zararli ta'sir yo'q). Ixtiyoriy shell/applescript buyruqlar hech
// qachon avtomatik qo'shilmaydi.
async function learnOpenAppAction(appName) {
  if (!appName || typeof appName !== 'string') return { status: 'error' };
  const clean = appName.trim();
  if (!clean) return { status: 'error' };
  const id = 'open:learned:' + clean.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const existing = await preloadActions();
  if (existing.some(a => a.id === id || (a.type === 'open_app' && a.target.toLowerCase() === clean.toLowerCase()))) {
    return { status: 'duplicate' };
  }
  let learned = [];
  try { learned = JSON.parse(await fs.promises.readFile(LEARNED_FILE, 'utf8')); } catch (_) {}
  learned.push({ id, uz: clean + ' ochish', type: 'open_app', target: clean, learnedAt: new Date().toISOString() });
  await fs.promises.writeFile(LEARNED_FILE, JSON.stringify(learned, null, 2));
  await refreshActions();
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
      case 'learn_app': result = await learnOpenAppAction(input.appName); break;
      default: result = { status: 'error', message: 'Noma\'lum action: ' + input.action };
    }
    console.log(JSON.stringify(result));
  })();
}

if (require.main === module) main();

module.exports = { runFastAction, loadActions, actionIds, learnOpenAppAction, findAction };
