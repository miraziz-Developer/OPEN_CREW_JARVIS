'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ok } = require('../log');

const REPORT_TAGS = ['task', 'daily-task', 'realtime', 'voice', 'autonomous'];

function loadDailyReportState(stateFile, todayStr) {
  let s;
  try { s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { s = null; }
  if (!s || s.date !== todayStr()) s = { date: todayStr(), sent: false };
  return s;
}
function saveDailyReportState(stateFile, s) {
  try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch (e) {}
}

// DAILY SELF-REPORT: at the end of the (local) day, everything done autonomously
// today (voice commands, daily tasks, parallel tasks during live conversation) is
// summarised and announced via Telegram and voice. With full autonomy granted, this
// keeps things transparent instead of requiring oversight.
function createDailyReportJob({ projectDir, localDateStr, reportHour, askAgent, sendTelegram, writeMemory, ttsToFile }) {
  const stateFile = path.join(projectDir, '.daily-report-state.json');
  const todayStr = () => localDateStr();

  async function run() {
    const state = loadDailyReportState(stateFile, todayStr);
    if (state.sent) return;
    if (new Date().getHours() < reportHour) return;

    let mem;
    try { mem = require('../../skills/memory'); } catch (e) { return; }
    const filePath = path.join(mem.MEMORY_DIR, todayStr() + '.md');
    if (!fs.existsSync(filePath)) { state.sent = true; saveDailyReportState(stateFile, state); return; }

    const content = fs.readFileSync(filePath, 'utf8');
    const blocks = content.split(/^---$/m).map(b => b.trim()).filter(Boolean);
    const relevant = blocks.filter(b => REPORT_TAGS.some(t => b.includes('#' + t)));

    state.sent = true; // whatever the outcome, do not send again today
    saveDailyReportState(stateFile, state);
    if (!relevant.length) return; // no autonomous work today, so no report

    const prompt = 'Today the following work was done (voice commands, tasks done autonomously):\n\n' +
      relevant.join('\n\n').slice(0, 8000) +
      '\n\nWrite a SHORT (3-6 sentence) daily report for the user in plain language, without technical detail: what was done ' +
      'and the key results. No intro or closing sentence; start directly with the content.';
    const reply = await askAgent(prompt, 'agent:main:jarvis-daily-report-' + todayStr());
    if (!reply) return;

    ok('📊 Daily report ready');
    sendTelegram('📊 Today’s report:\n\n' + reply);
    try { writeMemory('Kunlik hisobot', reply, ['report']); } catch (e) {}
    const audio = await ttsToFile(reply.substring(0, 400));
    if (audio) { try { execSync('afplay "' + audio + '"'); } catch (e) {} }
  }

  return { run };
}

module.exports = { createDailyReportJob };
