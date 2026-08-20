'use strict';

const fs = require('fs');
const path = require('path');

function words(text) {
  return String(text || '').toLocaleLowerCase('uz-UZ').normalize('NFKC')
    .replace(/[’‘`ʻ]/g, "'").replace(/[^\p{L}\p{N}']+/gu, ' ').trim().split(/\s+/).filter(Boolean);
}

function editDistance(reference, hypothesis) {
  const a = Array.isArray(reference) ? reference : words(reference);
  const b = Array.isArray(hypothesis) ? hypothesis : words(hypothesis);
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length];
}

function summarizeCorpus(corpus = {}) {
  const samples = Array.isArray(corpus.samples) ? corpus.samples : [];
  let referenceWords = 0, wordErrors = 0, truePositives = 0, falseNegatives = 0, falseWakes = 0;
  for (const sample of samples) {
    if (sample.kind === 'stt') {
      const reference = words(sample.expected);
      referenceWords += reference.length;
      wordErrors += editDistance(reference, words(sample.recognized));
    } else if (sample.kind === 'wake') {
      if (sample.expectedWake && sample.detected) truePositives++;
      else if (sample.expectedWake && !sample.detected) falseNegatives++;
      else if (!sample.expectedWake && sample.detected) falseWakes++;
    }
  }
  return {
    voice: {
      truePositives, falseNegatives, falseWakes,
      hours: Number(corpus.observationHours) || 0,
      referenceWords,
      correctWords: Math.max(0, referenceWords - wordErrors),
      wordErrors
    },
    corpus: { samples: samples.length, sttSamples: samples.filter(item => item.kind === 'stt').length, wakeSamples: samples.filter(item => item.kind === 'wake').length }
  };
}

function loadCorpus(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return { version: 1, observationHours: 0, samples: [] }; }
}

function saveCorpus(file, corpus) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(corpus, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

module.exports = { words, editDistance, summarizeCorpus, loadCorpus, saveCorpus };