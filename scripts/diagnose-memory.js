#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { PROJECT_DIR } = require('../core/paths');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function audit(options = {}) {
  const journalFile = options.journalFile || path.join(PROJECT_DIR, '.run', 'addressed-turns.jsonl');
  const memoryFile = options.memoryFile || process.env.JARVIS_MEMORY_OS_FILE || path.join(PROJECT_DIR, '.jarvis-memory-os.json');
  const embedFile = options.embedFile || path.join(PROJECT_DIR, '.memory-embeddings.json');
  const journalIds = new Set();
  const latest = new Map();
  if (fs.existsSync(journalFile)) {
    for (const line of fs.readFileSync(journalFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        journalIds.add(event.turnId);
        latest.set(event.turnId, event.type);
      } catch (_) {}
    }
  }
  const memory = readJson(memoryFile, { records: [] });
  const memoryIds = new Set((memory.records || []).filter(record => String(record.id).startsWith('turn:')).map(record => String(record.id).slice(5)));
  const embed = readJson(embedFile, { entries: [] });
  const missingFromMemory = [...journalIds].filter(id => !memoryIds.has(id));
  const orphanedMemory = [...memoryIds].filter(id => !journalIds.has(id));
  const incomplete = [...latest].filter(([, type]) => !['assistant.completed', 'turn.cancelled', 'turn.failed'].includes(type)).map(([id]) => id);
  return {
    healthy: missingFromMemory.length === 0,
    counts: { journalTurns: journalIds.size, memoryTurns: memoryIds.size, embeddings: (embed.entries || []).length },
    missingFromMemory, orphanedMemory, incomplete,
    privacy: { rawAudioPersisted: false, reportIncludesTranscriptText: false }
  };
}

if (require.main === module) {
  const result = audit();
  console.log(JSON.stringify(result, null, 2));
  if (!result.healthy) process.exitCode = 1;
}

module.exports = { audit };