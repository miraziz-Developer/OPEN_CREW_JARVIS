'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const { ProviderPool } = require('./skill-platform');
const { er, inf, wrn } = require('./log');
const { createCheckpointStore } = require('./agent-task-checkpoints');
const { resolveOpenClawEnvironment } = require('./openclaw-credentials');
const { extractMissingDependency, runSelfHeal, formatSelfHealEscalation } = require('./self-heal');
const { boundedCall } = require('./bounded-call');

const ENGLISH_ONLY_INSTRUCTION = '[Language policy: Reply to the user only in natural English, regardless of the language of the request or stored context. Never answer in Uzbek or imitate an Uzbek accent. Preserve names, quoted text, and file contents when necessary.]';
const RETRY_DELAYS_MS = [5000, 15000, 45000, 135000];
const RECOVERED_STEP_INSTRUCTION = 'RECOVERY SAFETY: This recovered checkpoint step may have partially executed before the prior worker stopped. Verify the current external and local state before acting. Do not repeat a side-effecting action unless verification shows it is still required. Report what you verified and any uncertainty.';

class OpenClawEmptyResponseError extends Error {
  constructor(summary = 'OpenClaw returned no usable response') {
    super(summary);
    this.name = 'OpenClawEmptyResponseError';
    this.code = 'OPENCLAW_EMPTY_RESPONSE';
  }
}

function checkpointSessionKey(taskId) {
  return 'agent:main:checkpoint-' + String(taskId || '').trim();
}

function cleanOpenClawOutput(output) {
  return String(output || '').split('\n').filter(line => {
    const value = line.trim();
    return value && !/^waiting(?:\.{3})?$/i.test(value) && !value.includes('◒');
  }).join('\n').trim();
}

function isEmptyOpenClawResponse(clean) {
  return !clean || /^(?:\[\s*\]|\{\s*\}|null|undefined)$/i.test(clean);
}

function isOpenClawPolicyFailure(clean) {
  return /^(?:error:\s*)?(?:tool )?policy removed(?: this content)?\.?$/i.test(String(clean || '').trim());
}

// Ekran/telefon bilan ishlaydigan vazifalar koordinata aniqligiga muhtoj — bu yerda "thinking off"
// bilan tezlashtirish aynan xato joyga bosishga olib keldi (sinovda tasdiqlandi). Shu turdagi
// vazifalarda tezlikni emas, aniqlikni tanlaymiz; needsCheckpointedExecution'ga qo'shmaymiz — u
// checkpoint/persistent-task semantikasini ham boshqaradi, bu yerga aralashtirib bo'lmaydi.
const VISUAL_PRECISION_TASK = /\b(phone|iphone|whatsapp|instagram|telegram(?! bot)|screen|ekran|telefon|tap|click|bos(?:ish|ing)|app icon|home screen|mirroring)\b/i;
function needsCarefulReasoning(message) { return needsCheckpointedExecution(message) || VISUAL_PRECISION_TASK.test(String(message || '')); }

function fastThinkingArgs(message) {
  return !needsCarefulReasoning(message) && (process.env.AGENT_FAST_THINKING || 'off') !== 'default' ? ['--thinking', 'off'] : [];
}

function buildOpenClawAgentArgs(message, sessionKey) {
  const args = ['agent'];
  const key = String(sessionKey || '').trim();
  if (key) args.push('--session-key', key);
  args.push('--message', ENGLISH_ONLY_INSTRUCTION + '\n\n' + String(message || ''), '--agent', 'main');
  // Oddiy vazifalarda "thinking" ni o'chirish ~40% tezroq (19s → 11s o'lchangan);
  // murakkab (reja/tahlil/tadqiqot) vazifalarda chuqur fikrlash saqlanadi.
  args.push(...fastThinkingArgs(message));
  return args;
}

function needsCheckpointedExecution(message) {
  const text = String(message || '');
  return text.length > 700 || /\b(architecture|architect|strategy|tradeoffs?|design (?:a|an|the)?|multi[ -]?step|roadmap|migration|root cause|debug(?:ging)?|security review|implementation plan|system design|comprehensive|in[- ]depth|plan|research|analysis)\b/i.test(text);
}

function needsPersistentExecution(message) {
  return needsCheckpointedExecution(message) && /\b(keep (?:working|going)|continue|background|long[- ]running|until (?:it is|the work is)|complete (?:the|this)|monitor|research|implement|analysis)\b/i.test(String(message || ''));
}

