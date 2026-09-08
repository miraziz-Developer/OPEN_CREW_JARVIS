#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { buildCalibration, estimateEchoLag, saveCalibration } = require('../core/audio-calibration');
const { buildSpeechFilterArgs } = require('../core/mic-capture');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.run', 'audio-calibration.json');
const RATE = 16000;
let ENV = {};
try {
  ENV = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
    .map(line => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)).filter(Boolean)
    .map(match => [match[1], match[2].trim()]));
} catch (_) {}
const MIC_FILTER_OPTIONS = {
  sampleRate: RATE,
  filterEnabled: !/^(?:false|0|no|off)$/i.test(ENV.MIC_FILTER_ENABLED || 'true'),
  highpassHz: Number(ENV.MIC_HIGHPASS_HZ) || 80,
  lowpassHz: Number(ENV.MIC_LOWPASS_HZ) || 7600
};

function wavHeader(bytes) {
  const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(bytes, 40); return h;
}
function probeWav() {
  const samples = Math.floor(RATE * 0.45), pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / RATE, fade = Math.sin(Math.PI * i / samples) ** 2;
    const frequency = 500 + 1800 * (i / samples);
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * t) * 7000 * fade), i * 2);
  }
  return Buffer.concat([wavHeader(pcm.length), pcm]);
}
function recordWav(seconds, onStarted) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const proc = spawn('sox', [
      '-q', '-d', '-t', 'wav', '-r', String(RATE), '-c', '1', '-b', '16',
      '-e', 'signed-integer', '-', ...buildSpeechFilterArgs(MIC_FILTER_OPTIONS),
      'trim', '0', String(seconds)
    ]);
    proc.stdout.on('data', chunk => chunks.push(chunk));
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('sox yozuvi tugamadi (code=' + code + ')')));
    setTimeout(() => onStarted?.(), 250);
  });
}
function play(file) {
  return new Promise(resolve => { const p = spawn('afplay', [file], { stdio: 'ignore' }); p.on('close', resolve); p.on('error', resolve); });
}

async function main() {
  console.log('JARVIS audio calibration — audio bulutga yuborilmaydi va raw yozuv saqlanmaydi.');
  console.log('1/3: 4 soniya jim turing...');
  const silence = await recordWav(4);
  console.log('2/3: 6 soniya odatiy masofadan tabiiy ovozda gapiring...');
  const speech = await recordWav(6);
  console.log('3/3: echo yo‘li o‘lchanmoqda; qisqa signal eshitiladi...');
  const temp = path.join(os.tmpdir(), 'jarvis-calibration-probe-' + process.pid + '.wav');
  const probe = probeWav(); fs.writeFileSync(temp, probe, { mode: 0o600 });
  let echo = null;
  try {
    const echoRecording = await recordWav(2.2, () => setTimeout(() => play(temp), 150));
    echo = estimateEchoLag(echoRecording, probe, { expectedStartMs: 400 });
  } finally { try { fs.unlinkSync(temp); } catch (_) {} }
  const profile = buildCalibration({ silence, speech, echo });
  saveCalibration(OUT, profile);
  console.log('\n✅ Calibration saqlandi: ' + OUT);
  console.log(JSON.stringify({ measurements: profile.measurements, recommended: profile.recommended, privacy: profile.privacy }, null, 2));
  console.log('Profil keyingi daemon restartida avtomatik ishlaydi; .env dagi explicit qiymatlar ustun.');
}

main().catch(error => { console.error('❌ Calibration: ' + error.message); process.exitCode = 1; });