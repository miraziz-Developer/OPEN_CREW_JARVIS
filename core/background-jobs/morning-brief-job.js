'use strict';

const fs = require('fs');
const path = require('path');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function loadState(file, today) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  return s && s.date === today ? s : { date: today, sent: false };
}

// Faktlardan qisqa brifing matni (LLM'siz — tez va ishonchli).
function composeBrief({ now = new Date(), missions = [], usage = {}, yesterday = '' }) {
  const lines = [`Good morning. ${DAYS[now.getDay()]}, ${now.toISOString().slice(0, 10)}.`];
  const waiting = missions.filter(m => m.status === 'awaiting_approval');
  const running = missions.filter(m => ['running', 'planning', 'paused', 'blocked'].includes(m.status));
  const done = missions.filter(m => m.status === 'completed' && Date.now() - (m.completedAt || 0) < 24 * 3600000);
  if (waiting.length) lines.push(`Needs you: ${waiting.map(m => `mission ${m.n} — ${m.pendingApproval?.reason || 'approval'}`).join('; ')}.`);
  if (running.length) lines.push(`Working: ${running.map(m => `mission ${m.n} (${m.status})`).join(', ')}.`);
  if (done.length) lines.push(`Finished overnight: ${done.map(m => `mission ${m.n}`).join(', ')}.`);
  if (!waiting.length && !running.length && !done.length) lines.push('No missions in flight.');
  const cost = Number(usage.cost_usd || usage.cost || 0);
  if (cost > 0) lines.push(`Yesterday's spend: $${cost.toFixed(2)}.`);
  if (yesterday) lines.push(`Yesterday: ${yesterday.replace(/\s+/g, ' ').slice(0, 200)}`);
  return lines.join('\n');
}

function createMorningBriefJob({ projectDir, localDateStr, hour = 8, getMissions, getUsage, getYesterday, sendTelegram, announce, now = () => new Date() }) {
  const stateFile = path.join(projectDir, '.morning-brief-state.json');
  async function run() {
    const state = loadState(stateFile, localDateStr());
    if (state.sent || now().getHours() < hour) return null;
    state.sent = true;
    try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (_) {}
    let missions = [], usage = {}, yesterday = '';
    try { missions = getMissions(); } catch (_) {}
    try { usage = getUsage(); } catch (_) {}
    try { yesterday = await getYesterday(); } catch (_) {}
    const text = composeBrief({ now: now(), missions, usage, yesterday });
    try { sendTelegram('☀️ ' + text); } catch (_) {}
    try { if (announce) announce(text); } catch (_) {}
    return text;
  }
  return { run, composeBrief };
}

module.exports = { createMorningBriefJob, composeBrief };
