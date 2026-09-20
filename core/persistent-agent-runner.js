#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { PROJECT_DIR } = require('./paths');
const { createAgentBridge, RETRY_DELAYS_MS, classifyProviderError } = require('./agent-bridge');
const { createSkillPlatform } = require('../skills/platform');
const { RuntimeTelemetry } = require('./runtime-telemetry');
const { resolveOpenClawEnvironment } = require('./openclaw-credentials');
const { createGmailTaskNotifier } = require('./gmail-task-notifier');
const { boundedCall } = require('./bounded-call');

let envFile = '';
try { envFile = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (_) {}
function env(key, fallback) {
  if (process.env[key] !== undefined) return process.env[key];
  const match = envFile.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return match ? match[1].trim() : fallback;
}
function number(key, fallback) { return Math.max(0, parseInt(env(key), 10) || fallback); }
function retryDelay(retryCount) { return RETRY_DELAYS_MS[Math.min(Math.max(0, retryCount), RETRY_DELAYS_MS.length - 1)]; }

function createRunner(options = {}) {
  const projectDir = options.projectDir || PROJECT_DIR;
  const now = options.now || Date.now;
  const retryWindowMs = options.retryWindowMs || number('AGENT_PERSISTENT_RECOVERY_WINDOW_MS', 2592000000);
  const staleRunningMs = options.staleRunningMs || number('AGENT_PERSISTENT_STALE_RUNNING_MS', 600000);
  const telemetry = options.telemetry || new RuntimeTelemetry({ file: path.join(projectDir, '.run', 'telemetry.json') });
  const openClawEnvironment = options.openClawEnvironment || resolveOpenClawEnvironment({ projectDir });
  const bridge = options.bridge || createAgentBridge({
    chatId: env('TELEGRAM_CHAT_ID'), token: env('TELEGRAM_BOT_TOKEN'), projectDir, env,
    azureOpenAiKey: env('AZURE_OPENAI_KEY'), openClawEnvironment,
    skillPlatform: createSkillPlatform({ projectDir, env }), runtime: {}, telemetry
  });
  const active = new Set();
  const notifier = options.notifier || createGmailTaskNotifier({ env });
  const notificationTimeoutMs = options.notificationTimeoutMs || 15000;

  async function report(kind, task, detail) {
    try { return await boundedCall(() => notifier.notify(kind, task, detail), notificationTimeoutMs); }
    catch (error) { console.warn('Gmail task notification failed:', error.message); return { sent: false, reason: 'error' }; }
  }

  async function reportState(task) {
    if (!['completed', 'cancelled', 'blocked', 'failed', 'paused', 'paused-awaiting-approval'].includes(task.status)) return;
    if (task.lastEmailReportedStatus === task.status) return;
    const result = await report(task.status === 'paused-awaiting-approval' ? 'approval needed' : task.status, task,
      task.finalResponse || task.pauseReason || task.lastError?.message || task.lastProgress);
    if (result?.sent) { task.lastEmailReportedStatus = task.status; bridge.checkpoints.save(task); }
  }

  async function telegram(text) {
    try { await boundedCall(() => bridge.sendTelegram?.(text), notificationTimeoutMs); }
    catch (error) { console.warn('Telegram task notification failed:', error.message); }
  }

  async function recoverTask(task) {
    if (active.has(task.id) || !task.persistent) return false;
    active.add(task.id);
    try {
      if (['completed', 'cancelled', 'blocked', 'failed', 'paused', 'paused-awaiting-approval'].includes(task.status)) return false;
      const parsedCreated = Date.parse(task.createdAt || '');
      const created = Number.isFinite(parsedCreated) ? parsedCreated : now();
      if (now() - created > retryWindowMs) {
        task.status = 'paused'; task.pausedAt = new Date(now()).toISOString(); task.pauseReason = 'Automatic recovery window expired';
        bridge.checkpoints.save(task); return false;
      }
      const changedRunning = task.steps?.some(step => {
        const parsedStarted = Date.parse(step.startedAt || '');
        const startedAt = Number.isFinite(parsedStarted) ? parsedStarted : 0;
        return step.status === 'running' && now() - startedAt >= staleRunningMs;
      });
      const dueRetry = task.status === 'retrying' && now() >= (Date.parse(task.nextRetryAt || '') || 0);
      if (!changedRunning && !dueRetry) return false;
      if (changedRunning) task.recoveredAt = new Date(now()).toISOString();
      task.retryCount = Number(task.retryCount || 0) + 1;
      await bridge.resumePersistentTask(task, {
        onProgress: async text => {
          task.lastProgress = String(text).slice(0, 1000);
          try {
            // A late timed-out callback must not mutate the live checkpoint.
            const snapshot = { ...task };
            const result = await boundedCall(() => notifier.notifyProgress(snapshot, task.lastProgress, now()), notificationTimeoutMs);
            if (result?.sent) task.lastEmailProgressAt = snapshot.lastEmailProgressAt;
          } catch (error) { console.warn('Gmail task progress notification failed:', error.message); }
          bridge.checkpoints.save(task);
        },
        onLongRunning: async text => telegram('⏳ Persistent task ' + task.id + ': ' + text)
      });
      if (task.status === 'retrying') {
        task.nextRetryAt = new Date(now() + retryDelay(task.retryCount - 1)).toISOString();
        bridge.checkpoints.save(task);
      } else if (task.status === 'completed') {
        await telegram('✅ Persistent task completed: ' + String(task.request || '').slice(0, 500));
      } else if (task.status === 'paused-awaiting-approval') {
        await telegram('⏸️ Persistent task awaits approval: ' + task.id + '. Use /tasks, then /approve TASK_ID or /reject TASK_ID.');
      }
      return true;
    } catch (error) {
      // Never turn an approval guard failure into an automatic retry.
      if (task.steps?.some(step => step.status === 'paused-awaiting-approval')) task.status = 'paused-awaiting-approval';
      else {
        task.lastError = classifyProviderError(error);
        task.status = task.lastError.retryable ? 'retrying' : 'failed';
        task.nextRetryAt = new Date(now() + retryDelay(Math.max(0, (task.retryCount || 1) - 1))).toISOString();
      }
      bridge.checkpoints.save(task);
      return false;
    } finally {
      try { await reportState(task); } finally { active.delete(task.id); }
    }
  }

  async function scan() {
    const tasks = bridge.checkpoints.list();
    const results = await Promise.allSettled(tasks.map(task => recoverTask(task)));
    results.forEach(result => { if (result.status === 'rejected') console.warn('Persistent task recovery failed:', result.reason?.message); });
    return tasks;
  }
  return { bridge, scan, recoverTask, active };
}

if (require.main === module) {
  const runner = createRunner();
  const scanMs = number('AGENT_PERSISTENT_RUNNER_SCAN_MS', 30000);
  const tick = () => runner.scan().catch(error => console.error('persistent-agent-runner:', error.message));
  tick();
  setInterval(tick, scanMs);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

module.exports = { createRunner, retryDelay };