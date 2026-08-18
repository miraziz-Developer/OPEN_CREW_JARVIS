#!/usr/bin/env node
'use strict';

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const checks = [];
const add = (name, ok, detail, level = ok ? 'ok' : 'error') => checks.push({ name, ok, detail, level });

function envFile() {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    return Object.fromEntries(text.split(/\r?\n/).filter(line => line && !line.startsWith('#') && line.includes('='))
      .map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).trim()]; }));
  } catch (_) { return {}; }
}

function processAlive(pattern) {
  try { return Boolean(execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim()); } catch (_) { return false; }
}

function checkBinary(name) {
  const r = spawnSync('which', [name], { encoding: 'utf8' });
  add(`binary:${name}`, r.status === 0, r.status === 0 ? r.stdout.trim() : 'topilmadi');
}

function checkMic() {
  const out = path.join('/tmp', `jarvis-diagnostic-${process.pid}.wav`);
  const r = spawnSync('sox', ['-d', '-r', '16000', '-c', '1', '-b', '16', out, 'trim', '0', '0.35'], {
    encoding: 'utf8', timeout: 4000
  });
  let size = 0;
  try { size = fs.statSync(out).size; fs.unlinkSync(out); } catch (_) {}
  add('microphone:capture', r.status === 0 && size > 1000,
    r.status === 0 ? `${size} byte audio olindi` : (r.stderr || r.error?.message || 'capture xato').trim().slice(-300));
}

function checkRuntime() {
  let runtime;
  try { runtime = JSON.parse(fs.readFileSync(path.join(ROOT, '.jarvis-runtime.json'), 'utf8')); }
  catch (_) { add('runtime:state', false, '.jarvis-runtime.json yo‘q yoki buzilgan', 'warn'); return; }
  const daemon = runtime.components?.['voice-daemon'];
  const mic = runtime.components?.microphone;
  add('runtime:daemon-heartbeat', Number(daemon?.ageMs) < 15000, daemon ? `${daemon.state || daemon.status || 'unknown'}, age=${daemon.ageMs}ms` : 'heartbeat yo‘q');
  add('runtime:microphone-heartbeat', mic?.status === 'streaming' && Number(mic?.ageMs) < 15000,
    mic ? `${mic.status}, age=${mic.ageMs ?? '?'}ms` : 'heartbeat yo‘q');
  const rt = runtime.components?.['realtime-api'];
  if (rt) add('runtime:realtime', !['error', 'degraded'].includes(rt.status), rt.status || 'unknown', rt.status === 'degraded' ? 'warn' : undefined);
}

function main() {
  const env = envFile();
  ['node', 'sox', 'afplay'].forEach(checkBinary);
  add('config:azure-speech', Boolean(env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION), 'key va region ' + (env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION ? 'mavjud' : 'yetishmaydi'));
  add('config:azure-openai', Boolean(env.AZURE_OPENAI_KEY || process.env.AZURE_OPENAI_KEY), 'realtime/agent key ' + (env.AZURE_OPENAI_KEY || process.env.AZURE_OPENAI_KEY ? 'mavjud' : 'yetishmaydi'));
  add('process:voice-daemon', processAlive('jarvis_daemon.js'), processAlive('jarvis_daemon.js') ? 'ishlayapti' : 'ishlamayapti', 'warn');
  add('process:pause-sentinel', processAlive('pause-sentinel.js'), processAlive('pause-sentinel.js') ? 'ishlayapti' : 'ishlamayapti', 'warn');
  checkMic();
  checkRuntime();

  for (const c of checks) {
    const icon = c.ok ? '✅' : c.level === 'warn' ? '⚠️ ' : '❌';
    console.log(`${icon} ${c.name}: ${c.detail}`);
  }
  const errors = checks.filter(c => !c.ok && c.level !== 'warn');
  const warnings = checks.filter(c => !c.ok && c.level === 'warn');
  console.log(`\nNatija: ${checks.length - errors.length - warnings.length}/${checks.length} OK, ${warnings.length} warning, ${errors.length} error`);
  process.exitCode = errors.length ? 1 : 0;
}

main();