#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { evaluateQuality } = require('../core/quality-gates');
const { loadVoiceTelemetry } = require('../core/voice-telemetry');
const { loadCorpus, summarizeCorpus } = require('../core/voice-benchmark-corpus');

const ROOT = path.resolve(__dirname, '..');
const runtimeFile = path.join(ROOT, '.jarvis-runtime.json');
const samplesFile = process.argv.find(arg => arg.startsWith('--samples='))?.slice(10);

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function percent(part, total) { return total > 0 ? Math.round((part / total) * 10000) / 100 : NaN; }

function metricsFrom(runtime, samples, telemetry = {}) {
  const tasks = runtime?.tasks || [];
  const terminal = tasks.filter(task => ['verified', 'failed', 'cancelled'].includes(task.state));
  const verified = terminal.filter(task => task.state === 'verified');
  const voice = samples?.voice || {};
  return {
    wakeRecallPct: percent(voice.truePositives, voice.truePositives + voice.falseNegatives),
    falseWakesPerDay: Number.isFinite(voice.falseWakes) && Number.isFinite(voice.hours) && voice.hours > 0 ? Math.round((voice.falseWakes / voice.hours) * 2400) / 100 : NaN,
    sttAccuracyPct: Number.isFinite(voice.correctWords) && Number.isFinite(voice.referenceWords) ? percent(voice.correctWords, voice.referenceWords) : NaN,
    firstAudioP95Ms: telemetry?.latency?.firstAudioP95Ms ?? runtime?.latency?.['first-audio']?.p95Ms ?? runtime?.latency?.['wake-to-response']?.p95Ms ?? NaN,
    taskVerifiedSuccessPct: percent(verified.length, terminal.length),
    duplicateActions: samples?.missions?.duplicateActions ?? NaN,
    falseCompletionClaims: samples?.missions?.falseCompletionClaims ?? NaN
  };
}

const runtime = readJson(runtimeFile, {});
const privateCorpusFile = path.join(ROOT, 'benchmarks', 'private', 'voice-corpus.json');
const corpusSamples = fs.existsSync(privateCorpusFile) ? summarizeCorpus(loadCorpus(privateCorpusFile)) : {};
const samples = samplesFile ? readJson(path.resolve(samplesFile), {}) : corpusSamples;
const voiceTelemetryFile = path.join(ROOT, '.run', 'voice-flight-recorder.jsonl');
const telemetry = loadVoiceTelemetry(voiceTelemetryFile);
const metrics = metricsFrom(runtime, samples, telemetry);
const evaluation = evaluateQuality(metrics);
const report = { generatedAt: new Date().toISOString(), sources: { runtime: fs.existsSync(runtimeFile), voiceTelemetry: fs.existsSync(voiceTelemetryFile), samples: samplesFile || (fs.existsSync(privateCorpusFile) ? 'private-corpus' : null) }, metrics, corpus: corpusSamples.corpus || null, voiceTelemetry: telemetry, ...evaluation };

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