#!/usr/bin/env node
'use strict';

const path = require('path');
const { loadCorpus, saveCorpus, summarizeCorpus } = require('../core/voice-benchmark-corpus');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'benchmarks', 'private', 'voice-corpus.json');
const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--') && x.includes('=')).map(x => { const i = x.indexOf('='); return [x.slice(2, i), x.slice(i + 1)]; }));
const flags = new Set(process.argv.slice(2).filter(x => x.startsWith('--') && !x.includes('=')));
const corpus = loadCorpus(FILE);
corpus.version = 1; corpus.samples ||= [];

if (args.hours !== undefined) corpus.observationHours = Number(args.hours);
if (flags.has('--stt')) {
  if (!args.expected || args.recognized === undefined) throw new Error('--stt uchun --expected="..." va --recognized="..." kerak');
  corpus.samples.push({ kind: 'stt', expected: args.expected, recognized: args.recognized, at: new Date().toISOString() });
}
if (flags.has('--wake')) {
  if (!['true', 'false'].includes(args.expected) || !['true', 'false'].includes(args.detected)) throw new Error('--wake uchun --expected=true|false va --detected=true|false kerak');
  corpus.samples.push({ kind: 'wake', expectedWake: args.expected === 'true', detected: args.detected === 'true', at: new Date().toISOString() });
}
if (flags.has('--clear')) { corpus.samples = []; corpus.observationHours = 0; }
saveCorpus(FILE, corpus);
console.log('Private corpus: ' + FILE + ' (raw audio yo‘q, Git ignored, mode 0600)');
console.log(JSON.stringify(summarizeCorpus(corpus), null, 2));