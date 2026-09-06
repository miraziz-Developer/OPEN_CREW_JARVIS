#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { PROJECT_DIR } = require('../core/paths');
const { readEnvFile, validateConfig } = require('../core/config');
const { commandForPid, commandOwnsScript, findMatchingProcesses } = require('../core/runtime-health');
const { createCheck, evaluateRuntime, isPrivateFileMode, summarize } = require('../core/system-doctor');

const args = new Set(process.argv.slice(2));
const jsonOutput = args.has('--json');
const strict = args.has('--strict');
const checks = [];
const add = (name, status, detail, remediation) => checks.push(createCheck(name, status, detail, remediation));

function executable(name) {
  try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch (_) { return ''; }
}

function launchdState(label) {
  try {
    const output = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8' });
    return output.match(/^\s*state = (\S+)/m)?.[1] || 'registered';
  } catch (_) { return null; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function httpJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { if (body.length < 1024 * 1024) body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (_) { resolve(body); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

function checkProcess(name, script, required = true) {
  const processes = findMatchingProcesses(path.join(PROJECT_DIR, script));
  const healthy = processes.length === 1;
  const status = healthy ? 'ok' : required ? 'error' : 'warn';
  add(`process:${name}`, status, healthy ? `pid=${processes[0].pid}` : `count=${processes.length}${processes.length ? `, pids=${processes.map(item => item.pid).join(',')}` : ''}`,
    healthy ? null : 'Supervisor va duplicate jarayonlarni tekshiring');
}

function checkSupervisor() {
  const script = path.join(PROJECT_DIR, 'scripts', 'jarvis.sh');
  const lockFile = path.join(PROJECT_DIR, '.jarvis-supervisor.lock', 'pid');
  let pid = 0;
  try { pid = Number(fs.readFileSync(lockFile, 'utf8').trim()); } catch (_) {}
  const alive = Number.isInteger(pid) && pid > 0 && pidAlive(pid);
  const ownsScript = alive && commandOwnsScript(commandForPid(pid), script);
  add('process:supervisor', ownsScript ? 'ok' : 'error', ownsScript ? `pid=${pid}, singleton-lock=valid` : `pid=${pid || 'none'}, alive=${alive}, command=${ownsScript}`,
    ownsScript ? null : 'launchctl kickstart -k gui/$(id -u)/com.jarvis.openclaw');
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  add('platform:macos', process.platform === 'darwin' ? 'ok' : 'error', process.platform, 'JARVIS macOS uchun mo‘ljallangan');
  add('runtime:node', major >= 22 ? 'ok' : 'error', process.version, 'Node.js 22 yoki yangirog‘ini o‘rnating');

  const envFile = path.join(PROJECT_DIR, '.env');
  let envValues = {};
  if (!fs.existsSync(envFile)) {
    add('config:env-file', 'error', '.env topilmadi', 'cp .env.example .env va haqiqiy secretlarni kiriting');
  } else {
    const mode = fs.statSync(envFile).mode & 0o777;
    add('security:env-permissions', isPrivateFileMode(mode) ? 'ok' : 'error', `mode=${mode.toString(8).padStart(3, '0')}`, 'chmod 600 .env');
    try { envValues = readEnvFile(envFile); } catch (error) { add('config:env-file', 'error', error.message); }
  }
  const validation = validateConfig({ ...envValues, ...process.env });
  add('config:schema', validation.ok ? 'ok' : 'error', validation.ok ? `${Object.keys(validation.values).length} typed parametr` : validation.errors.map(error => error.key).join(', '), 'npm run config:check');

  for (const binary of ['node', 'openclaw', 'curl', 'sox', 'afplay']) {
    const location = executable(binary);
    add(`binary:${binary}`, location ? 'ok' : 'error', location || 'topilmadi', location ? null : `${binary} binarysini o‘rnating`);
  }

  const paused = fs.existsSync(path.join(PROJECT_DIR, '.jarvis-paused'));
  add('state:paused', paused ? 'warn' : 'ok', paused ? 'JARVIS pauzada' : 'faol', paused ? 'Fn tugmasi yoki jarvis start bilan davom ettiring' : null);

  for (const [name, label] of Object.entries({ supervisor: 'com.jarvis.openclaw', sentinel: 'com.jarvis.pausesentinel', gateway: 'ai.openclaw.gateway' })) {
    const state = launchdState(label);
    add(`launchd:${name}`, state === 'running' ? 'ok' : 'error', state || 'ro‘yxatdan o‘tmagan', './scripts/enable-autostart.sh');
  }

  checkSupervisor();
  checkProcess('voice-daemon', 'jarvis_daemon.js');
  checkProcess('pause-sentinel', 'scripts/pause-sentinel.js');
  checkProcess('dashboard', 'dashboard/server.js');
  checkProcess('screen-monitor', 'skills/screen-monitor/index.js', validation.values.SCREEN_MONITOR_ENABLED !== false);
  checkProcess('telegram-bot', 'telegram-bot.js', Boolean(envValues.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN));

  const runtime = readJson(path.join(PROJECT_DIR, '.jarvis-runtime.json'));
  checks.push(evaluateRuntime(runtime, { pidAlive, commandForPid }));

  try {
    await httpJson('http://127.0.0.1:18789/health');
    add('http:gateway', 'ok', 'http://127.0.0.1:18789/health');
  } catch (error) { add('http:gateway', 'error', error.message, 'openclaw gateway restart'); }

  try {
    const status = await httpJson(`http://127.0.0.1:${validation.values.DASHBOARD_PORT || envValues.DASHBOARD_PORT || 7890}/api/status`);
    const requiredComponents = ['gateway', 'daemon', 'sentinel'];
    if (validation.values.SCREEN_MONITOR_ENABLED !== false) requiredComponents.push('monitor');
    const unhealthy = requiredComponents.filter(name => status?.[name] !== true);
    if (envValues.TELEGRAM_BOT_TOKEN && status?.bot !== true) unhealthy.push('bot');
    add('http:dashboard', unhealthy.length ? 'error' : 'ok', unhealthy.length ? `unhealthy=${unhealthy.join(',')}` : 'API va komponentlar healthy', 'Supervisor loglarini tekshiring');
  } catch (error) { add('http:dashboard', 'error', error.message, 'Dashboard/supervisorni tekshiring'); }

  const summary = summarize(checks, { strict });
  if (jsonOutput) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), summary, checks }, null, 2));
  } else {
    for (const check of checks) {
      const icon = check.status === 'ok' ? '✅' : check.status === 'warn' ? '⚠️ ' : '❌';
      console.log(`${icon} ${check.name}: ${check.detail}`);
      if (check.status !== 'ok' && check.remediation) console.log(`   ↳ ${check.remediation}`);
    }
    console.log(`\nJARVIS Doctor: ${summary.healthy ? 'HEALTHY' : 'UNHEALTHY'} — ${summary.counts.ok} OK, ${summary.counts.warn} warning, ${summary.counts.error} error`);
  }
  process.exitCode = summary.healthy ? 0 : 1;
}

main().catch(error => {
  if (jsonOutput) console.log(JSON.stringify({ summary: { healthy: false }, fatal: error.message }));
  else console.error(`❌ Doctor ishlamadi: ${error.message}`);
  process.exitCode = 1;
});