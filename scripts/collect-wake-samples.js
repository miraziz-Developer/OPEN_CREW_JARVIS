#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RATE = 16000;

function option(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find(arg => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function wavMetrics(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 46 || wav.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Yaroqsiz WAV fayl');
  }
  const dataMarker = wav.indexOf(Buffer.from('data'));
  if (dataMarker < 0 || dataMarker + 8 >= wav.length) throw new Error('WAV data chunk topilmadi');
  const start = dataMarker + 8;
  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;
  let count = 0;
  for (let i = start; i + 1 < wav.length; i += 2) {
    const sample = wav.readInt16LE(i);
    const absolute = Math.abs(sample);
    sumSquares += sample * sample;
    peak = Math.max(peak, absolute);
    if (absolute >= 32700) clipped += 1;
    count += 1;
  }
  return {
    rms: count ? Math.sqrt(sumSquares / count) : 0,
    peak,
    clippedRatio: count ? clipped / count : 0,
    durationMs: count / RATE * 1000
  };
}

function assessSample(metrics, noiseRms = 0) {
  const minimumRms = Math.max(80, noiseRms * 1.8);
  if (metrics.rms < minimumRms || metrics.peak < minimumRms * 2) {
    return { accepted: false, reason: 'ovoz juda past yoki nutq aniqlanmadi' };
  }
  if (metrics.clippedRatio > 0.002 || metrics.peak >= 32767) {
    return { accepted: false, reason: 'ovoz clipping qildi; mikrofondan sal uzoqlashing' };
  }
  return { accepted: true, reason: null };
}

function record(file, seconds) {
  return new Promise((resolve, reject) => {
    const proc = spawn('sox', [
      '-q', '-d', '-r', String(RATE), '-c', '1', '-b', '16', '-e', 'signed-integer',
      file, 'highpass', '-2', '80', 'lowpass', '-2', '7600', 'trim', '0', String(seconds)
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errorText = '';
    proc.stderr.on('data', chunk => { errorText += chunk; });
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(errorText.trim() || `sox code=${code}`)));
  });
}

function playCue() {
  return new Promise(resolve => {
    const cue = '/System/Library/Sounds/Tink.aiff';
    const proc = spawn('afplay', [cue], { stdio: 'ignore' });
    proc.on('error', resolve);
    proc.on('close', () => setTimeout(resolve, 180));
  });
}

function question(rl, prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

async function main() {
  const count = Number(option('count', '40'));
  const phrase = option('phrase', 'Jarvis');
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('--count 1..500 bo‘lishi kerak');

  const session = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.join(ROOT, 'models', 'wake-word', 'recordings', 'positive', session);
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const manifest = { phrase, sampleRate: RATE, createdAt: new Date().toISOString(), samples: [] };

  console.log('\nJARVIS shaxsiy wake-word yozuvi');
  console.log('• Audio faqat shu Mac’da saqlanadi va bulutga yuborilmaydi.');
  console.log(`• ${count} marta “${phrase}” deng: ba’zan sekin, tez, pastroq va odatiy ohangda.`);
  console.log('• Enter → signal tugaydi → so‘zni ayting. Ctrl+C bilan istalgan payt to‘xtatish mumkin.\n');

  try {
    for (let index = 1; index <= count;) {
      await question(rl, `[${index}/${count}] Tayyor bo‘lsangiz Enter bosing... `);
      const filename = `${String(index).padStart(3, '0')}.wav`;
      const file = path.join(output, filename);
      await playCue();
      process.stdout.write(`🎙  “${phrase}” deng... `);
      await record(file, 2);
      const metrics = wavMetrics(fs.readFileSync(file));
      const assessment = assessSample(metrics);
      if (!assessment.accepted) {
        fs.unlinkSync(file);
        console.log(`⚠️  ${assessment.reason} (RMS=${metrics.rms.toFixed(0)}, peak=${metrics.peak}). Qayta olamiz.`);
        continue;
      }
      manifest.samples.push({ file: filename, ...metrics });
      fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      console.log(`✅ RMS=${metrics.rms.toFixed(0)}, peak=${metrics.peak}`);
      index += 1;
    }
  } finally {
    rl.close();
  }

  console.log(`\n✅ ${manifest.samples.length} ta sample saqlandi:`);
  console.log(output);
  console.log('Keyingi bosqich: negative/background corpus va model training.');
}

if (require.main === module) {
  main().catch(error => { console.error(`\n❌ Recording: ${error.message}`); process.exitCode = 1; });
}

module.exports = { assessSample, wavMetrics };