'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TurnJournal } = require('../core/turn-journal');

test('turn journal durably records accepted text before completion and recovers lifecycle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-turn-journal-'));
  const file = path.join(dir, 'turns.jsonl');
  const materialized = [];
  const journal = new TurnJournal({ file, materialize: turn => materialized.push(turn) });
  journal.append('turn-1', 'user.accepted', { text: 'Jarvis open Safari', source: 'realtime', audio: 'must-not-persist' });
  journal.append('turn-1', 'tool.started', { callId: 'call-1', description: 'open Safari' });
  journal.append('turn-1', 'tool.completed', { callId: 'call-1', result: 'Safari opened' });
  journal.append('turn-1', 'assistant.completed', { text: 'Safari is open.' });

  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /Jarvis open Safari/);
  assert.doesNotMatch(raw, /must-not-persist/);
  assert.equal(materialized[0].status, 'accepted');
  assert.equal(materialized.at(-1).status, 'completed');

  const recovered = new TurnJournal({ file, materialize() {} }).get('turn-1');
  assert.equal(recovered.user, 'Jarvis open Safari');
  assert.equal(recovered.assistant, 'Safari is open.');
  assert.equal(recovered.tools[0].status, 'completed');
});

test('turn journal redacts secrets and records cancellation without assistant response', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-turn-private-'));
  const file = path.join(dir, 'turns.jsonl');
  const journal = new TurnJournal({ file, materialize() {} });
  journal.append('turn-private', 'user.accepted', { text: 'remember password=hunter2' });
  journal.append('turn-private', 'turn.cancelled', { reason: 'barge-in' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /hunter2/);
  assert.match(raw, /REDACTED_PASSWORD/);
  assert.equal(journal.get('turn-private').status, 'cancelled');
});

test('startup replay rematerializes terminal turns idempotently and skips incomplete turns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-turn-replay-'));
  const file = path.join(dir, 'turns.jsonl');
  const writer = new TurnJournal({ file, materialize() {} });
  writer.append('terminal', 'user.accepted', { text: 'finish this' });
  writer.append('terminal', 'assistant.completed', { text: 'done' });
  writer.append('incomplete', 'user.accepted', { text: 'still running' });

  const records = new Map();
  const origins = [];
  const recovered = new TurnJournal({ file, materialize: turn => records.set(turn.turnId, turn) });
  recovered.on('materialized', (_turn, metrics) => origins.push(metrics.origin));
  assert.deepEqual(recovered.replay(), { replayed: 1, skipped: 1, total: 2 });
  assert.deepEqual(recovered.replay(), { replayed: 1, skipped: 1, total: 2 });
  assert.equal(records.size, 1);
  assert.equal(records.get('terminal').status, 'completed');
  assert.deepEqual(origins, ['replay', 'replay']);
});

test('restart replays a terminal turn lost before downstream materialization', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-turn-crash-'));
  const file = path.join(dir, 'turns.jsonl');
  const beforeCrash = new TurnJournal({
    file, maxRetries: 0, materialize: () => { throw new Error('storage unavailable'); }
  });
  beforeCrash.append('lost-turn', 'user.accepted', { text: 'durable request' });
  beforeCrash.append('lost-turn', 'assistant.completed', { text: 'durable answer' });

  const recovered = [];
  const afterRestart = new TurnJournal({ file, materialize: turn => recovered.push(turn) });
  assert.deepEqual(afterRestart.replay(), { replayed: 1, skipped: 0, total: 1 });
  assert.equal(recovered[0].turnId, 'lost-turn');
  assert.equal(recovered[0].status, 'completed');
});

test('watchdog closes stale accepted turns without changing terminal turns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-turn-watchdog-'));
  let now = 1000;
  const journal = new TurnJournal({
    file: path.join(dir, 'turns.jsonl'), now: () => now, materialize() {}
  });
  journal.append('stale', 'user.accepted', { text: 'waiting' });
  journal.append('done', 'user.accepted', { text: 'finished' });
  journal.append('done', 'assistant.completed', { text: 'complete' });
  now = 12001;

  assert.deepEqual(journal.sweepStale(10000), ['stale']);
  assert.equal(journal.get('stale').status, 'failed');
  assert.equal(journal.get('done').status, 'completed');
  assert.deepEqual(journal.sweepStale(10000), []);
});

