'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { composeBrief, createMorningBriefJob } = require('../core/background-jobs/morning-brief-job');
const { AmbientContext, ambientBlock } = require('../core/ambient-context');
const { HealthWatchdog } = require('../core/health-watchdog');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'peak-'));

test('morning brief lists approvals and running missions', () => {
  const text = composeBrief({ now: new Date('2026-09-21T08:00:00'), missions: [
    { n: 3, status: 'awaiting_approval', pendingApproval: { reason: 'send email' } },
    { n: 4, status: 'running' }], usage: { cost_usd: 1.234 } });
  assert.match(text, /Needs you: mission 3 — send email/);
  assert.match(text, /Working: mission 4/);
  assert.match(text, /\$1\.23/);
});

test('morning brief sends once per day and only after the hour', async () => {
  const dir = tmp(); let hour = 6; const sent = [];
  const job = createMorningBriefJob({ projectDir: dir, localDateStr: () => '2026-09-21', hour: 8, getMissions: () => [],
    getUsage: () => ({}), getYesterday: async () => '', sendTelegram: t => sent.push(t), now: () => ({ getHours: () => hour, getDay: () => 1, toISOString: () => '2026-09-21T08:00:00Z' }) });
  await job.run(); assert.equal(sent.length, 0);
  hour = 9; await job.run(); await job.run(); assert.equal(sent.length, 1);
});

test('ambient context records changes and renders a block', () => {
  const file = path.join(tmp(), 'a.json'); let app = 'Xcode';
  const amb = new AmbientContext({ file, collect: () => ({ app, window: { title: 'Main.swift' } }) });
  amb.tick(); amb.tick(); app = 'Google Chrome'; amb.tick();
  assert.equal(amb.history.length, 2);
  const block = ambientBlock(file);
  assert.match(block, /Google Chrome/); assert.match(block, /Xcode/);
  assert.equal(ambientBlock(path.join(tmp(), 'none.json')), '');
});

test('watchdog heals with cooldown then notifies once', async () => {
  let t = 0, heals = 0; const notes = [];
  const wd = new HealthWatchdog({ now: () => t, cooldownMs: 100, maxHeals: 2, notify: m => notes.push(m),
    checks: [{ name: 'gateway', probe: async () => false, heal: async () => { heals++; } }] });
  await wd.runOnce(); await wd.runOnce(); assert.equal(heals, 1);
  t = 200; await wd.runOnce(); t = 400; await wd.runOnce(); await wd.runOnce();
  assert.equal(heals, 2); assert.equal(notes.length, 1);
});

test('web actions resolve YouTube play via yt-dlp and fall back to search', async () => {
  const { resolveWebTarget } = require('../core/web-actions');
  const ok = await resolveWebTarget({ kind: 'youtube_play', query: 'Billie Jean' }, { exec: async () => 'Zi_XLOBDo_Y\n' });
  assert.match(ok.url, /watch\?v=Zi_XLOBDo_Y/);
  const fb = await resolveWebTarget({ kind: 'youtube_play', query: 'Billie Jean' }, { exec: async () => { throw new Error('x'); } });
  assert.match(fb.url, /results\?search_query=Billie%20Jean/);
  await assert.rejects(resolveWebTarget({ kind: 'url', url: 'javascript:alert(1)' }));
});

test('simple agent tasks run with thinking off, complex ones keep it', () => {
  const { buildOpenClawAgentArgs } = require('../core/agent-bridge');
  assert.ok(buildOpenClawAgentArgs('open my downloads folder', 'k').includes('off'));
  assert.ok(!buildOpenClawAgentArgs('research and analysis of the best CRM strategy', 'k').includes('--thinking'));
});

test('voice model is offered web_open, file_op and undo_last', () => {
  const names = require('../skills/realtime-voice').buildTools().map(t => t.name);
  for (const n of ['web_open', 'file_op', 'undo_last']) assert.ok(names.includes(n), n);
});