function classifyProviderError(error) {
  const message = String(error?.message || error || 'unknown failure');
  const dependency = extractMissingDependency(error);
  const config = message.match(/(?:missing|required|not set|undefined)\s+(?:environment variable|env(?:ironment)? variable|configuration|config)?\s*[:=]?\s*([A-Z][A-Z0-9_]{2,})/i);
  const policy = /policy|safety|permission|forbidden|unauthori[sz]ed|content removed|invalid request/i.test(message);
  const emptyResponse = error instanceof OpenClawEmptyResponseError || error?.code === 'OPENCLAW_EMPTY_RESPONSE';
  if (config || /credential|api[ _-]?key|access token/i.test(message)) return { retryable: false, type: 'missing_config', configKey: config?.[1] || null, message: message.slice(0, 500) };
  if (dependency) return { retryable: true, type: 'missing_dependency', fixableLocally: true, dependency, message: message.slice(0, 500) };
  if (/npm (?:install|ci)|pip (?:install|check)|node-gyp|python (?:package|environment)|package manager/i.test(message)) return { retryable: true, type: 'fixable_locally', fixableLocally: true, message: message.slice(0, 500) };
  const retryable = emptyResponse || (!policy && /timeout|timed out|network|econn|socket|dns|temporar|unavailable|rate limit|5\d\d|failover|exit \d+/i.test(message));
  return { retryable, type: policy ? 'policy' : retryable ? 'transient' : 'terminal', message: message.slice(0, 500) };
}

// Telegram/TTS/agent-provider bridge — jarvis_daemon.js va telegram-bot.js
// bir xil "asosiy agent" (openclaw CLI, deep-think fallback bilan) va bir
// xil Telegram/TTS chiqishiga murojaat qiladi; bu shu mantiqning yagona
// nusxasi (daemon-tomon uchun — dependency'lar options orqali uzatiladi,
// module-level closure emas, shunda alohida test/qayta ishlatish mumkin).
const FALLBACK_NOTICE = '[The main computer agent is temporarily unavailable, so you have no tools right now. If the request needs the user\'s computer, ' +
  'calendar, email, files, apps or browser, say in one short sentence that the agent is temporarily unavailable and will work again shortly; ' +
  'never claim the capability does not exist. If it is a general question, simply answer it.]\n\n';

