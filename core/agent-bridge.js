'use strict';

const fs = require('fs');
const https = require('https');
const { spawn, execSync } = require('child_process');
const { ProviderPool } = require('./skill-platform');
const { er, inf, wrn } = require('./log');
const { createCheckpointStore } = require('./agent-task-checkpoints');

const ENGLISH_ONLY_INSTRUCTION = '[Language policy: Reply to the user only in natural English, regardless of the language of the request or stored context. Never answer in Uzbek or imitate an Uzbek accent. Preserve names, quoted text, and file contents when necessary.]';

function buildOpenClawAgentArgs(message, sessionKey) {
  const args = ['agent'];
  const key = String(sessionKey || '').trim();
  if (key) args.push('--session-key', key);
  args.push('--message', ENGLISH_ONLY_INSTRUCTION + '\n\n' + String(message || ''), '--agent', 'main');
  return args;
}

function needsCheckpointedExecution(message) {
  const text = String(message || '');
  return text.length > 700 || /\b(architecture|architect|strategy|tradeoffs?|design (?:a|an|the)?|multi[ -]?step|roadmap|migration|root cause|debug(?:ging)?|security review|implementation plan|system design|comprehensive|in[- ]depth|plan|research)\b/i.test(text);
}

// Telegram/TTS/agent-provider bridge — jarvis_daemon.js va telegram-bot.js
// bir xil "asosiy agent" (openclaw CLI, deep-think fallback bilan) va bir
// xil Telegram/TTS chiqishiga murojaat qiladi; bu shu mantiqning yagona
// nusxasi (daemon-tomon uchun — dependency'lar options orqali uzatiladi,
// module-level closure emas, shunda alohida test/qayta ishlatish mumkin).
function createAgentBridge({ chatId, token, projectDir, env, azureOpenAiKey, skillPlatform, runtime, telemetry } = {}) {
  const openClawTimeoutMs = Math.max(30000, parseInt(env('OPENCLAW_AGENT_TIMEOUT_MS'), 10) || 300000);
  const deepThinkTimeoutMs = Math.max(30000, parseInt(env('DEEP_THINK_TIMEOUT_MS'), 10) || 240000);
  const longTaskNoticeMs = Math.min(
    openClawTimeoutMs - 10000,
    Math.max(10000, parseInt(env('AGENT_LONG_TASK_NOTICE_MS'), 10) || openClawTimeoutMs - 30000)
  );
  const checkpoints = createCheckpointStore(projectDir);

  function sendTelegram(text) {
    return new Promise((resolve) => {
      if (!chatId) { resolve(false); return; }
      const payload = JSON.stringify({ chat_id: chatId, text: String(text).substring(0, 4096) });
      const req = https.request({ hostname: 'api.telegram.org', path: '/bot' + token + '/sendMessage', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(true)); });
      req.on('error', () => resolve(false)); req.setTimeout(15000, () => { req.destroy(); resolve(false); });
      req.write(payload); req.end();
    });
  }

  function sendTelegramVoice(oggPath) {
    return new Promise((resolve) => {
      if (!chatId || !fs.existsSync(oggPath)) { resolve(false); return; }
      try { execSync('curl -s -X POST "https://api.telegram.org/bot' + token + '/sendVoice" -F "chat_id=' + chatId + '" -F "voice=@' + oggPath + '" > /dev/null 2>&1'); resolve(true); }
      catch (e) { resolve(false); }
    });
  }

  async function ttsToFile(text, options = {}) {
    const startedAt = Date.now();
    const cleanText = String(text || '').trim();
    // Agent ba'zan bo'sh JSON konteyner qaytaradi. Azure bunday matn uchun
    // yaroqsiz/juda kichik MP3 berishi mumkin va afplay "AudioFileOpen failed"
    // deb stderr'ni to'ldiradi.
    if (!cleanText || /^(?:\[\s*\]|\{\s*\}|null|undefined)$/i.test(cleanText)) return null;
    // Spawn mantig'i endi skills/platform.js'dagi 'azure-tts' registratsiyasi
    // ichida -- osilib qolgan child process SkillPlatform'ning timeout/
    // circuit-breaker'i bilan himoyalanadi (avval bu spawn'da umuman
    // parent-side timeout yo'q edi).
    try {
      const output = await skillPlatform.invoke('azure-tts', 'synthesize', { text: cleanText });
      telemetry?.latency({ requestId: options.requestId, source: options.source || 'tts', provider: 'azure-tts', tts_ms: Date.now() - startedAt });
      return output;
    } catch (e) {
      telemetry?.latency({ requestId: options.requestId, source: options.source || 'tts', provider: 'azure-tts', tts_ms: Date.now() - startedAt, error: e });
      return null;
    }
  }

  function askOpenClaw(message, sessionKey, options = {}) {
    return new Promise((resolve, reject) => {
      const task = options.task;
      const proc = spawn('openclaw', buildOpenClawAgentArgs(message, sessionKey), {
        cwd: projectDir,
        env: { ...process.env, AZURE_OPENAI_KEY: azureOpenAiKey, JARVIS_PROJECT_DIR: projectDir },
        timeout: openClawTimeoutMs
      });
      let out = '';
      let procErr = '';
      let noticeTimer;
      if (task && typeof options.onLongRunning === 'function') {
        noticeTimer = setTimeout(async () => {
          if (task.status !== 'running') return;
          task.longRunningNoticeAt = new Date().toISOString();
          checkpoints.save(task);
          const notice = 'This is taking longer than expected. Would you like me to keep going, or give you what I have so far?';
          wrn('openclaw long-task notice: ' + task.id);
          await options.onLongRunning(notice, task);
        }, longTaskNoticeMs);
        noticeTimer.unref?.();
      }
      proc.stdout.on('data', d => out += d); proc.stderr.on('data', d => procErr += d);
      proc.on('error', error => { clearTimeout(noticeTimer); reject(error); });
      proc.on('close', (code) => {
        clearTimeout(noticeTimer);
        const clean = out.split('\n').filter(l => !l.includes('Waiting') && !l.includes('◒') && l.trim()).join('\n').trim();
        const emptyPayload = /^(?:\[\s*\]|\{\s*\}|null|undefined)$/i.test(clean);
        if (code !== 0 || !clean || emptyPayload || clean.includes("couldn't generate") || clean.includes('tool policy removed')) {
          reject(new Error((procErr || clean || `openclaw exit ${code}`).slice(0, 300)));
          return;
        }
        resolve(clean);
      });
    });
  }

  async function askCheckpointedAgent(message, sessionKey, options = {}) {
    const task = {
      id: checkpoints.createId(message, sessionKey), sessionKey: String(sessionKey || ''),
      request: String(message || '').slice(0, 8000), status: 'planning',
      createdAt: new Date().toISOString(), steps: []
    };
    checkpoints.save(task);
    let steps = [];
    try {
      const plan = await askOpenClaw(
        'Break this request into 2 to 6 independently completable steps. Return JSON only as {"steps":["..."]}. Do not execute the work yet.\n\n' + message,
        sessionKey
      );
      steps = JSON.parse(plan).steps;
    } catch (error) {
      wrn('Checkpoint plan unavailable; preserving the request as one step: ' + error.message);
    }
    if (!Array.isArray(steps) || !steps.length) steps = [String(message || '')];
    task.steps = steps.slice(0, 6).map((text, index) => ({ index: index + 1, text: String(text).slice(0, 2000), status: 'pending' }));
    task.status = 'running';
    checkpoints.save(task);

    const results = [];
    for (const step of task.steps) {
      step.status = 'running';
      step.startedAt = new Date().toISOString();
      checkpoints.save(task);
      await options.onProgress?.(`${step.index}/${task.steps.length} step in progress: ${step.text}`, task, step);
      try {
        const result = await askOpenClaw(
          `Complete checkpoint ${step.index}/${task.steps.length}: ${step.text}\n\nOriginal request:\n${message}`,
          sessionKey,
          { task, onLongRunning: options.onLongRunning }
        );
        step.status = 'completed';
        step.finishedAt = new Date().toISOString();
        step.result = result.slice(0, 12000);
        results.push(`Step ${step.index}: ${result}`);
        checkpoints.save(task);
        await options.onProgress?.(`${step.index}/${task.steps.length} step complete, continuing.`, task, step);
      } catch (error) {
        step.status = 'failed';
        step.finishedAt = new Date().toISOString();
        step.error = String(error.message || error).slice(0, 500);
        task.status = 'partial';
        task.finishedAt = new Date().toISOString();
        checkpoints.save(task);
        return results.length
          ? 'I could not finish every step. Here is the completed work so far:\n\n' + results.join('\n\n')
          : null;
      }
    }

    try {
      const finalReply = await askOpenClaw(
        'Synthesize these completed checkpoint results into the final response. Clearly distinguish completed work from recommendations and do not claim unfinished work.\n\n' +
        `Original request:\n${message}\n\nCheckpoint results:\n${results.join('\n\n')}`,
        sessionKey,
        { task, onLongRunning: options.onLongRunning }
      );
      task.status = 'completed';
      task.finishedAt = new Date().toISOString();
      task.finalResponse = finalReply.slice(0, 12000);
      checkpoints.save(task);
      return finalReply;
    } catch (error) {
      task.status = 'partial';
      task.finishedAt = new Date().toISOString();
      task.synthesisError = String(error.message || error).slice(0, 500);
      checkpoints.save(task);
      return 'I completed the checkpoints but could not prepare the final synthesis. Here is the completed work:\n\n' + results.join('\n\n');
    }
  }

  const agentProviders = new ProviderPool([
    {
      id: 'openclaw', priority: 0, timeoutMs: openClawTimeoutMs + 5000,
      invoke: (message, context) => needsCheckpointedExecution(message)
        ? askCheckpointedAgent(message, context.sessionKey, {
          onProgress: context.onProgress || (text => sendTelegram('⏳ ' + text)),
          onLongRunning: context.onLongRunning || (text => sendTelegram('⏳ ' + text))
        })
        : askOpenClaw(message, context.sessionKey)
    },
    {
      id: 'azure-deep-think', priority: 1, timeoutMs: deepThinkTimeoutMs + 5000,
      invoke: (message, context) => skillPlatform.invoke('deep-think', 'askExpert', {
        question: message,
        context: context.sessionKey ? `Session: ${context.sessionKey}` : undefined
      })
    }
  ], { failureThreshold: 2, cooldownMs: 120000 });

  const publishProviderPool = () => telemetry?.providerPool(agentProviders.snapshot());
  agentProviders.on('provider.selected', ({ provider }) => {
    telemetry?.providerResult(provider);
    publishProviderPool();
  });
  agentProviders.on('provider.failed', ({ provider, error }) => {
    telemetry?.providerResult(provider, error);
    publishProviderPool();
  });
  publishProviderPool();

  async function askAgent(message, sessionKey, options = {}) {
    const startedAt = Date.now();
    try {
      inf(`openclaw timeout=${openClawTimeoutMs}ms; deep-think timeout=${deepThinkTimeoutMs}ms`);
      const response = await agentProviders.invoke(message, { sessionKey, onProgress: options.onProgress, onLongRunning: options.onLongRunning });
      telemetry?.latency({ requestId: options.requestId, source: options.source || 'agent', provider: response.provider, agent_ms: Date.now() - startedAt });
      console.log(JSON.stringify({ event: 'response_latency', requestId: options.requestId, source: options.source || 'agent', provider: response.provider, stt_ms: null, agent_ms: Date.now() - startedAt, tts_ms: null, total_ms: Date.now() - startedAt }));
      return response.value;
    } catch (error) {
      telemetry?.latency({ requestId: options.requestId, source: options.source || 'agent', agent_ms: Date.now() - startedAt, error });
      runtime.recordError?.('agent.providers', error);
      er('Barcha agent providerlari ishlamadi: ' + error.message);
      return null;
    }
  }

  return { sendTelegram, sendTelegramVoice, ttsToFile, askOpenClaw, askCheckpointedAgent, agentProviders, askAgent, openClawTimeoutMs, deepThinkTimeoutMs };
}

module.exports = { createAgentBridge, buildOpenClawAgentArgs, ENGLISH_ONLY_INSTRUCTION, needsCheckpointedExecution };