test('late and conflicting events cannot regress a terminal turn status', () => {
  const journal = new TurnJournal({ materialize() {} });
  journal.append('terminal', 'user.accepted', { text: 'hello' });
  journal.append('terminal', 'turn.cancelled', { reason: 'barge-in' });
  journal.append('terminal', 'user.accepted', { text: 'late duplicate' });
  journal.append('terminal', 'assistant.completed', { text: 'late answer' });
  journal.append('terminal', 'turn.failed', { reason: 'late failure' });

  const turn = journal.get('terminal');
  assert.equal(turn.status, 'cancelled');
  assert.equal(turn.assistant, 'late answer');
  assert.equal(turn.error, 'barge-in');
});

test('partial assistant text is retained while failure remains the terminal state', () => {
  const journal = new TurnJournal({ materialize() {} });
  journal.append('partial', 'user.accepted', { text: 'explain this' });
  journal.append('partial', 'assistant.recorded', { text: 'partial answer' });
  journal.append('partial', 'turn.failed', { reason: 'connection lost' });
  assert.equal(journal.get('partial').assistant, 'partial answer');
  assert.equal(journal.get('partial').status, 'failed');
});

test('journal rotates bounded segments and retains replayable current events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-turn-rotate-'));
  const file = path.join(dir, 'turns.jsonl');
  const journal = new TurnJournal({ file, maxBytes: 220, retentionFiles: 2, materialize() {} });
  for (let index = 0; index < 8; index++) {
    journal.append('turn-' + index, 'user.accepted', { text: 'event '.repeat(8) + index });
  }
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(file + '.1'), true);
  assert.equal(fs.existsSync(file + '.3'), false);
  assert.ok(fs.statSync(file).size <= 300);
  const recovered = new TurnJournal({ file, maxBytes: 220, retentionFiles: 2, materialize() {} });
  assert.ok(recovered.turns.size >= 2);
});
test('replay skips turns whose exact state was already materialized (sidecar) and replays changed ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-journal-sidecar-'));
  const file = path.join(dir, 'turns.jsonl');
  const sidecarFile = path.join(dir, 'turns.materialized.json');
  const written = [];
  const make = () => new TurnJournal({ file, sidecarFile, materialize: turn => written.push(turn.turnId) });
  const first = make();
  first.append('t1', 'user.accepted', { text: 'hello there' });
  first.append('t1', 'assistant.completed', { text: 'hi' });
  first.append('t2', 'user.accepted', { text: 'second turn' });
  first.append('t2', 'assistant.completed', { text: 'done' });
  first._saveSidecarSoon();
  clearTimeout(first._sidecarTimer);
  first._sidecarTimer = null;
  fs.writeFileSync(sidecarFile, JSON.stringify({ version: 1, signatures: Object.fromEntries(first.signatures) }));

  written.length = 0;
  const second = make();
  const result = second.replay();
  assert.equal(result.replayed, 0);
  assert.equal(result.alreadyMaterialized, 2);
  assert.deepEqual(written, []);

  second.append('t2', 'turn.cancelled', { reason: 'later' });
  written.length = 0;
  const third = make();
  const changed = third.replay();
  assert.equal(changed.alreadyMaterialized >= 1, true);
  assert.equal(changed.replayed <= 1, true);
});

test('replayAsync yields between batches and reports the same counts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-journal-async-'));
  const file = path.join(dir, 'turns.jsonl');
  const journal = new TurnJournal({ file, materialize() {} });
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    journal.append(id, 'user.accepted', { text: 'hello ' + id });
    journal.append(id, 'assistant.completed', { text: 'ok' });
  }
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const result = await journal.replayAsync({ batch: 2, pauseMs: 5 });
  clearInterval(timer);
  assert.equal(result.replayed, 5);
  assert.ok(ticks > 0, 'event loop stayed responsive');
});
