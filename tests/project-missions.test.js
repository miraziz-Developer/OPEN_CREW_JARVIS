'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveProject } = require('../core/project-locator');
const { MissionStore } = require('../core/missions/store');
const { createMissionApi } = require('../core/missions/api');
const { GoalEngine, projectBrief } = require('../core/missions/engine');

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-home-'));
  const make = (rel, marker = 'package.json') => {
    fs.mkdirSync(path.join(home, rel), { recursive: true });
    fs.writeFileSync(path.join(home, rel, marker), '{}');
  };
  make('projects/tradegenius-ai-saas');
  make('projects/real_avto_bot', 'requirements.txt');
  make('projects/forex-ai-analyst');
  make('forex-ai-analyst');
  fs.mkdirSync(path.join(home, 'Music'));
  return home;
}

test('project locator: spoken names resolve to one project folder', () => {
  const home = fakeHome();
  assert.equal(resolveProject('tradegenius', { home }).path, path.join(home, 'projects/tradegenius-ai-saas'));
  assert.equal(resolveProject('real avto bot', { home }).name, 'real_avto_bot');
  assert.equal(resolveProject('~/projects/forex-ai-analyst', { home }).path, path.join(home, 'projects/forex-ai-analyst'));
});

test('project locator: ambiguous or unknown names ask instead of guessing', () => {
  const home = fakeHome();
  const twin = resolveProject('forex ai analyst', { home });
  assert.equal(twin.ok, false);
  assert.deepEqual(twin.candidates, ['~/projects/forex-ai-analyst', '~/forex-ai-analyst']);
  assert.equal(resolveProject('music', { home }).ok, false, 'folders without project markers are not projects');
  assert.equal(resolveProject('/etc', { home }).ok, false, 'paths outside home are refused');
});

test('mission api: a project mission stores its directory; an unknown project starts nothing', () => {
  const home = fakeHome();
  const store = new MissionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-missions-')) });
  const api = createMissionApi(store);
  const resolver = query => resolveProject(query, { home });

  const missing = api.start('fix the login bug', { project: 'nothing here', resolveProject: resolver });
  assert.match(missing, /Mission not started/);
  assert.equal(store.list().length, 0);

  const started = api.start('fix the login bug', { project: 'tradegenius', resolveProject: resolver });
  assert.match(started, /in project tradegenius-ai-saas/);
  const mission = store.list()[0];
  assert.equal(mission.context.projectDir, path.join(home, 'projects/tradegenius-ai-saas'));
});

test('planner is told to work in the project with Antigravity and to verify there', async () => {
  const store = new MissionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-missions-')) });
  const mission = store.create('add a health endpoint', { context: { projectDir: '/home/u/projects/app', projectName: 'app' } });
  let planRequest;
  const llm = { completeJson: async request => { planRequest = request; return { criteria: ['endpoint works'], tasks: [{ title: 'Add endpoint', worker: 'antigravity', prompt: 'add /health', priority: 9 }] }; } };
  const workers = { agent: { run: async () => ({ ok: true }) }, antigravity: { available: () => true, run: async () => ({ ok: true }) } };
  await new GoalEngine({ store, llm, workers, fullAutonomy: () => false }).plan(mission);
  assert.match(planRequest.user, /Project directory: \/home\/u\/projects\/app/);
  assert.match(planRequest.user, /Use the antigravity worker/);
  assert.match(planRequest.user, /verifies the result/);
  assert.equal(mission.tasks[0].worker, 'antigravity');
  assert.equal(projectBrief({ context: {} }, ['antigravity']), '', 'missions without a project are unchanged');
});

test('antigravity worker keeps one conversation per mission and recovers from an expired one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-worker-'));
  const log = path.join(dir, 'calls');
  const agy = path.join(dir, 'agy');
  // Fails when asked to resume "stale", otherwise answers with conversation "fresh".
  fs.writeFileSync(agy, `#!/bin/sh\necho "$@" >> "${log}"\ncase "$*" in *"--conversation stale"*) echo "conversation not found" >&2; exit 1;; esac\n` +
    `printf '%s\\n' '{"conversation_id":"fresh","status":"SUCCESS","response":"edited"}'\n`, { mode: 0o755 });
  process.env.AGY_PATH = agy;
  delete require.cache[require.resolve('../skills/antigravity')];
  try {
    const { createWorkers } = require('../core/workers');
    const worker = createWorkers().antigravity;
    const mission = { id: 'm-test', context: { projectDir: dir, antigravityConversation: 'stale' } };
    const outcome = await worker.run({ prompt: 'add tests', mission, task: { id: 't1' }, timeoutMs: 5000 });
    assert.deepEqual(outcome, { ok: true, output: 'edited', error: '' });
    assert.equal(mission.context.antigravityConversation, 'fresh');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 2);
    assert.match(calls[1], new RegExp(`--add-dir ${dir}`));
    assert.doesNotMatch(calls[1], /--conversation/);
  } finally {
    delete process.env.AGY_PATH;
    delete require.cache[require.resolve('../skills/antigravity')];
  }
});
