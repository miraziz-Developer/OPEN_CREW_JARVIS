'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { audit } = require('../scripts/diagnose-memory');

test('memory audit correlates shared turn ids without exposing transcript content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-audit-'));
  const journalFile = path.join(dir, 'journal.jsonl');
  const memoryFile = path.join(dir, 'memory.json');
  fs.writeFileSync(journalFile, [
    JSON.stringify({ turnId: 'one', type: 'user.accepted', data: { text: 'private words' } }),
    JSON.stringify({ turnId: 'one', type: 'assistant.completed', data: { text: 'done' } }),
    JSON.stringify({ turnId: 'two', type: 'user.accepted', data: { text: 'other words' } })
  ].join('\n'));
  fs.writeFileSync(memoryFile, JSON.stringify({ records: [{ id: 'turn:one' }] }));

  const result = await audit({ journalFile, memoryFile });
  assert.equal(result.healthy, false);
  assert.deepEqual(result.missingFromMemory, ['two']);
  assert.deepEqual(result.incomplete, ['two']);
  assert.equal(result.counts.embeddings >= 0, true);
  assert.doesNotMatch(JSON.stringify(result), /private words|other words/);
});