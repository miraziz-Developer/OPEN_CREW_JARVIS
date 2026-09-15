#!/usr/bin/env node
'use strict';

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadCalibration } = require('../core/audio-calibration');
const { buildSpeechFilterArgs } = require('../core/mic-capture');
const { commandForPid, findMatchingProcesses, inspectRuntimeOwner, inspectVoiceOwnership } = require('../core/runtime-health');

const ROOT = path.resolve(__dirname, '..');
const calibrationFile = path.join(ROOT, '.run', 'audio-calibration.json');
const calibration = loadCalibration(calibrationFile);
console.log(calibration
  ? `✅ Audio calibration: ${calibration.createdAt} | noise=${calibration.measurements?.noiseRmsP95} speech=${calibration.measurements?.speechRmsP50} echo=${calibration.measurements?.echoLagMs ?? 'n/a'}ms`
  : '⚠️ Audio calibration yo‘q — `npm run voice:calibrate` tavsiya qilinadi');
const checks = [];
const add = (name, ok, detail, level = ok ? 'ok' : 'error') => checks.push({ name, ok, detail, level });

function envFile() {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    return Object.fromEntries(text.split(/\r?\n/).filter(line => line && !line.startsWith('#') && line.includes('='))
      .map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).trim()]; }));
  } catch (_) { return {}; }
}

