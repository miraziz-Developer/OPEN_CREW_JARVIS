'use strict';

const { inspectRuntimeOwner } = require('./runtime-health');

function createCheck(name, status, detail, remediation = null) {
  if (!['ok', 'warn', 'error'].includes(status)) throw new Error(`Noma’lum doctor status: ${status}`);
  return { name, status, detail: String(detail || ''), ...(remediation ? { remediation } : {}) };
}

function isPrivateFileMode(mode) {
  return Number.isInteger(mode) && (mode & 0o077) === 0;
}

function evaluateRuntime(runtime, options = {}) {
  if (!runtime || typeof runtime !== 'object') {
    return createCheck('runtime:owner', 'error', 'Runtime snapshot yo‘q yoki yaroqsiz', 'Supervisorni qayta ishga tushiring');
  }
  const owner = inspectRuntimeOwner(runtime, options);
  const detail = owner.pid
    ? `pid=${owner.pid}, alive=${owner.pidAlive}, command=${owner.commandMatches}, heartbeat=${owner.heartbeatFresh}, ownership=${owner.heartbeatOwnsSnapshot}`
    : 'Runtime owner PID yo‘q';
  return createCheck('runtime:owner', owner.healthy ? 'ok' : 'error', detail, owner.healthy ? null : 'npm run diagnose:voice orqali batafsil tekshiring');
}

function summarize(checks, options = {}) {
  const counts = { ok: 0, warn: 0, error: 0 };
  for (const check of checks) counts[check.status] += 1;
  const healthy = counts.error === 0 && (!options.strict || counts.warn === 0);
  return { healthy, strict: Boolean(options.strict), counts, total: checks.length };
}

module.exports = { createCheck, evaluateRuntime, isPrivateFileMode, summarize };