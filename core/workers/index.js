'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PROJECT_DIR } = require('../paths');
const llm = require('../llm');

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function runProcess(command, args, options = {}) {
  const spawnFn = options.spawn || spawn;
  return new Promise(resolve => {
    let stdout = '', stderr = '', settled = false, lastActivity = Date.now();
    let proc, stallTimer;
    const killTree = () => {
      // Butun jarayon guruhini o'ldiramiz (interpreter/brauzer bolalari yetim qolmasin).
      try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) { try { proc.kill('SIGKILL'); } catch (__) {} }
    };
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(stallTimer); resolve(result); };
    try {
      proc = spawnFn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: options.detached !== false });
    } catch (error) { return resolve({ code: -1, stdout: '', stderr: error.message, timedOut: false }); }
    const timer = setTimeout(() => { killTree(); finish({ code: -1, stdout, stderr, timedOut: true }); }, options.timeoutMs || 20 * 60 * 1000);
    // Jim qolish: hech qanday chiqish bo'lmasa (LLM oqimi qotib qolgan) — kutib o'tirmaymiz.
    if (options.stallMs) {
      stallTimer = setInterval(() => {
        if (Date.now() - lastActivity > options.stallMs) { killTree(); finish({ code: -1, stdout, stderr, timedOut: true, stalled: true }); }
      }, Math.min(5000, Math.max(50, options.stallMs / 4)));
      stallTimer.unref?.();
    }
    proc.stdout.on('data', chunk => { lastActivity = Date.now(); stdout += chunk; if (stdout.length > 400000) stdout = stdout.slice(-200000); });
    proc.stderr.on('data', chunk => { lastActivity = Date.now(); stderr += chunk; if (stderr.length > 100000) stderr = stderr.slice(-50000); });
    proc.on('error', error => finish({ code: -1, stdout, stderr: stderr + error.message, timedOut: false }));
    proc.on('close', code => finish({ code, stdout, stderr, timedOut: false }));
    if (options.input !== undefined) { try { proc.stdin.write(options.input); } catch (_) {} }
    try { proc.stdin.end(); } catch (_) {}
  });
}

function cleanOutput(text) {
  return String(text || '').replace(ANSI, '').split('\n').filter(line => !/pkg_resources|UserWarning|^\s*$/.test(line)).join('\n').trim();
}

function parseJsonWorker(result, name) {
  const line = cleanOutput(result.stdout).split('\n').filter(l => l.trim().startsWith('{')).pop();
  if (result.timedOut) return { ok: false, output: '', error: result.stalled ? `${name} stalled (no output)` : `${name} timeout` };
  if (!line) return { ok: false, output: '', error: cleanOutput(result.stderr).slice(-400) || `${name} exit ${result.code}` };
  try {
    const parsed = JSON.parse(line);
    return { ok: Boolean(parsed.ok), output: String(parsed.output || '').slice(-6000), error: parsed.error || '' };
  } catch (error) { return { ok: false, output: '', error: `${name} javobi o'qilmadi` }; }
}