function createAgentBridge({ chatId, chatIds, token, projectDir, env, azureOpenAiKey, openClawEnvironment, openClawBaseEnvironment, spawnProcess = spawn, selfHealRunner, skillPlatform, runtime, telemetry } = {}) {
  const openClawTimeoutMs = Math.max(30000, parseInt(env('OPENCLAW_AGENT_TIMEOUT_MS'), 10) || 300000);
  const deepThinkTimeoutMs = Math.max(30000, parseInt(env('DEEP_THINK_TIMEOUT_MS'), 10) || 240000);
  const longTaskNoticeMs = Math.min(
    openClawTimeoutMs - 10000,
    Math.max(10000, parseInt(env('AGENT_LONG_TASK_NOTICE_MS'), 10) || openClawTimeoutMs - 30000)
  );
  const selfHealEnabled = String(env('SELF_HEAL_ENABLED') ?? 'true').toLowerCase() !== 'false';
  const routineAutonomy = /^(?:true|1|yes|on)$/i.test(String(env('JARVIS_FULL_AUTONOMY') || 'false'));
  const selfHealMaxAttempts = Math.max(1, Math.min(3, parseInt(env('SELF_HEAL_MAX_ATTEMPTS'), 10) || 2));
  const selfHealTimeoutMs = Math.max(30000, parseInt(env('SELF_HEAL_TIMEOUT_MS'), 10) || 180000);
  const selfHealInterpreterPath = env('SELF_HEAL_INTERPRETER_PATH')
    || [path.join(projectDir, '.venv-interpreter', 'bin', 'interpreter'), '/opt/homebrew/bin/interpreter', '/usr/local/bin/interpreter'].find(candidate => fs.existsSync(candidate))
    || 'interpreter'; // PATH'dan
  const checkpoints = createCheckpointStore(projectDir);
  const approvalToken = Symbol('explicit-checkpoint-approval');

  function assertResumable(task, options) {
    const persisted = checkpoints.load(task.id);
    if ([task, persisted].some(value => value && ['cancelled', 'completed'].includes(value.status))) {
      throw new Error('Terminal task cannot be resumed');
    }
    if ([task, persisted].some(value => value && (value.status === 'paused-awaiting-approval' || value.steps?.some(step => step.status === 'paused-awaiting-approval')))
      && options[approvalToken] !== true) throw new Error('Explicit approval is required to resume a persistent task');
  }

  async function progress(callback, ...args) {
    if (!callback) return;
    try { await boundedCall(() => callback(...args)); }
    catch (error) { wrn('Task notification failed: ' + error.message); }
  }

  function recordOpenClawAttempt(attempt, task, step) {
    if (task) {
      const target = step || task;
      target.attempts = [...(target.attempts || []), attempt].slice(-50);
      checkpoints.save(task);
    }
    telemetry?.openClawAttempt(attempt);
  }

  // Xabarnomalar barcha egalarga boradi (TELEGRAM_OWNER_IDS + TELEGRAM_CHAT_ID).
  const recipients = () => require('./telegram-owner').parseOwnerIds(chatId, ...(Array.isArray(chatIds) ? chatIds : [chatIds]));

  // Barcha tizim xabarlari shu qatlamdan o'tadi: qisqa, tushunarli, takrorsiz, ovoz nusxalarisiz.
  const briefer = new (require('./telegram-brief').TelegramBrief)({
    llm: require('./llm'), mirrorVoice: typeof env === 'function' && env('TELEGRAM_MIRROR_VOICE') === 'true'
  });

  async function sendTelegram(text) {
    const prepared = await briefer.prepare(text);
    if (!prepared) return false;
    text = prepared;
    const targets = recipients();
    if (targets.length > 1) return Promise.all(targets.map(target => sendTelegramTo(target, text))).then(results => results.some(Boolean));
    return sendTelegramTo(targets[0], text);
  }

  function sendTelegramTo(target, text) {
    return new Promise((resolve) => {
      if (!target) { resolve(false); return; }
      const payload = JSON.stringify({ chat_id: target, text: String(text).substring(0, 4096) });
      const req = https.request({ hostname: 'api.telegram.org', path: '/bot' + token + '/sendMessage', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(true)); });
      req.on('error', () => resolve(false)); req.setTimeout(15000, () => { req.destroy(); resolve(false); });
      req.write(payload); req.end();
    });
  }

  function sendTelegramVoice(oggPath) {
    return new Promise((resolve) => {
      const targets = recipients();
      if (!targets.length || !fs.existsSync(oggPath)) { resolve(false); return; }
      try { for (const target of targets) execSync('curl -s -X POST "https://api.telegram.org/bot' + token + '/sendVoice" -F "chat_id=' + target + '" -F "voice=@' + oggPath + '" > /dev/null 2>&1'); resolve(true); }
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
      const step = options.step;
      const startedAtMs = Date.now();
      const attempt = {
        attemptId: crypto.randomUUID(),
        taskId: task?.id || null,
        stepIndex: options.stepIndex ?? step?.index ?? null,
        executionId: options.executionId ?? step?.executionId ?? null,
        phase: options.phase || 'request',
        sessionKey: String(sessionKey || ''),
        openClawSessionId: null,
        openClawRunId: null,
        childPid: null,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: null,
        elapsedMs: null,
        exitCode: null,
        signal: null,
        timeout: { triggered: false, message: null },
        stdoutBytes: 0,
        stderrBytes: 0,
        diagnosticSummary: null
      };
      const childEnvironment = openClawEnvironment || resolveOpenClawEnvironment({ projectDir, env: openClawBaseEnvironment || process.env });
      const proc = spawnProcess('openclaw', buildOpenClawAgentArgs(message, sessionKey), {
        cwd: projectDir,
        env: childEnvironment,
        timeout: openClawTimeoutMs
      });
      attempt.childPid = Number.isInteger(proc.pid) ? proc.pid : null;
      let out = '';
      let procErr = '';
      let noticeTimer;
      let settled = false;
      const timeoutObserver = setTimeout(() => {
        attempt.timeout.triggered = true;
        attempt.timeout.message = `openclaw timed out after ${openClawTimeoutMs}ms`;
      }, openClawTimeoutMs);
      timeoutObserver.unref?.();

      function finish(error, code = null, signal = null) {
        if (settled) return;
        settled = true;
        clearTimeout(noticeTimer);
        clearTimeout(timeoutObserver);
        const finishedAtMs = Date.now();
        attempt.finishedAt = new Date(finishedAtMs).toISOString();
        attempt.elapsedMs = finishedAtMs - startedAtMs;
        attempt.exitCode = Number.isInteger(code) ? code : null;
        attempt.signal = signal || null;
        attempt.stdoutBytes = Buffer.byteLength(out);
        attempt.stderrBytes = Buffer.byteLength(procErr);
        if (!attempt.timeout.triggered && signal === 'SIGTERM' && attempt.elapsedMs >= openClawTimeoutMs) {
          attempt.timeout.triggered = true;
          attempt.timeout.message = `openclaw timed out after ${openClawTimeoutMs}ms`;
        }
        attempt.diagnosticSummary = attempt.timeout.triggered
          ? attempt.timeout.message
          : error instanceof OpenClawEmptyResponseError
            ? 'OpenClaw returned no usable response'
            : error
              ? String(error.message || error).replace(/\s+/g, ' ').trim().slice(0, 300)
              : 'OpenClaw completed successfully';
        recordOpenClawAttempt(attempt, task, step);
        if (error) reject(error); else resolve(cleanOpenClawOutput(out));
      }
      if (task && typeof options.onLongRunning === 'function') {
        noticeTimer = setTimeout(async () => {
          if (task.status !== 'running') return;
          task.longRunningNoticeAt = new Date().toISOString();
          checkpoints.save(task);
          const notice = 'This is taking longer than expected. Would you like me to keep going, or give you what I have so far?';
          wrn('openclaw long-task notice: ' + task.id);
          await progress(options.onLongRunning, notice, task);
        }, longTaskNoticeMs);
        noticeTimer.unref?.();
      }
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { procErr += d; });
      proc.on('error', error => finish(error));
      proc.on('close', (code, signal) => {
        const clean = cleanOpenClawOutput(out);
        if (attempt.timeout.triggered) finish(new Error(attempt.timeout.message), code, signal);
        else if (code !== 0) finish(new Error((procErr || clean || `openclaw exit ${code}`).slice(0, 300)), code, signal);
        else if (isEmptyOpenClawResponse(clean)) finish(new OpenClawEmptyResponseError(), code, signal);
        else if (clean.includes("couldn't generate") || isOpenClawPolicyFailure(clean)) finish(new Error((procErr || clean).slice(0, 300)), code, signal);
        else finish(null, code, signal);
      });
    });
  }

  async function askCheckpointedAgent(message, sessionKey, options = {}) {
    if (options.task) assertResumable(options.task, options);
    const task = options.task || {
      id: checkpoints.createId(message, sessionKey), sessionKey: null,
      request: String(message || '').slice(0, 8000), status: 'planning',
      createdAt: new Date().toISOString(), persistent: Boolean(options.persistent), steps: []
    };
    if (!task.sessionKey || task.persistent) task.sessionKey = checkpointSessionKey(task.id);
    if (!options.task) checkpoints.save(task);
    let steps = [];
    if (!task.steps?.length) try {
      const plan = await askOpenClaw(
        'Break this request into 2 to 6 independently completable steps. Return JSON only as {"steps":["..."]}. Do not execute the work yet.\n\n' + message,
        task.sessionKey,
        { task, stepIndex: 0, executionId: task.id, phase: 'planning' }
      );
      steps = JSON.parse(plan).steps;
    } catch (error) {
      wrn('Checkpoint plan unavailable; preserving the request as one step: ' + error.message);
    }
    if (!task.steps?.length) {
      if (!Array.isArray(steps) || !steps.length) steps = [String(message || '')];
      task.steps = steps.slice(0, 6).map((text, index) => ({ index: index + 1, text: String(text).slice(0, 2000), status: 'pending', executionId: null, startedAt: null, recoveryCount: 0 }));
    }
    task.status = 'running';
    checkpoints.save(task);

    const results = [];
    for (const step of task.steps) {
      if (step.status === 'completed') { results.push(`Step ${step.index}: ${step.result || ''}`); continue; }
      const recovered = step.status === 'running';
      step.status = 'running';
      step.startedAt = new Date().toISOString();
      step.executionId = checkpoints.createId(`${task.id}:${step.index}`, sessionKey);
      step.attempts = step.attempts || [];
      step.recoveryCount = Number(step.recoveryCount || 0) + (recovered ? 1 : 0);
      checkpoints.save(task);
      await progress(options.onProgress, `${step.index}/${task.steps.length} step in progress: ${step.text}`, task, step);
      try {
        let result;
        while (true) {
          try {
            result = await askOpenClaw(
              `${recovered ? RECOVERED_STEP_INSTRUCTION + '\n\n' : ''}Complete checkpoint ${step.index}/${task.steps.length}: ${step.text}\n\nOriginal request:\n${message}`,
              task.sessionKey,
              { task, step, phase: 'step', onLongRunning: options.onLongRunning }
            );
            break;
          } catch (error) {
            const classification = classifyProviderError(error);
            const count = (step.selfHealAttempts || []).filter(attempt => attempt.diagnosticSummary !== 'confirmation_required').length;
            if (!selfHealEnabled || !classification.fixableLocally) throw error;
            if (!classification.dependency) {
              error.selfHealExhausted = true;
              error.selfHealEscalation = formatSelfHealEscalation(classification, { escalationReason: 'unsafe_or_ambiguous_dependency' });
              throw error;
            }
            if (count >= selfHealMaxAttempts) {
              error.selfHealExhausted = true;
              error.selfHealEscalation = formatSelfHealEscalation(classification, { escalationReason: 'attempt_limit_reached' });
              throw error;
            }
            const startedAtMs = Date.now();
            await progress(options.onProgress, `${step.index}/${task.steps.length} automatic repair attempted: inspecting ${classification.dependency.name}.`, task, step);
            let outcome;
            try {
              const approvedCommand = options[approvalToken] === true && options.approvedStep === step.index ? options.approvedCommand : undefined;
              delete options.approvedCommand;
              outcome = await runSelfHeal({ projectDir, dependency: classification.dependency, interpreterPath: selfHealInterpreterPath, timeoutMs: selfHealTimeoutMs, interpreterRunner: selfHealRunner, spawnProcess, routineAutonomy, approvedCommand });
            } catch (healError) { outcome = { status: 'failed', escalationReason: 'repair_failed', error: healError }; }
            const record = { attempt: count + 1, at: new Date(startedAtMs).toISOString(), classification: classification.type, dependency: classification.dependency.name, manager: outcome.plan?.manager || null, status: outcome.status, inspection: outcome.inspectionSummary || null, action: outcome.plan?.command || null, diagnosticSummary: String(outcome.installSummary || outcome.error?.message || outcome.escalationReason || '').slice(0, 300) };
            step.selfHealAttempts = [...(step.selfHealAttempts || []), record].slice(-selfHealMaxAttempts);
            telemetry?.selfHealAttempt({ taskId: task.id, stepIndex: step.index, attempt: record.attempt, classification: record.classification, dependency: record.dependency, manager: record.manager, status: record.status, startedAt: record.at, finishedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAtMs, diagnosticSummary: record.diagnosticSummary, escalationReason: outcome.escalationReason });
            checkpoints.save(task);
            if (outcome.status === 'repaired') {
              await progress(options.onProgress, `${step.index}/${task.steps.length} automatic repair attempted: ${classification.dependency.name} installed, retrying the same step.`, task, step);
              continue;
            }
            error.selfHealEscalation = formatSelfHealEscalation(classification, outcome);
            if (outcome.escalationReason === 'confirmation_required') {
              task.pendingApproval = { stepIndex: step.index, command: outcome.plan.command };
              error.requiresApproval = true;
            }
            throw error;
          }
        }
        step.status = 'completed';
        step.finishedAt = new Date().toISOString();
        step.result = result.slice(0, 12000);
        results.push(`Step ${step.index}: ${result}`);
        checkpoints.save(task);
        await progress(options.onProgress, `${step.index}/${task.steps.length} step complete, continuing.`, task, step);
      } catch (error) {
        const classification = classifyProviderError(error);
        const repairEscalated = error.requiresApproval === true;
        step.status = repairEscalated ? 'paused-awaiting-approval' : classification.retryable && !error.selfHealExhausted ? 'retrying' : 'blocked';
        step.finishedAt = new Date().toISOString();
        step.error = String(error.message || error).slice(0, 500);
        step.escalation = error.selfHealEscalation || (classification.type === 'missing_config' ? formatSelfHealEscalation(classification) : null);
        task.status = repairEscalated ? 'paused-awaiting-approval' : classification.retryable && !error.selfHealExhausted && task.persistent ? 'retrying' : classification.retryable && !error.selfHealExhausted ? 'paused' : 'blocked';
        task.finishedAt = new Date().toISOString();
        task.lastError = classification;
        if (repairEscalated) task.pauseReason = step.escalation || 'Explicit approval is required before this checkpoint can resume';
        checkpoints.save(task);
        if (!results.length && step.escalation) return step.escalation;
        return results.length
          ? 'I could not finish every step. Here is the completed work so far:\n\n' + results.join('\n\n')
          : null;
      }
    }

    try {
      const finalReply = await askOpenClaw(
        'Synthesize these completed checkpoint results into the final response. Clearly distinguish completed work from recommendations and do not claim unfinished work.\n\n' +
        `Original request:\n${message}\n\nCheckpoint results:\n${results.join('\n\n')}`,
        task.sessionKey,
        {
          task,
          stepIndex: task.steps.length + 1,
          executionId: checkpoints.createId(`${task.id}:synthesis`, task.sessionKey),
          phase: 'synthesis',
          onLongRunning: options.onLongRunning
        }
      );
      task.status = 'completed';
      task.finishedAt = new Date().toISOString();
      task.finalResponse = finalReply.slice(0, 12000);
      checkpoints.save(task);
      return finalReply;
    } catch (error) {
      const classification = classifyProviderError(error);
      task.status = classification.retryable && task.persistent ? 'retrying' : 'blocked';
      task.lastError = classification;
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
          persistent: Boolean(context.persistent) || needsPersistentExecution(message),
          onProgress: context.onProgress || (text => sendTelegram('⏳ ' + text)),
          onLongRunning: context.onLongRunning || (text => sendTelegram('⏳ ' + text))
        })
        : askOpenClaw(message, context.sessionKey)
    },
    {
      id: 'azure-deep-think', priority: 1, timeoutMs: deepThinkTimeoutMs + 5000,
      invoke: (message, context) => skillPlatform.invoke('deep-think', 'askExpert', {
        // Bu zaxira asbobsiz LLM: asosiy agent ishlamay qolganda "qila olmayman" deb yolg'on gapirmasligi kerak.
        question: FALLBACK_NOTICE + message,
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
      const response = await agentProviders.invoke(message, { sessionKey, persistent: options.persistent, onProgress: options.onProgress, onLongRunning: options.onLongRunning });
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

  async function resumePersistentTask(task, options = {}) {
    assertResumable(task, options);
    task.status = 'running';
    task.finishedAt = null;
    checkpoints.save(task);
    return askCheckpointedAgent(task.request, task.sessionKey, { ...options, task, persistent: true });
  }

  async function approvePersistentTask(taskId, options = {}) {
    if (typeof options.approved !== 'boolean') throw new Error('Explicit approval is required to resume a persistent task');
    const task = checkpoints.load(taskId);
    if (!task) throw new Error('Persistent task not found');
    if (task.status !== 'paused-awaiting-approval') throw new Error('Persistent task is not awaiting approval');
    if (!options.approved) {
      task.status = 'cancelled';
      task.finishedAt = new Date().toISOString();
      task.pauseReason = 'Owner rejected the pending action';
      delete task.pendingApproval;
      checkpoints.save(task);
      return 'Task cancelled; no pending action was executed.';
    }
    const pending = task.pendingApproval;
    task.approvedAt = new Date().toISOString();
    task.approvalSource = String(options.source || 'explicit-user-approval').slice(0, 100);
    task.pauseReason = null;
    delete task.pendingApproval;
    task.status = 'retrying';
    checkpoints.save(task);
    return resumePersistentTask(task, { ...options, [approvalToken]: true, approvedCommand: pending?.command, approvedStep: pending?.stepIndex });
  }

  return { sendTelegram, sendTelegramVoice, ttsToFile, askOpenClaw, askCheckpointedAgent, resumePersistentTask, approvePersistentTask, checkpoints, agentProviders, askAgent, openClawTimeoutMs, deepThinkTimeoutMs };
}

module.exports = {
  createAgentBridge, buildOpenClawAgentArgs, fastThinkingArgs, checkpointSessionKey,
  OpenClawEmptyResponseError, ENGLISH_ONLY_INSTRUCTION,
  needsCheckpointedExecution, needsPersistentExecution, needsCarefulReasoning,
  classifyProviderError, RETRY_DELAYS_MS, RECOVERED_STEP_INSTRUCTION
};
