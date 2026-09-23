'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PhoneMirror } = require('../core/phone-mirror');

const BOUNDS = { x: 100, y: 50, width: 400, height: 800 };
function fake({ bounds = BOUNDS, connected = true } = {}) {
  const calls = [];
  const pm = new PhoneMirror({
    run: async (...a) => { calls.push(a); return ''; },
    runOsa: async (...a) => { calls.push(['osa', ...a]); return connected ? '' : 'true'; },
    runJXA: async () => JSON.stringify(bounds)
  });
  return { pm, calls };
}

test('percentage coordinates map linearly onto the mirrored window bounds', () => {
  assert.deepEqual(PhoneMirror.toPoint(BOUNDS, 0, 0), { x: 100, y: 50 });
  assert.deepEqual(PhoneMirror.toPoint(BOUNDS, 1, 1), { x: 500, y: 850 });
  assert.deepEqual(PhoneMirror.toPoint(BOUNDS, 0.5, 0.5), { x: 300, y: 450 });
  assert.deepEqual(PhoneMirror.toPoint(BOUNDS, -1, 2), { x: 100, y: 850 }); // clamped
});

test('tap activates, reads bounds, and clicks the converted absolute point', async () => {
  const { pm, calls } = fake();
  const r = await pm.tap(0.25, 0.75);
  assert.deepEqual(r.tapped.point, { x: 200, y: 650 });
  const click = calls.find(c => c[0] === 'cliclick');
  assert.deepEqual(click[1], ['c:200,650']);
});

test('double tap uses dc instead of c', async () => {
  const { pm, calls } = fake();
  await pm.tap(0, 0, { double: true });
  assert.equal(calls.find(c => c[0] === 'cliclick')[1][0], 'dc:100,50');
});

test('swipe() is a generic down/move/up drag primitive (used for in-app scrolling)', async () => {
  const { pm, calls } = fake();
  await pm.swipe(0.5, 0.9, 0.5, 0.4);
  assert.deepEqual(calls.find(c => c[0] === 'cliclick')[1], ['dd:300,770', 'dm:300,370', 'du:300,370']);
});

test('home/appSwitcher/spotlight use the app\'s own View menu commands (gesture simulation was unreliable in practice)', async () => {
  const { pm, calls } = fake();
  await pm.home();
  const osaCall = calls.find(c => c[1] && String(c[1]).includes('menu item'));
  assert.match(osaCall[1], /click menu item "Home Screen" of menu "View"/);

  const { pm: pm2, calls: calls2 } = fake();
  await pm2.appSwitcher();
  assert.match(calls2.find(c => c[1] && String(c[1]).includes('menu item'))[1], /"App Switcher"/);

  const { pm: pm3, calls: calls3 } = fake();
  await pm3.spotlight();
  assert.match(calls3.find(c => c[1] && String(c[1]).includes('menu item'))[1], /"Spotlight"/);
});

test('screenshot crops to the mirrored window bounds, not the whole screen', async () => {
  const { pm, calls } = fake();
  const r = await pm.screenshot('/tmp/out.png');
  assert.equal(r.path, '/tmp/out.png');
  const cap = calls.find(c => c[0] === '/usr/sbin/screencapture');
  assert.deepEqual(cap[1], ['-x', '-R', '100,50,400,800', '/tmp/out.png']);
});

test('bounds() raises a clear error when the mirroring window is not ready', async () => {
  const pm = new PhoneMirror({ runOsa: async () => '', runJXA: async () => JSON.stringify({ x: 0, y: 0, width: 0, height: 0 }) });
  await assert.rejects(pm.bounds(), /telefon ulanmagan/);
});

test('type() sends the text via System Events keystroke after activating', async () => {
  const { pm, calls } = fake();
  await pm.type('hello "world"');
  const osaCall = calls.find(c => c[1] && String(c[1]).includes('keystroke'));
  assert.match(osaCall[1], /keystroke "hello \\"world\\""/);
});