function workspace(mission) {
  const dir = path.join(PROJECT_DIR, '.run', 'missions', 'work', mission.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createWorkers(options = {}) {
  const env = options.env || llm.env;
  const spawnFn = options.spawn || spawn;
  const azureKey = () => env('AZURE_OPENAI_KEY');
  const azureBase = () => env('AZURE_OPENAI_ENDPOINT');
  const agentModel = () => env('MISSION_WORKER_MODEL', env('AZURE_OPENAI_DEPLOYMENT', 'gpt-5-mini'));

  // 1) To'liq OpenClaw agenti: barcha skill'lar (kalendar, pochta, Telegram, fayl, ilovalar, veb qidiruv, xotira)
  const agent = {
    async run({ prompt, mission, task, timeoutMs }) {
      const sessionKey = `agent:main:mission-${mission.id}-${task.id}`;
      const result = await runProcess('openclaw', ['agent', '--session-key', sessionKey, '--message', prompt, '--agent', 'main'], {
        spawn: spawnFn, cwd: PROJECT_DIR, timeoutMs, stallMs: 15 * 60 * 1000,
        env: { ...process.env, AZURE_OPENAI_KEY: azureKey(), JARVIS_PROJECT_DIR: PROJECT_DIR }
      });
      const output = cleanOutput(result.stdout);
      if (result.timedOut) return { ok: false, output, error: 'agent timeout' };
      if (result.code !== 0 || !output) return { ok: false, output, error: cleanOutput(result.stderr).slice(-400) || `agent exit ${result.code}` };
      return { ok: true, output };
    }
  };

  // 2) Open Interpreter: kod, terminal, skriptlar, fayllar, ma'lumot, lokal serverlar — Azure gpt-5-mini bilan.
  //    Python API orqali past reasoning_effort (CLI'da yo'q): ~8 s, avval ~200 s.
  const interpreter = {
    async run({ prompt, mission, timeoutMs }) {
      const cwd = workspace(mission);
      const brief = `Work in ${cwd} unless the task names another absolute path. Do not access secrets or credential stores. ` +
        `Do not send messages, publish, purchase, or delete data outside the task's scope. Finish with a concise summary of commands run, files changed and verified results.\n\nTask: ${prompt}`;
      const result = await runProcess(env('INTERPRETER_PYTHON', '/opt/homebrew/opt/python@3.11/bin/python3.11'), [path.join(__dirname, 'interpreter_worker.py')], {
        spawn: spawnFn, cwd, input: JSON.stringify({ task: brief, cwd }), timeoutMs, stallMs: parseInt(env('INTERPRETER_STALL_MS'), 10) || 180000,
        env: { ...process.env, OPENAI_API_KEY: azureKey(), OPENAI_API_BASE: azureBase(), INTERPRETER_MODEL: agentModel(), INTERPRETER_REASONING: env('INTERPRETER_REASONING', 'low'), PYTHONWARNINGS: 'ignore' }
      });
      const line = cleanOutput(result.stdout).split('\n').filter(l => l.trim().startsWith('{')).pop();
      if (result.timedOut) return { ok: false, output: '', error: result.stalled ? 'interpreter stalled (no output)' : 'interpreter timeout' };
      if (!line) return { ok: false, output: '', error: cleanOutput(result.stderr).slice(-400) || `interpreter exit ${result.code}` };
      try {
        const parsed = JSON.parse(line);
        return { ok: Boolean(parsed.ok), output: String(parsed.output || '').slice(-6000), error: parsed.error || '' };
      } catch (error) { return { ok: false, output: '', error: 'interpreter javobi o\'qilmadi' }; }
    }
  };

  // 3) Web Specialist: Browser-use + Playwright/Chromium (alohida Python muhit)
  const browser = {
    async run({ prompt, timeoutMs }) {
      const python = path.join(PROJECT_DIR, '.venv-workers', 'bin', 'python');
      if (!fs.existsSync(python)) return { ok: false, output: '', error: 'Browser-use o\'rnatilmagan (scripts/install-workers.sh)' };
      const result = await runProcess(python, [path.join(__dirname, 'browser_worker.py')], {
        spawn: spawnFn, cwd: PROJECT_DIR, timeoutMs, stallMs: 300000, input: JSON.stringify({ task: prompt, max_steps: 30, headless: env('BROWSER_WORKER_HEADLESS', 'true') !== 'false' }),
        env: { ...process.env, AZURE_OPENAI_KEY: azureKey(), AZURE_OPENAI_ENDPOINT: azureBase(), BROWSER_WORKER_MODEL: agentModel(), ANONYMIZED_TELEMETRY: 'false', BROWSER_USE_LOGGING_LEVEL: 'error' }
      });
      const line = cleanOutput(result.stdout).split('\n').filter(l => l.trim().startsWith('{')).pop();
      if (result.timedOut) return { ok: false, output: '', error: 'browser timeout' };
      if (!line) return { ok: false, output: '', error: cleanOutput(result.stderr).slice(-400) || 'browser worker javob bermadi' };
      try {
        const parsed = JSON.parse(line);
        return { ok: Boolean(parsed.ok), output: String(parsed.output || ''), error: parsed.error || (parsed.errors || []).join('; ') };
      } catch (error) { return { ok: false, output: '', error: 'browser worker javobi o\'qilmadi' }; }
    }
  };

  // 4) GUI worker: ko'rinadigan interfeys. UI-TARS/OmniParser (GPU, ko'p GB) o'rniga Azure vision
  //    (screen-vision locate_elements) + desktop-control click_at + har harakatdan keyin tekshiruv — agent orqali.
  const gui = {
    async run({ prompt, mission, task, timeoutMs }) {
      const brief = 'Use the gui-worker procedure: prefer desktop-control semantic actions; only if the control cannot be found semantically, ' +
        'take a fresh screen-vision locate_elements observation, click the exact returned center with desktop-control click_at, and verify every ' +
        'material change with a new screenshot. Act only on visibly supported targets and never guess coordinates.\n\nTask: ' + prompt;
      return agent.run({ prompt: brief, mission, task, timeoutMs });
    }
  };

  // 4b) BabyAGI (yoheinakajima/babyagi, functionz): vazifani funksiyalarga bo'lib, kodini o'zi yozadi, ro'yxatga oladi va
  //     ishga tushiradi. O'rganilgan funksiyalar doimiy papkada to'planadi (o'zini-o'zi quruvchi kutubxona).
  const babyagi = {
    async run({ prompt, timeoutMs }) {
      const python = path.join(PROJECT_DIR, '.venv-babyagi', 'bin', 'python');
      if (!fs.existsSync(python)) return { ok: false, output: '', error: 'BabyAGI o\'rnatilmagan (.venv-babyagi)' };
      const cwd = path.join(PROJECT_DIR, '.run', 'agents', 'babyagi');
      fs.mkdirSync(cwd, { recursive: true });
      const result = await runProcess(python, [path.join(__dirname, 'babyagi_worker.py')], {
        spawn: spawnFn, cwd, timeoutMs, stallMs: 240000, input: JSON.stringify({ task: prompt, cwd }),
        env: { ...process.env, OPENAI_API_KEY: azureKey(), OPENAI_API_BASE: azureBase(), BABYAGI_MODEL: agentModel(), BABYAGI_REASONING: env('BABYAGI_REASONING', 'low'),
          BABYAGI_EMBED_BASE: env('AZURE_EMBEDDING_ENDPOINT') || azureBase(), BABYAGI_EMBED_KEY: env('AZURE_EMBEDDING_KEY') || azureKey(),
          BABYAGI_EMBED_MODEL: env('AZURE_EMBEDDING_API_DEPLOYMENT') || 'text-embedding-3-large', PYTHONWARNINGS: 'ignore' }
      });
      return parseJsonWorker(result, 'babyagi');
    }
  };

  // 4c) AutoGPT (Significant-Gravitas/Auto-GPT): maqsadga qarab fikrlash -> buyruq -> natija tsikli (continuous rejim).
  //     Xavfsizlik: ishchi papka bilan cheklangan, lokal shell o'chiq, iteratsiya chegarasi bor.
  const autogpt = {
    async run({ prompt, mission, task, timeoutMs }) {
      const python = path.join(PROJECT_DIR, '.venv-autogpt', 'bin', 'python');
      if (!fs.existsSync(python)) return { ok: false, output: '', error: 'AutoGPT o\'rnatilmagan (.venv-autogpt)' };
      const cwd = path.join(workspace(mission), `autogpt-${task.id}`);
      fs.mkdirSync(cwd, { recursive: true });
      const result = await runProcess(python, [path.join(__dirname, 'autogpt_worker.py')], {
        spawn: spawnFn, cwd, timeoutMs, stallMs: 300000,
        input: JSON.stringify({ task: prompt, cwd, max_iterations: parseInt(env('AUTOGPT_MAX_ITERATIONS'), 10) || 15 }),
        env: { ...process.env, OPENAI_API_KEY: azureKey(), OPENAI_API_BASE: azureBase(), AUTOGPT_MODEL: agentModel(), AUTOGPT_REASONING: env('AUTOGPT_REASONING', 'low'), PYTHONWARNINGS: 'ignore' }
      });
      return parseJsonWorker(result, 'autogpt');
    }
  };

  // 5) Sof fikrlash / yozish
  const think = {
    async run({ prompt }) {
      try {
        const output = await llm.complete({ system: 'You are a precise analyst. Answer completely and factually. No markdown formatting.', user: prompt, effort: 'medium', maxOutputTokens: 4000 });
        return { ok: true, output };
      } catch (error) { return { ok: false, output: '', error: error.message }; }
    }
  };

  return { agent, interpreter, browser, gui, babyagi, autogpt, think };
}

module.exports = { createWorkers, runProcess, cleanOutput };
