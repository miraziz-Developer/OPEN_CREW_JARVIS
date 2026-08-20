#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeUzbekSpeech } = require('../core/uzbek-speech-normalizer');

const corpusPath = path.join(__dirname, '..', 'benchmarks', 'uzbek-pronunciation-corpus.json');
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));

console.log('Uzbek speech A/B preview');
console.log('A = xom matn, B = cinematic-uzbek uchun normalizatsiya\n');
for (const sample of corpus) {
  console.log(`[${sample.id}]`);
  console.log(`A: ${sample.text}`);
  console.log(`B: ${normalizeUzbekSpeech(sample.text)}`);
  console.log('');
}