function parentPid(pid) {
  try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); }
  catch (_) { return 0; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function checkBinary(name) {
  const r = spawnSync('which', [name], { encoding: 'utf8' });
  add(`binary:${name}`, r.status === 0, r.status === 0 ? r.stdout.trim() : 'topilmadi');
}

function checkWakeModels(env) {
  const builtins = new Set(['alexa', 'hey_mycroft', 'hey_jarvis', 'hey_rhasspy', 'timer', 'weather']);
  const configured = String(env.OPENWAKEWORD_MODELS || 'hey_jarvis').split(',').map(item => item.trim()).filter(Boolean);
  const missing = configured.filter(item => {
    if (builtins.has(item)) return false;
    const modelPath = path.isAbsolute(item) ? item : path.resolve(ROOT, item);
    return !fs.existsSync(modelPath);
  });
  add('wakeword:models', missing.length === 0,
    missing.length ? `model topilmadi: ${missing.join(', ')}` : `tayyor: ${configured.join(', ')}`,
    missing.length ? 'warn' : 'ok');
}

function envEnabled(value, defaultValue = false) {
  if (value === undefined || value === '') return defaultValue;
  return !/^(?:false|0|no|off)$/i.test(value);
}

function checkWhisperWake(env) {
  const enabled = envEnabled(env.WHISPER_WAKE_ENABLED);
  if (!enabled) {
    add('wakeword:whisper-fallback', true, 'config orqali o‘chirilgan');
    return;
  }

  const binary = env.WHISPER_WAKE_BINARY;
  const model = env.WHISPER_WAKE_MODEL;
  const binaryReady = Boolean(binary && path.isAbsolute(binary) && fs.existsSync(binary));
  const modelReady = Boolean(model && path.isAbsolute(model) && fs.existsSync(model));
  add('wakeword:whisper-binary', binaryReady,
    binaryReady ? binary : 'absolute WHISPER_WAKE_BINARY topilmadi');
  add('wakeword:whisper-model', modelReady,
    modelReady ? `${model} (${Math.round(fs.statSync(model).size / 1024 / 1024)} MiB)` : 'absolute WHISPER_WAKE_MODEL topilmadi');

  let flagsReady = false;
  if (binaryReady) {
    const result = spawnSync(binary, ['--help'], { encoding: 'utf8', timeout: 5000 });
    const help = `${result.stdout || ''}\n${result.stderr || ''}`;
    // Homebrew's Apple Metal build can return a non-zero code after it has
    // already printed valid help while initializing a backend. The supported
    // options themselves are the compatibility contract used by the detector.
    flagsReady = !result.error && ['-m', '-f', '-l', '-nt', '-otxt', '-of'].every(flag => help.includes(flag));
  }
  add('wakeword:whisper-cli-flags', flagsReady,
    flagsReady ? 'kerakli -m -f -l -nt -otxt -of flaglari mavjud' : 'whisper-cli flaglari mos emas yoki --help ishlamadi');
}

function checkMic(env) {
  const out = path.join('/tmp', `jarvis-diagnostic-${process.pid}.wav`);
  const filterOptions = {
    sampleRate: 16000,
    filterEnabled: !/^(?:false|0|no|off)$/i.test(env.MIC_FILTER_ENABLED || 'true'),
    highpassHz: Number(env.MIC_HIGHPASS_HZ) || 80,
    lowpassHz: Number(env.MIC_LOWPASS_HZ) || 7600
  };
  const r = spawnSync('sox', [
    '-q', '-d', '-r', '16000', '-c', '1', '-b', '16', out,
    ...buildSpeechFilterArgs(filterOptions), 'trim', '0', '0.35'
  ], {
    encoding: 'utf8', timeout: 4000
  });
  let size = 0;
  let rms = 0;
  let peak = 0;
  try {
    const wav = fs.readFileSync(out);
    size = wav.length;
    // SoX yozgan PCM16 WAV uchun data chunk odatda 44-baytdan boshlanadi.
    // Diagnostika speech detector emas: uning vazifasi CoreAudio mutlaq nolga
    // yaqin sample berayotganini ilg'ash. Shuning uchun juda past floor yetarli.
    let sumSquares = 0;
    let samples = 0;
    for (let i = 44; i + 1 < wav.length; i += 2) {
      const value = wav.readInt16LE(i);
      peak = Math.max(peak, Math.abs(value));
      sumSquares += value * value;
      samples += 1;
    }
    rms = samples ? Math.sqrt(sumSquares / samples) : 0;
    fs.unlinkSync(out);
  } catch (_) {}
  const hasSignal = rms >= 2 || peak >= 8;
  add('microphone:capture', r.status === 0 && size > 1000 && hasSignal,
    r.status === 0
      ? `${size} byte, RMS=${rms.toFixed(1)}, peak=${peak}${hasSignal ? '' : ' — mikrofon signal bermayapti/mute bo‘lishi mumkin'}`
      : (r.stderr || r.error?.message || 'capture xato').trim().slice(-300));
}

function loadRuntime() {
  let runtime;
  try { runtime = JSON.parse(fs.readFileSync(path.join(ROOT, '.jarvis-runtime.json'), 'utf8')); }
  catch (_) { add('runtime:state', false, '.jarvis-runtime.json yo‘q yoki buzilgan', 'warn'); return null; }
  return runtime;
}

function checkRuntime(runtime, owner) {
  if (!runtime) return;
  const daemon = runtime.components?.['voice-daemon'];
  const mic = runtime.components?.microphone;
  add('runtime:daemon-heartbeat', owner.heartbeatFresh, daemon ? `${daemon.state || daemon.status || 'unknown'}, age=${daemon.ageMs}ms` : 'heartbeat yo‘q');
  add('runtime:owner', owner.healthy,
    owner.pid ? `pid=${owner.pid}, alive=${owner.pidAlive}, command=${owner.commandMatches ? 'voice-daemon' : 'mismatch'}, heartbeat-owner=${owner.heartbeatOwnsSnapshot}` : 'snapshot PID yo‘q');
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
  const voiceLiveReady = Boolean(env.AZURE_VOICELIVE_ENDPOINT && env.AZURE_VOICELIVE_KEY);
  const realtimeReady = Boolean(env.AZURE_REALTIME_ENDPOINT && env.AZURE_REALTIME_KEY);
  add('config:voice-live', voiceLiveReady, voiceLiveReady ? 'primary provider tayyor' : 'endpoint/key yetishmaydi', 'warn');
  add('config:realtime-fallback', realtimeReady, realtimeReady ? 'gpt-realtime-1.5 fallback tayyor' : 'endpoint/key yetishmaydi', 'warn');
  const daemonProcesses = findMatchingProcesses(path.join(ROOT, 'jarvis_daemon.js'));
  const sentinelProcesses = findMatchingProcesses(path.join(ROOT, 'scripts', 'pause-sentinel.js'));
  add('process:voice-daemon', daemonProcesses.length === 1, daemonProcesses.length ? `pid=${daemonProcesses.map(p => p.pid).join(',')}` : 'ishlamayapti', 'warn');
  add('process:pause-sentinel', sentinelProcesses.length === 1, sentinelProcesses.length ? `pid=${sentinelProcesses.map(p => p.pid).join(',')}` : 'ishlamayapti', 'warn');
  const runtime = loadRuntime();
  const runtimeOwner = inspectRuntimeOwner(runtime, { pidAlive, commandForPid });
  const daemonPids = daemonProcesses.map(process => process.pid);
  const wakePids = findMatchingProcesses(path.join(ROOT, 'scripts', 'openwakeword-worker.py')).map(process => process.pid);
  const ownership = inspectVoiceOwnership({ daemonPids, wakePids, parentPid, runtimeOwner });
  add('process:single-voice-owner', ownership.healthy,
    `daemon=${ownership.daemonPids.length}, wake-worker=${ownership.wakePids.length}, orphan=${ownership.orphanWakePids.length}${ownership.orphanWakePids.length ? ` (pid ${ownership.orphanWakePids.join(',')})` : ''}`);
  const openWakeEnabled = envEnabled(env.OPENWAKEWORD_ENABLED, true);
  if (openWakeEnabled) checkWakeModels(env);
  add('wakeword:local-worker', !openWakeEnabled || wakePids.length === 1,
    openWakeEnabled ? (wakePids.length === 1 ? `openWakeWord pid=${wakePids[0]}` : `kutilgan 1 ta worker, topildi ${wakePids.length}`) : 'config orqali o‘chirilgan',
    openWakeEnabled ? 'error' : 'ok');
  checkWhisperWake(env);
  checkMic(env);
  checkRuntime(runtime, runtimeOwner);

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