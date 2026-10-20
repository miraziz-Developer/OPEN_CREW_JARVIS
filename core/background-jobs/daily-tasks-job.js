'use strict';

const fs = require('fs');
const path = require('path');
const { ok, wrn } = require('../log');

function loadDailyTasksState(stateFile, todayStr) {
  let s;
  try { s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { s = null; }
  if (!s || s.date !== todayStr()) s = { date: todayStr(), completed: [] };
  return s;
}
function saveDailyTasksState(stateFile, s) {
  try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch (e) {}
}

// A time in the task text ("Every day 19:30 — ...", "at 11:00") means it must not
// run BEFORE that time.
function scheduledMinutes(text) {
  const m = String(text).match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]);
}
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// DAILY TASKS: the Obsidian list (skills/tasks). Listed items need no separate
// permission and run automatically one after another during the day (SOUL.md
// Boundaries still apply: irreversible actions are still confirmed).
function createDailyTasksJob({ projectDir, localDateStr, leadMin, stableId, beginSingleStepMission, recordMissionResult, askAgent, sendTelegram, writeMemory }) {
  const stateFile = path.join(projectDir, '.daily-tasks-state.json');
  const todayStr = () => localDateStr();

  async function run() {
    let tasksMod;
    try { tasksMod = require('../../skills/tasks'); } catch (e) { return; }
    const active = tasksMod.activeTasks();
    if (!active.length) return;

    const state = loadDailyTasksState(stateFile, todayStr);
    const cur = nowMinutes();
    // A task with a time runs only once that time arrives; a task without one
    // (as before) can run at any time. A time that already passed still runs
    // (e.g. the Mac was off at 19:30 and is turned on at 20:10: it still reminds).
    // Lead time: running the task itself takes time (agent call, browser, ...),
    // so it starts leadMin minutes early and the result or reminder reaches the
    // user exactly on time, not late.
    const next = active.find(t => {
      if (state.completed.includes(t)) return false;
      const sched = scheduledMinutes(t);
      return sched === null || cur >= (sched - leadMin);
    });
    if (!next) return;

    const execution = beginSingleStepMission(next, {
      id: stableId('daily', todayStr() + ':' + next), source: 'daily-task',
      idempotencyKey: 'daily:' + todayStr() + ':' + next, maxAttempts: 3
    });
    if (!execution.step) return;
    const prompt = 'Task from the daily task list: "' + next + '". Do it and report the result briefly.';
    const reply = await askAgent(prompt, 'agent:main:jarvis-daily-tasks-' + Date.now());
    const verified = recordMissionResult(execution.mission.id, execution.step.id, reply, { type: 'agent-result', value: reply });
    if (!verified || verified.status !== 'verified') {
      wrn('📋 Task not confirmed, not marked completed: ' + next);
      return;
    }
    state.completed.push(next);
    saveDailyTasksState(stateFile, state);
    if (reply) {
      ok('📋 Task done: ' + next);
      sendTelegram('✅ "' + next + '":\n' + reply);
      try { writeMemory('Daily task done', 'Task: ' + next + '\nResult: ' + reply.substring(0, 500), ['daily-task', 'autonomous']); } catch (e) {}
    }
  }

  return { run };
}

module.exports = { createDailyTasksJob };
