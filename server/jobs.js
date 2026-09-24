#!/usr/bin/env node
'use strict';

// Server (headless) rejimida ishlaydigan fon ishlari. Mikrofonli daemon'siz — faqat
// ertalabki brifing (missiyalar + kalendar + pochta) Telegramga.
const path = require('path');
const { PROJECT_DIR } = require('../core/paths');
const llm = require('../core/llm');
const { MissionStore } = require('../core/missions/store');
const { telegramNotifier } = require('../core/mission-runner');
const { createMorningBriefJob } = require('../core/background-jobs/morning-brief-job');
const { sharedMeter, dayKey } = require('../core/usage-meter');

const localDateStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const store = new MissionStore({ dir: path.join(PROJECT_DIR, '.run', 'missions') });
const notify = telegramNotifier(llm.env);

const morningBrief = createMorningBriefJob({
  projectDir: PROJECT_DIR, localDateStr, hour: parseInt(llm.env('MORNING_BRIEF_HOUR'), 10) || 8,
  getMissions: () => store.list(),
  getUsage: () => sharedMeter().totals(dayKey(Date.now() - 86400000)),
  getYesterday: async () => '',
  getEvents: async () => { const r = await require('../skills/google-calendar').listEvents(1, 8); return r.status === 'ok' ? r.events.filter(e => String(e.start || '').slice(0, 10) === localDateStr()) : []; },
  getUnread: async () => { const r = await require('../skills/gmail').listMessages('is:unread category:primary newer_than:2d', 10); return r.status === 'ok' ? r.messages : []; },
  sendTelegram: text => notify(text)
});

if (llm.env('MORNING_BRIEF_ENABLED', 'true') !== 'false') {
  setInterval(() => morningBrief.run().catch(() => {}), 5 * 60 * 1000);
  setTimeout(() => morningBrief.run().catch(() => {}), 20000);
}
console.log(`[${new Date().toISOString()}] server jobs ishga tushdi (pid ${process.pid})`);
process.on('SIGTERM', () => process.exit(0));
