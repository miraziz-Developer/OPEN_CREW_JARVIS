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

test('bonsai command: prefers Ternary Bonsai 2 GGUF, falls back to 1-bit, on llama-server with tool-calling template', () => {
  const { bonsaiCommand } = require('../core/brain/backends');
  const c = bonsaiCommand({ projectDir: '/p', port: 11436, runtime: 'llamacpp', exists: () => true });
  assert.match(c.bin, /llama-server$/);
  assert.ok(c.args.includes('--jinja'));
  assert.ok(c.args.join(' ').includes('Ternary-Bonsai-2-27B-PTQ1_0.gguf'));
  const only1bit = bonsaiCommand({ projectDir: '/p', port: 11436, runtime: 'llamacpp', exists: f => f.includes('Bonsai-27B-Q1_0') });
  assert.ok(only1bit.args.join(' ').includes('Bonsai-27B-Q1_0.gguf'));
  assert.ok(!only1bit.args.includes('--mmproj'));
  const none = bonsaiCommand({ projectDir: '/p', port: 11436, runtime: 'llamacpp', exists: () => false });
  assert.ok(none.required[1].endsWith('Ternary-Bonsai-2-27B-PTQ1_0.gguf'));   // "o'rnatilmagan" xabari to'g'ri faylni ko'rsatadi
  const mlx = bonsaiCommand({ projectDir: '/p', port: 11436, runtime: 'mlx' });
  assert.match(mlx.args.join(' '), /bonsai-server\.py/);
});

test('set-brain: local mode swaps bulky bootstrap for SOUL.local.md, cloud mode restores it', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { apply } = require('../scripts/set-brain');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  const ocPath = path.join(dir, 'openclaw.json'); const savedPath = path.join(dir, 'saved.json');
  fs.writeFileSync(ocPath, JSON.stringify({ agents: { defaults: { model: { primary: 'azure-openai/gpt-6-astra', fallbacks: ['azure-openai/gpt-5-mini'] } } } }));
  const local = apply('local', { ocPath, savedPath });
  assert.equal(local.agents.defaults.model.primary, 'ollama/qwen3.5:9b');
  assert.equal(local.agents.defaults.contextInjection, 'never');
  const cloud = apply('cloud', { ocPath, savedPath });
  assert.equal(cloud.agents.defaults.model.primary, 'azure-openai/gpt-6-astra');
  assert.equal(cloud.agents.defaults.contextInjection, undefined);
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'SOUL.local.md'), 'utf8').length < 3000);   // ixcham bo'lib qolsin
});

test('agent policy preamble carries the compact soul only in local brain mode', () => {
  const { agentPolicyPreamble } = require('../core/agent-bridge');
  const saved = process.env.JARVIS_BRAIN;
  try {
    process.env.JARVIS_BRAIN = 'local';
    assert.match(agentPolicyPreamble({ mode: 'off' }), /^\[Jarvis — local brain profile\][\s\S]*\[Owner policy: Full autonomy/);
    process.env.JARVIS_BRAIN = 'cloud';
    assert.match(agentPolicyPreamble({ mode: 'off' }), /^\[Owner policy:/);
  } finally { if (saved === undefined) delete process.env.JARVIS_BRAIN; else process.env.JARVIS_BRAIN = saved; }
});

test('arbiter: does not evict the resident model when even freeing it would not fit the big one', async () => {
  const { BrainArbiter, MemoryPressureError } = require('../core/brain/arbiter');
  const events = [];
  const arbiter = new BrainArbiter({
    backends: { ollama: { evict: async () => events.push('evict:ollama'), footprintBytes: async () => 5 * GB }, bonsai: { evict: async () => {} } },
    availableBytes: async () => 1 * GB, requirements: { bonsai: 7 * GB }, settleMs: 0
  });
  (await arbiter.acquire('ollama'))();
  await assert.rejects(arbiter.acquire('bonsai'), MemoryPressureError);   // 1 + 5 < 7
  assert.deepEqual(events, []);
  assert.equal(arbiter.status().resident, 'ollama');
});

test('arbiter: waits for async unload to return memory before loading the big model', async () => {
  const { BrainArbiter } = require('../core/brain/arbiter');
  let free = 3 * GB;
  const arbiter = new BrainArbiter({
    backends: { ollama: { evict: async () => { setTimeout(() => { free = 9 * GB; }, 300); }, footprintBytes: async () => 6 * GB } },
    availableBytes: async () => free, requirements: { bonsai: 7 * GB }, settleMs: 3000
  });
  (await arbiter.acquire('ollama'))();
  const release = await arbiter.acquire('bonsai');
  assert.equal(arbiter.status().resident, 'bonsai'); release();
});

test('screen monitor: local brain records window metadata instead of occupying the local model', async () => {
  const saved = process.env.JARVIS_BRAIN;
  process.env.JARVIS_BRAIN = 'local';
  try {
    const { analyzeScreen } = require('../skills/screen-monitor/index.js');
    const r = await analyzeScreen('/nonexistent.png', { app: 'Google Chrome', window: { title: 'GitHub' }, browser: { title: 'GitHub', url: 'https://github.com' } });
    assert.deepEqual(r, { status: 'ok', summary: 'Google Chrome — GitHub — https://github.com' });
  } finally { if (saved === undefined) delete process.env.JARVIS_BRAIN; else process.env.JARVIS_BRAIN = saved; }
});
