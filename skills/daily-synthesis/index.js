#!/usr/bin/env node
/**
 * DAILY SYNTHESIS skill: learns patterns from a day's raw observations.
 *
 * Raw screen observations accumulate in `Jarvis/Memory/YYYY-MM-DD.md`, but they
 * are only useful once summarised. This skill reads a day's entries, asks the
 * agent to extract stable patterns and appends the result to the
 * `Jarvis/Profile/User.md` profile, so "learning" accumulates in memory.
 *
 * Input (stdin JSON): { date?: "YYYY-MM-DD" }  (default: yesterday)
 * Output: { status, date, learned?, skipped? }
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { PROJECT_DIR } = require('../../core/paths');
let ENV = ''; try { ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (_) {}
function env(k, def) { const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : def; }

const mem = require(path.join(PROJECT_DIR, 'skills', 'memory'));
const STATE_FILE = path.join(PROJECT_DIR, '.synthesis-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return { done: [] }; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) {}
}

// Returns the local (timezone-aware) date. toISOString() returns UTC, so at UTC+8
// the wrong day was picked until 08:00 local time.
function localDateStr(d) {
  d = d || new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDateStr(d);
}

async function askAgent(message) {
  const englishOnly = '[Language policy: Produce all newly written prose only in natural English. Never answer in Uzbek.]\n\n';
  try {
    const llm = require(path.join(PROJECT_DIR, 'core', 'llm'));
    const reply = await llm.complete({
      system: 'You are J.A.R.V.I.S. background synthesis engine. ' + englishOnly,
      user: message,
      maxOutputTokens: 2048,
      timeoutMs: 30000
    });
    if (reply && reply.trim()) return reply.trim();
  } catch (_) {}

  return new Promise((resolve) => {
    const proc = spawn('openclaw', ['agent', '--session-key', 'agent:main:jarvis-background', '--message', englishOnly + message, '--agent', 'main'], {
      cwd: PROJECT_DIR,
      env: { ...process.env, AZURE_OPENAI_KEY: env('AZURE_OPENAI_KEY') },
      timeout: 30000
    });
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      const clean = out.split('\n').filter(l => !l.includes('Waiting') && !l.includes('◒') && l.trim()).join('\n').trim();
      resolve(clean || null);
    });
    proc.on('error', () => resolve(null));
  });
}

async function synthesize(date) {
  const state = loadState();
  if (state.done.includes(date)) {
    return { status: 'ok', date, skipped: 'already done' };
  }

  const filePath = path.join(mem.MEMORY_DIR, date + '.md');
  if (!fs.existsSync(filePath)) {
    return { status: 'ok', date, skipped: 'no observations' };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.trim().length < 100) {
    return { status: 'ok', date, skipped: 'yozuv juda qisqa' };
  }

  const profile = mem.readProfile();
  let existingTasks = [];
  try { existingTasks = require('../tasks').activeTasks(); } catch (e) {}
  const prompt =
    'Below are the raw entries observed on the user\'s computer on ' + date + '.\n\n' +
    '=== RAW OBSERVATIONS ===\n' + raw.slice(0, 12000) + '\n\n' +
    '=== CURRENT PROFILE ===\n' + (profile.content || '(empty)').slice(0, 4000) + '\n\n' +
    '=== CURRENT DAILY TASK LIST ===\n' + (existingTasks.length ? existingTasks.join('\n') : '(empty)') + '\n\n' +
    'Task 1: from these observations, draw STABLE conclusions about the user that will be useful later ' +
    '(which projects they work on, which tools they use, their working style, recurring habits). ' +
    'Do not record one-off, incidental things.\n\n' +
    'Task 2: if these patterns include concrete, recurring work that YOU (Jarvis) could do independently every day ' +
    '(e.g. a specific check, cleanup, monitoring or reminder), add it to the daily task list directly with `exec`: ' +
    'echo \'{"action":"add","text":"..."}\' | node skills/tasks/index.js — ' +
    'but only if it is concrete and useful; never re-add something already on the list.\n\n' +
    'Rules (for the Task 1 answer):\n' +
    '- Only the 2-5 most important conclusions, one short line each, starting with "- ".\n' +
    '- Do not repeat anything already in the profile.\n' +
    '- If there is no new stable conclusion, reply with exactly "NO_NEW_FACTS" and nothing else.\n' +
    '- Reply with ONLY that list (even if you did Task 2, do not comment on it); no intro or summary sentence.';

  const reply = await askAgent(prompt);

  // No reply from the agent (timeout/error) is not the same as "no new pattern".
  // The day is not marked done, so it is retried next time (otherwise a transient
  // error would skip that day for good).
  if (!reply) {
    return { status: 'error', date, message: 'no reply from the agent (will retry)' };
  }

  state.done.push(date);
  if (state.done.length > 90) state.done = state.done.slice(-90);
  saveState(state);

  if (/NO_NEW_FACTS|YANGI_YOQ/.test(reply)) {
    return { status: 'ok', date, learned: null };
  }

  const lines = reply.split('\n').map(l => l.trim()).filter(l => l.startsWith('-'));
  if (!lines.length) return { status: 'ok', date, learned: null };

  // updateProfile prefixes the value with "- ", so avoid a double dash
  const value = lines.map(l => l.replace(/^-\s*/, '')).join('\n- ');
  mem.updateProfile('Learned patterns — ' + date, value, 'automatic observation');
  return { status: 'ok', date, learned: lines };
}

async function main() {
  let input = {};
  if (!process.stdin.isTTY) {
    try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (e) {}
  }
  try {
    const result = await synthesize(input.date || yesterday());
    console.log(JSON.stringify(result));
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message || String(e) }));
  }
}

if (require.main === module) main();

module.exports = { synthesize, yesterday };
