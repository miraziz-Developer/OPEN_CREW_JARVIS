'use strict';

const { spawn } = require('child_process');
const { assessAction } = require('./action-safety-policy');

const NODE_PACKAGE = /^(?:@[-a-z0-9_.]+\/)?[a-z0-9][a-z0-9_.-]*$/i;
const PYTHON_PACKAGE = /^[a-z0-9][a-z0-9_.-]*$/i;

function extractMissingDependency(error) {
  const message = String(error?.message || error || '');
  let match = message.match(/(?:cannot find module|module not found)\s*[:']?\s*['"]([^'"\s/][^'"]*)['"]/i)
    || message.match(/ModuleNotFoundError:\s*No module named\s+['"]([^'"]+)['"]/i);
  if (match) {
    const name = match[1].trim();
    const ecosystem = /ModuleNotFoundError/i.test(message) ? 'python' : 'node';
    return isSafeDependencyName(name, ecosystem) ? { name, ecosystem } : null;
  }
  match = message.match(/(?:command not found|not recognized as an internal or external command)\s*[:]?\s*['"]?([^\s'";|&]+)['"]?/i);
  if (!match) return null;
  const name = match[1].trim();
  return isSafeDependencyName(name, 'node') ? { name, ecosystem: 'command' } : null;
}

function isSafeDependencyName(name, ecosystem) {
  const value = String(name || '');
  return (ecosystem === 'python' ? PYTHON_PACKAGE : NODE_PACKAGE).test(value)
    && !value.includes('..') && !/[/:\\@]/.test(value.replace(/^@[^/]+\//, ''));
}

function buildSafeRepairPlan(dependency, projectDir) {
  if (!dependency || !isSafeDependencyName(dependency.name, dependency.ecosystem)) return null;
  if (dependency.ecosystem === 'node') {
    return { dependency, manager: 'npm', command: `npm install --no-save --ignore-scripts ${dependency.name}`, projectDir };
  }
  if (dependency.ecosystem === 'python') {
    return { dependency, manager: 'pip', command: `.venv/bin/python -m pip install ${dependency.name}`, projectDir, requiresProjectVenv: true };
  }
  return null;
}

function runInterpreterJob({ interpreterPath, projectDir, prompt, timeoutMs, spawnProcess = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(interpreterPath, ['--stdin', '--loop', '--safe_mode', 'auto', '--auto_run', '--disable_telemetry'], { cwd: projectDir, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const timer = setTimeout(() => finish(new Error(`self-heal interpreter timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    function finish(error) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    }
    child.stdout?.on('data', data => { stdout += data; });
    child.stderr?.on('data', data => { stderr += data; });
    child.on('error', finish);
    child.on('close', code => code === 0 ? finish() : finish(new Error(`self-heal interpreter exited ${code}: ${stderr.slice(0, 300)}`)));
    child.stdin?.end(prompt);
  });
}

async function runSelfHeal({ projectDir, dependency, interpreterPath = '/opt/homebrew/bin/interpreter', timeoutMs = 180000, interpreterRunner, spawnProcess, routineAutonomy = false, approvedCommand }) {
  const plan = buildSafeRepairPlan(dependency, projectDir);
  if (!plan) return { status: 'blocked', escalationReason: 'unsafe_or_ambiguous_dependency' };
  if (plan.requiresProjectVenv) {
    const fs = require('fs');
    if (!fs.existsSync(`${projectDir}/.venv/bin/python`)) return { status: 'blocked', plan, escalationReason: 'project_virtualenv_required' };
  }
  const safety = assessAction({ kind: 'task', id: plan.command, description: `Install missing local dependency ${dependency.name}` });
  if (safety.requiresConfirmation && !(routineAutonomy && safety.autonomousEligible) && approvedCommand !== plan.command) {
    return { status: 'blocked', plan, escalationReason: 'confirmation_required' };
  }
  const runner = interpreterRunner || (input => runInterpreterJob({ ...input, interpreterPath, timeoutMs, spawnProcess }));
  const constraints = 'Work only in the stated project. Do not access secrets or unrelated directories. Do not use sudo, global installs, delete data, change permissions, send/publish anything, or run any command other than the one stated. Return a concise verification summary.';
  const inspection = await runner({ projectDir, timeoutMs, prompt: `Inspect whether local dependency ${dependency.name} is available for the project. Read only; do not install or modify anything.\n${constraints}` });
  const installation = await runner({ projectDir, timeoutMs, prompt: `Run exactly this safe project-local dependency repair command, then verify it succeeds:\n${plan.command}\n${constraints}` });
  return { status: 'repaired', plan, inspectionSummary: String(inspection.stdout || inspection).slice(0, 300), installSummary: String(installation.stdout || installation).slice(0, 300) };
}

function formatSelfHealEscalation(classification, outcome) {
  if (classification.type === 'missing_config') return `I need ${classification.configKey || 'the required credential or configuration value'} configured to continue this step. Please provide/configure it, and I will resume the same checkpoint.`;
  if (outcome?.escalationReason === 'confirmation_required') return 'Repairing this issue requires a confirmation-gated action. Please confirm the specific repair so I can resume the same checkpoint.';
  if (outcome?.escalationReason === 'project_virtualenv_required') return `I need a project-local Python virtual environment before I can safely install ${classification.dependency?.name || 'the missing package'}. Please create or identify that environment, and I will resume.`;
  return `I attempted the safe local repair for ${classification.dependency?.name || 'the missing dependency'} but it still needs attention. Please provide a compatible package/version or resolve the local registry/network blocker, and I will resume the same checkpoint.`;
}

module.exports = { extractMissingDependency, isSafeDependencyName, buildSafeRepairPlan, runInterpreterJob, runSelfHeal, formatSelfHealEscalation };