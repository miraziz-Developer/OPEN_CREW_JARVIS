'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryOS, redactSensitive } = require('../core/memory-os');

function store(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-os-'));
  return new MemoryOS({ file: path.join(dir, 'memory.json'), ...options });
}

test('five-layer memory ranks relevant active records and expires working memory', () => {
  let now = 1000;
  const memory = store({ now: () => now });
  memory.remember({ layer: 'working', title: 'Current task', content: 'GitHub release tekshirish', ttlMs: 100 });
  memory.remember({ layer: 'semantic', title: 'Project fact', content: 'Jarvis Node.js da ishlaydi', confidence: 0.9 });
  assert.equal(memory.retrieve('GitHub release')[0].layer, 'working');
  now = 1200;
  assert.equal(memory.retrieve('GitHub release').length, 0);
  assert.equal(memory.purgeExpired().purged, 1);
});

test('contradicting facts supersede old truth and matching evidence reinforces it', () => {
  const memory = store();
  const first = memory.remember({ layer: 'user_profile', title: 'Editor', content: 'VS Code', fact: { subject: 'user', predicate: 'preferred_editor', object: 'VS Code' }, confidence: 0.7 });
  const second = memory.remember({ layer: 'user_profile', title: 'Editor changed', content: 'Cursor', fact: { subject: 'user', predicate: 'preferred_editor', object: 'Cursor' }, confidence: 0.8 });
  assert.equal(memory.snapshot().records.find(record => record.id === first.record.id).status, 'superseded');
  assert.equal(memory.remember({ fact: { subject: 'user', predicate: 'preferred_editor', object: 'Cursor' }, content: 'confirmed' }).status, 'reinforced');
  assert.equal(memory.retrieve('Cursor')[0].id, second.record.id);
});

test('secrets are redacted before persistence and entity graph links evidence', () => {
  const memory = store();
  const result = memory.remember({ title: 'Credential', content: 'api_key=super-secret-token-value-123456789', entities: [{ name: 'OpenAI', type: 'service' }, { name: 'Jarvis', type: 'project' }] });
  assert.equal(result.record.redacted, true);
  assert.doesNotMatch(JSON.stringify(memory.snapshot()), /super-secret-token/);
  assert.equal(memory.snapshot().relations.length, 1);
  assert.equal(redactSensitive('password=hunter2').text, '[REDACTED_PASSWORD]');
});

test('legacy markdown migration is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-legacy-'));
  fs.writeFileSync(path.join(dir, '2026-01-01.md'), '# Day\n\n---\n## 10:00 — Test\nLegacy event\n');
  const memory = store();
  assert.equal(memory.migrateLegacy({ memoryDir: dir }).imported, 1);
  assert.equal(memory.migrateLegacy({ memoryDir: dir }).skipped, true);
  assert.equal(memory.snapshot().records.length, 1);
});

test('explicit turn id updates one durable record instead of duplicating it', () => {
  const memory = store();
  memory.remember({ id: 'turn:abc', title: 'Voice turn', content: 'accepted', tags: ['accepted'] });
  const updated = memory.remember({ id: 'turn:abc', title: 'Voice turn', content: 'completed', tags: ['completed'] });
  assert.equal(updated.status, 'updated');
  assert.equal(memory.snapshot().records.length, 1);
  assert.equal(memory.snapshot().records[0].content, 'completed');
  assert.deepEqual(memory.snapshot().records[0].tags, ['completed']);
});