#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { evaluateQuality } = require('../core/quality-gates');

const ROOT = path.resolve(__dirname, '..');
const runtimeFile = path.join(ROOT, '.jarvis-runtime.json');
const samplesFile = process.argv.find(arg => arg.startsWith('--samples='))?.slice(10);

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function percent(part, total) { return total > 0 ? Math.round((part / total) * 10000) / 100 : NaN; }

function metricsFrom(runtime, samples) {
  const tasks = runtime?.tasks || [];
  const terminal = tasks.filter(task => ['verified', 'failed', 'cancelled'].includes(task.state));
  const verified = terminal.filter(task => task.state === 'verified');
  const voice = samples?.voice || {};
  return {
    wakeRecallPct: percent(voice.truePositives, voice.truePositives + voice.falseNegatives),
    falseWakesPerDay: Number.isFinite(voice.falseWakes) && Number.isFinite(voice.hours) && voice.hours > 0 ? Math.round((voice.falseWakes / voice.hours) * 2400) / 100 : NaN,
    sttAccuracyPct: Number.isFinite(voice.correctWords) && Number.isFinite(voice.referenceWords) ? percent(voice.correctWords, voice.referenceWords) : NaN,
    firstAudioP95Ms: runtime?.latency?.['first-audio']?.p95Ms ?? runtime?.latency?.['wake-to-response']?.p95Ms ?? NaN,
    taskVerifiedSuccessPct: percent(verified.length, terminal.length),
    duplicateActions: samples?.missions?.duplicateActions ?? NaN,
    falseCompletionClaims: samples?.missions?.falseCompletionClaims ?? NaN
  };
}

const runtime = readJson(runtimeFile, {});
const samples = samplesFile ? readJson(path.resolve(samplesFile), {}) : {};
const metrics = metricsFrom(runtime, samples);
const evaluation = evaluateQuality(metrics);
const report = { generatedAt: new Date().toISOString(), sources: { runtime: fs.existsSync(runtimeFile), samples: samplesFile || null }, metrics, ...evaluation };

for (const [name, item] of Object.entries(evaluation.results)) {
  const icon = item.status === 'pass' ? '✅' : item.status === 'fail' ? '❌' : '⬜';
  console.log(`${icon} ${name}: ${item.value ?? 'not_measured'} (target ${item.direction} ${item.target})`);
}
console.log(`\nCoverage: ${evaluation.measured}/${evaluation.total}. Overall gate: ${evaluation.pass ? 'PASS' : 'INCOMPLETE/FAIL'}`);
const outDir = path.join(ROOT, 'reports');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'quality-latest.json'), JSON.stringify(report, null, 2));

// Baseline measurement is informative until a complete labelled voice/mission corpus exists.
if (process.argv.includes('--strict') && !evaluation.pass) process.exitCode = 1;

module.exports = { metricsFrom };