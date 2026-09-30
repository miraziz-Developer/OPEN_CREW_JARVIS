'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { BrainArbiter, MemoryPressureError } = require('../core/brain/arbiter');
const { routeTask, isHardTask } = require('../core/brain/router');
const { parseVmStat } = require('../core/brain/memory');

const GB = 2 ** 30;

test('router: audio → gemma, hard → bonsai (with qwen fallback), images and general → qwen', () => {
  assert.equal(routeTask({ text: 'what is this?', audio: ['a.wav'] }).model, 'gemma4:e2b');
  const hard = routeTask({ text: 'Make a step-by-step plan and deep analysis of the architecture' });
  assert.equal(hard.backend, 'bonsai'); assert.equal(hard.fallback.model, 'qwen3.5:9b');
  assert.equal(routeTask({ text: 'what is on my screen?', images: ['s.png'] }).model, 'qwen3.5:9b');
  assert.equal(routeTask({ text: 'open safari' }).model, 'qwen3.5:9b');
  assert.equal(routeTask({ text: 'analysis', hard: false }).model, 'qwen3.5:9b');   // aniq ko'rsatma ustun
  assert.equal(routeTask({ text: 'hi', hard: true }).backend, 'bonsai');
  assert.equal(isHardTask('x'.repeat(3000)), true);
  assert.equal(isHardTask('chrome och'), false);
});

test('memory: vm_stat counts free + inactive + speculative + purgeable pages', () => {
  const sample = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  100000.\nPages active: 500000.\nPages inactive: 200000.\nPages speculative: 10000.\nPages purgeable: 5000.\n';
  assert.equal(parseVmStat(sample), (100000 + 200000 + 10000 + 5000) * 16384);
});

function makeArbiter({ free = 12 * GB } = {}) {
  const events = [];
  const arbiter = new BrainArbiter({
    backends: { ollama: { evict: async () => events.push('evict:ollama') }, bonsai: { evict: async () => events.push('evict:bonsai') } },
    availableBytes: async () => free, requirements: { bonsai: 9 * GB }
  });
  return { arbiter, events };
}

test('arbiter: only one backend resident; switching waits for in-flight work and evicts the previous one', async () => {
  const { arbiter, events } = makeArbiter();
  const r1 = await arbiter.acquire('ollama');
  const r2 = await arbiter.acquire('ollama');                // bir xil backend — kutmaydi
  assert.deepEqual(arbiter.status(), { resident: 'ollama', inFlight: 2 });
  let bonsaiGranted = false;
  const pending = arbiter.acquire('bonsai').then(rel => { bonsaiGranted = true; return rel; });
  await new Promise(r => setImmediate(r));
  assert.equal(bonsaiGranted, false);                        // ollama ishlayotganda bonsai yuklanmaydi
  r1(); await new Promise(r => setImmediate(r));
  assert.equal(bonsaiGranted, false);
  r2(); const r3 = await pending;
  assert.equal(bonsaiGranted, true);
  assert.deepEqual(events, ['evict:ollama']);
  assert.equal(arbiter.status().resident, 'bonsai');
  r3(); r3();                                                // ikki marta release — xavfsiz
  assert.equal(arbiter.status().inFlight, 0);
});

test('arbiter: refuses bonsai when memory is short (caller falls back) and keeps serving afterwards', async () => {
  const { arbiter } = makeArbiter({ free: 6 * GB });
  await assert.rejects(arbiter.acquire('bonsai'), MemoryPressureError);
  const rel = await arbiter.acquire('ollama');               // zanjir uzilmagan
  assert.equal(arbiter.status().resident, 'ollama'); rel();
});

const { createBrainService } = require('../core/brain/service');

function fakeService({ free = 12 * GB, bonsaiFails = false } = {}) {
  const calls = [];
  let t = 0;
  const ollama = { port: 0, loaded: async () => [], evict: async () => calls.push('evict:ollama'), chat: async r => { calls.push('ollama:' + r.model); return { text: 'q', usage: {} }; } };
  let running = false;
  const bonsai = { installed: () => true, running: () => running, evict: async () => { running = false; calls.push('evict:bonsai'); },
    chat: async () => { if (bonsaiFails) throw new Error('boom'); running = true; calls.push('bonsai'); return { text: 'b', usage: {} }; } };
  const svc = createBrainService({ ollama, bonsai, availableBytes: async () => free, bonsaiNeedBytes: 9 * GB, bonsaiIdleMs: 1000, now: () => t });
  return { svc, calls, tick: ms => { t += ms; } };
}

test('brain: routes by task and swaps backends one at a time', async () => {
  const { svc, calls } = fakeService();
  assert.equal((await svc.think({ user: 'open safari' })).model, 'qwen3.5:9b');
  const hard = await svc.think({ user: 'deep analysis of this architecture', hard: true });
  assert.equal(hard.backend, 'bonsai');
  assert.equal((await svc.think({ user: 'what is this', audio: ['AAAA'] })).model, 'gemma4:e2b');
  assert.deepEqual(calls, ['ollama:qwen3.5:9b', 'evict:ollama', 'bonsai', 'evict:bonsai', 'ollama:gemma4:e2b']);
});

test('brain: hard task falls back to qwen when memory is short or bonsai fails', async () => {
  const low = fakeService({ free: 5 * GB });
  const r1 = await low.svc.think({ user: 'x', hard: true });
  assert.equal(r1.model, 'qwen3.5:9b'); assert.equal(r1.fallback, 'memory');
  const broken = fakeService({ bonsaiFails: true });
  const r2 = await broken.svc.think({ user: 'x', hard: true });
  assert.equal(r2.model, 'qwen3.5:9b'); assert.equal(r2.fallback, 'error');
});

test('brain: idle bonsai is stopped and its RAM released', async () => {
  const { svc, calls, tick } = fakeService();
  await svc.think({ user: 'x', hard: true });
  await svc.idleSweep(); assert.ok(!calls.includes('evict:bonsai'));   // hali yangi
  tick(5000); await svc.idleSweep();
  assert.ok(calls.includes('evict:bonsai'));
  assert.equal(svc.arbiter.status().resident, null);
});

test('memory: prefers macOS memory_pressure free percentage', () => {
  const { parseMemoryPressure } = require('../core/brain/memory');
  assert.equal(parseMemoryPressure('System-wide memory free percentage: 49%', 16 * GB), 16 * GB * 0.49);
  assert.equal(parseMemoryPressure('nothing here', 16 * GB), null);
});

test('bonsai command: default is the RAM-light 1-bit GGUF on llama-server with vision + tool-calling template', () => {
  const { bonsaiCommand } = require('../core/brain/backends');
  const c = bonsaiCommand({ projectDir: '/p', port: 11436, runtime: 'llamacpp' });
  assert.match(c.bin, /llama-server$/);
  assert.ok(c.args.includes('--jinja'));
  assert.ok(c.args.join(' ').includes('Bonsai-27B-Q1_0.gguf'));
  const mlx = bonsaiCommand({ projectDir: '/p', port: 11436, runtime: 'mlx' });
  assert.match(mlx.args.join(' '), /bonsai-server\.py/);
});
