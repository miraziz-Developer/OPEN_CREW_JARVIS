#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadVoiceTelemetry } = require('../core/voice-telemetry');

const ROOT = path.resolve(__dirname, '..');
const input = process.argv.find(arg => arg.startsWith('--input='))?.slice(8) || path.join(ROOT, '.run', 'voice-flight-recorder.jsonl');
const report = loadVoiceTelemetry(path.resolve(input));
const outDir = path.join(ROOT, 'reports');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'voice-latest.json'), JSON.stringify(report, null, 2));

console.log(`Turns: ${report.totals.turns} | completed ${report.totals.completed} | suppressed ${report.totals.suppressed} | failed ${report.totals.failed}`);
console.log(`Response to first audio: p50=${report.latency.firstAudioP50Ms ?? 'n/a'}ms p95=${report.latency.firstAudioP95Ms ?? 'n/a'}ms (${report.latency.measuredTurns} measured)`);
if (Object.keys(report.suppressionReasons).length) console.log('Suppression:', report.suppressionReasons);