#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadVoiceTelemetry } = require('../core/voice-telemetry');

const ROOT = path.resolve(__dirname, '..');
const input = process.argv.find(arg => arg.startsWith('--input='))?.slice(8) || path.join(ROOT, '.run', 'voice-flight-recorder.jsonl');
// --since=24h / --since=7d limits the report to recent conversations.
const sinceArg = process.argv.find(arg => arg.startsWith('--since='))?.slice(8);
const sinceMatch = /^(\d+)([hd])$/.exec(sinceArg || '');
const since = sinceMatch ? Date.now() - Number(sinceMatch[1]) * (sinceMatch[2] === 'd' ? 86400000 : 3600000) : undefined;
const report = loadVoiceTelemetry(path.resolve(input), { maxLines: Infinity, ...(since ? { since } : {}) });
const outDir = path.join(ROOT, 'reports');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'voice-latest.json'), JSON.stringify(report, null, 2));

console.log(`Turns: ${report.totals.turns} | completed ${report.totals.completed} | suppressed ${report.totals.suppressed} | failed ${report.totals.failed}`);
console.log(`Response to first audio: p50=${report.latency.firstAudioP50Ms ?? 'n/a'}ms p95=${report.latency.firstAudioP95Ms ?? 'n/a'}ms (${report.latency.measuredTurns} measured)`);
if (Object.keys(report.suppressionReasons).length) console.log('Suppression:', report.suppressionReasons);

// Targets for a voice that never cuts out. Each line says pass or what to look at.
const q = report.quality;
const checks = [
  ['False interruptions (own voice/noise paused a reply)', q.falseInterruptions, q.falseInterruptions === 0],
  ['Daemon stalls >=150 ms while speaking (audible gaps)', `${q.speakingStalls} of ${q.speakingLoopSamples} samples, max ${q.speakingLoopMaxMs ?? 'n/a'} ms`, q.speakingStalls === 0],
  ['Native echo cancellation sessions', `${q.nativeEchoCancellation} of ${q.sessions}`, q.sessions === 0 || q.nativeEchoCancellation >= q.sessions],
  ['First audio p95 under 2.5 s', `${report.latency.firstAudioP95Ms ?? 'n/a'} ms`, (report.latency.firstAudioP95Ms ?? 0) <= 2500],
  ['Failed turns under 2%', `${report.rates.failurePct ?? 0}%`, (report.rates.failurePct ?? 0) < 2]
];
console.log(`\nQuality (${q.repliesPlayed} replies played, cancelled: ${JSON.stringify(q.cancelledResponses)}):`);
for (const [name, value, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${value}`);
const slowTools = Object.entries(q.toolLatency).sort((a, b) => (b[1].p95Ms || 0) - (a[1].p95Ms || 0));
if (slowTools.length) console.log('Tool time (silent while running):', slowTools.map(([tool, t]) => `${tool} p50=${t.p50Ms}ms p95=${t.p95Ms}ms (${t.calls})`).join(' | '));