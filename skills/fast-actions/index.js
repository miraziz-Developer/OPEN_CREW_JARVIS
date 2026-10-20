#!/usr/bin/env node
/**
 * FAST ACTIONS: common simple actions (opening apps, volume, screenshots, info
 * queries) run directly as system commands WITHOUT starting the full agent
 * (openclaw agent, LLM reasoning chain), returning in a fraction of a second
 * (the same thing through run_task can take 10-25 s).
 *
 * Two layers: `actions.json` is the hand-reviewed base list committed to git;
 * `.fast-actions-learned.json` holds entries JARVIS adds over time (via the
 * periodic check in jarvis_daemon.js). Learned entries are limited to the safe
 * "open_app" type; arbitrary shell commands are never added automatically.
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
  // The realtime path reads the in-memory copy; the async preload starts when the module loads. If the module is
  // first loaded exactly while a session opens, the copy is still empty, the fast_action tool has no list and JARVIS
  // would send simple actions to the slow run_task. So an empty copy is read once synchronously.
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
      en: 'Combat protocol: security and system sweep (firewall, encryption, open ports, disk, battery, memory, internet, JARVIS services)',
      uz: 'Jang rejimi: xavfsizlik va tizim tekshiruvi',
      type: 'protocol',
      mode: 'combat',
      name: 'Combat Protocol 07',
      color: '#ff3b30',
      sound: '/System/Library/Sounds/Hero.aiff',
      run: 'combatSweep'
    };
  }
  if (id === 'protocol:standby') {
    return {
      id: 'protocol:standby',
      en: 'Standby: return to normal and undo lockdown (restore audio, resume paused missions)',
      uz: 'Standart rejim: qulflashni bekor qilish',
      type: 'protocol',
      mode: 'standby',
      name: 'Nominal Standby',
      color: '#00e5ff',
      sound: '/System/Library/Sounds/Ping.aiff',
      run: 'standby'
    };
  }
  if (id === 'protocol:lockdown') {
    return {
      id: 'protocol:lockdown',
      en: 'Lockdown: lock the Mac screen, mute audio and pause running missions',
      uz: 'Qulflash: ekranni qulflash, ovozni o\'chirish, missiyalarni to\'xtatish',
      type: 'protocol',
      mode: 'lockdown',
      name: 'Emergency Lockdown',
      color: '#ff2a2a',
      sound: '/System/Library/Sounds/Sosumi.aiff',
      run: 'lockdown'
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
        const summary = pending.map((t, idx) => `${idx + 1}. ${formatTask(t.text)}`).join('. ');
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
        const { execFile } = require('child_process');
        return new Promise((resolve) => {
          execFile('git', ['status', '--short'], { cwd: PROJECT_DIR }, (err, stdout) => {
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
        const { execFile } = require('child_process');
        execFile('open', ['-a', 'Visual Studio Code', PROJECT_DIR], () => {});
        execFile('osascript', ['-e', 'set volume output volume 40'], () => {});
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
          exec("BATT=$(pmset -g batt | grep -Eo '[0-9]+%' | head -1); DISK=$(df -h / | tail -1 | awk '{print $4}'); UPTIME=$(uptime | sed 's/.*up //;s/,.*load.*//'); echo \"Battery: $BATT, free disk: $DISK, uptime: $UPTIME\"", (err, stdout) => {
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
      if (!a) { resolve({ status: 'error', message: 'Unknown action: ' + id }); return; }

    const label = a.en || a.uz || a.id;
    const done = (status, message, details) => resolve({ status, message, id, uz: a.uz, en: a.en, ...(details ? { details } : {}) });

      try {
      switch (a.type) {
        case 'custom': {
          if (typeof a.handler === 'function') {
            const res = await a.handler();
            done(res.status || 'ok', res.en || res.message || res.uz || 'Done');
          } else {
            done('error', 'Handler not found');
          }
          break;
        }
        case 'open_app':
          execFile('open', ['-a', a.target], (err) => {
            if (err) done('error', a.target + ' was not found or could not be opened');
            else done('ok', label + ': done');
          });
          break;
        case 'open_url':
          execFile('open', [a.target], (err) => {
            if (err) done('error', 'Could not open: ' + a.target);
            else done('ok', label + ': done');
          });
          break;
        case 'applescript':
          execFile('osascript', ['-e', a.target], (err) => {
            if (err) done('error', 'AppleScript error: ' + (err.message || '').slice(0, 200));
            else done('ok', label + ': done');
          });
          break;
        case 'shell':
          execFile('/bin/bash', ['-c', a.target], (err, stdout) => {
            if (err) done('error', 'Command error: ' + (err.message || '').slice(0, 200));
            else done('ok', (stdout || '').trim() || (label + ': done'));
          });
          break;
        case 'screenshot': {
          const args = a.target === 'clipboard' ? ['-c'] : ['-x', path.join(require('os').homedir(), 'Desktop', 'jarvis-screenshot-' + Date.now() + '.png')];
          execFile('screencapture', args, (err) => {
            if (err) done('error', 'Screenshot failed: ' + err.message);
            else done('ok', a.target === 'clipboard' ? 'Screenshot copied to the clipboard' : 'Screenshot saved to the Desktop');
          });
          break;
        }
        case 'protocol': {
          setProtocolState(a.mode, a.name, a.color);
          if (a.sound) {
            execFile('afplay', [a.sound], () => {});
          }
          if (a.run) {
            // Real protocols (core/protocols.js) report what they actually found or changed.
            require('../../core/protocols')[a.run]()
              .then(result => done('ok', result.summary, result))
              .catch(error => done('error', `${a.name} failed: ${error.message}`));
          } else if (a.script) {
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

// Only the "open_app" type is learned automatically: it is the lowest risk (an
// unknown app name simply returns an error, with no harmful effect). Arbitrary
// shell/AppleScript commands are never added automatically.
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
