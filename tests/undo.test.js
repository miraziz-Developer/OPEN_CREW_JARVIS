'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UndoStack, fileOps, safePath, captureSetting } = require('../core/undo');

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'undo-'));

test('move, write, trash and mkdir are all undoable', async () => {
  const h = home(), stack = new UndoStack(), f = fileOps({ stack, home: h });
  fs.writeFileSync(path.join(h, 'a.txt'), 'one');
  f.move('~/a.txt', '~/docs/a.txt');
  assert.ok(fs.existsSync(path.join(h, 'docs/a.txt')));
  assert.equal((await stack.undoLast()).ok, true);
  assert.ok(fs.existsSync(path.join(h, 'a.txt')));
  f.write('~/a.txt', 'two'); assert.equal(fs.readFileSync(path.join(h, 'a.txt'), 'utf8'), 'two');
  await stack.undoLast(); assert.equal(fs.readFileSync(path.join(h, 'a.txt'), 'utf8'), 'one');
  f.trash('~/a.txt'); assert.ok(!fs.existsSync(path.join(h, 'a.txt')));
  await stack.undoLast(); assert.ok(fs.existsSync(path.join(h, 'a.txt')));
  f.mkdir('~/x/y'); await stack.undoLast(); assert.ok(!fs.existsSync(path.join(h, 'x')));
});

test('paths outside home or in protected folders are rejected, big overwrites refused', () => {
  const h = home();
  assert.throws(() => safePath('/etc/hosts', h)); assert.throws(() => safePath('~/Library/x', h)); assert.throws(() => safePath('~', h));
  fs.writeFileSync(path.join(h, 'big'), Buffer.alloc(1024 * 1024 + 1));
  assert.throws(() => fileOps({ stack: new UndoStack(), home: h }).write('~/big', 'x'), /1 MB/);
});

test('undo of a move does not clobber an occupied original spot; empty stack is safe', async () => {
  const h = home(), stack = new UndoStack(), f = fileOps({ stack, home: h });
  fs.writeFileSync(path.join(h, 'a'), '1'); f.move('~/a', '~/b'); fs.writeFileSync(path.join(h, 'a'), 'new');
  assert.equal((await stack.undoLast()).ok, false);
  assert.equal((await new UndoStack().undoLast()).ok, false);
});

test('volume undo restores the value read beforehand and is skipped when unreadable', async () => {
  const stack = new UndoStack(), calls = [];
  await captureSetting('volume:up', { stack, run: async s => { calls.push(s); return s.startsWith('output') ? '35' : ''; } });
  await stack.undoLast(); assert.deepEqual(calls.pop(), 'set volume output volume 35');
  const s2 = new UndoStack(); await captureSetting('volume:up', { stack: s2, run: async () => { throw new Error('x'); } });
  assert.equal(s2.peek(), null);
});
