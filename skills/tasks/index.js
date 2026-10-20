#!/usr/bin/env node
/**
 * TASKS skill: the user's chosen daily task list
 * File: Obsidian Vault/Jarvis/Tasks/DailyTasks.md (checklist format)
 * Each task is "- [ ] description"; once done it becomes "- [x]" (daily state lives in a separate file)
 */

const fs = require('fs');
const path = require('path');

const VAULT = process.env.OBSIDIAN_VAULT
  || (require('os').homedir() + '/Documents/Obsidian Vault');

const TASKS_DIR = path.join(VAULT, 'Jarvis', 'Tasks');
const TASKS_FILE = path.join(TASKS_DIR, 'DailyTasks.md');

function ensureDir() {
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
}

function readRaw() {
  ensureDir();
  if (!fs.existsSync(TASKS_FILE)) {
    fs.writeFileSync(TASKS_FILE, '# Daily tasks\n\nJarvis works through the tasks on this list automatically during the day.\n\nRelated: [[User]]\n\n', 'utf8');
  }
  return fs.readFileSync(TASKS_FILE, 'utf8');
}

// ── Reading the list ──────────────────────────────────────────────────
// Supports both formats: checkboxes ("- [ ] text" / "- [x] text") AND plain bullets
// ("- text", as written by hand in Obsidian; such lines used to be ignored entirely
// and the task was reported as missing).
function listTasks() {
  const raw = readRaw();
  const tasks = [];
  raw.split('\n').forEach((line, idx) => {
    const cb = line.match(/^- \[( |x)\] (.+)$/);
    if (cb) { tasks.push({ line: idx, done: cb[1] === 'x', text: cb[2].trim() }); return; }
    const plain = line.match(/^- (?!\[)(.+)$/);
    if (plain) tasks.push({ line: idx, done: false, text: plain[1].trim() });
  });
  return { status: 'ok', tasks };
}

// Bag-of-words similarity, to estimate whether two task texts mean the same thing.
// Uzbek is agglutinative, so exact word matching is unreliable ("zal" and "zalga"
// become different tokens). Each word is therefore cut to its first 5 letters to
// approximate the stem, and the result is measured with the OVERLAP coefficient
// (not Jaccard), so comparing a short reminder with a long detailed task does not
// let the longer text's size hide that both are about the same thing.
function wordStems(text) {
  const words = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 3);
  return new Set(words.map(w => w.slice(0, 5)));
}
function timeMarkers(text) {
  return new Set((String(text).match(/\b([01]?\d|2[0-3])[:.][0-5]\d\b/g) || []));
}
function overlapCoefficient(a, b) {
  const wa = wordStems(a), wb = wordStems(b);
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.min(wa.size, wb.size);
}
function looksLikeDuplicate(a, b) {
  const overlap = overlapCoefficient(a, b);
  if (overlap >= 0.6) return true; // matnning katta qismi mos keladi
  // The same exact time (e.g. "19:30") plus a few shared words strongly
  // indicates both are "the reminder at that time".
  const ta = timeMarkers(a), tb = timeMarkers(b);
  let sharedTime = false;
  for (const t of ta) if (tb.has(t)) sharedTime = true;
  return sharedTime && overlap >= 0.25;
}

// ── Adding a task ─────────────────────────────────────────────────────
// A very similar task already on the list is not added again (seen in practice:
// the same "go to the gym" reminder was added 2-3 times and fired several times a day).
function addTask(text, force) {
  if (!text || !text.trim()) return { status: 'error', message: 'text is required' };
  const trimmed = text.trim();
  if (!force) {
    const existing = listTasks().tasks;
    const dup = existing.find(t => looksLikeDuplicate(t.text, trimmed));
    if (dup) return { status: 'duplicate', message: 'A very similar task already exists', existing: dup.text };
  }
  const raw = readRaw();
  const updated = raw.replace(/\n*$/, '') + '\n- [ ] ' + trimmed + '\n';
  fs.writeFileSync(TASKS_FILE, updated, 'utf8');
  return { status: 'ok', added: trimmed };
}

// ── Removing a task (by text, fuzzy match) ─────────────────────────────
function removeTask(text) {
  const raw = readRaw();
  const lines = raw.split('\n');
  const idx = lines.findIndex(l => /^- (\[( |x)\] )?(?!\[)/.test(l) && l.toLowerCase().includes(String(text).toLowerCase()));
  if (idx === -1) return { status: 'error', message: 'Not found: ' + text };
  const removed = lines[idx];
  lines.splice(idx, 1);
  fs.writeFileSync(TASKS_FILE, lines.join('\n'), 'utf8');
  return { status: 'ok', removed };
}

// ── Marking a task as done ──────────────────────────────────────────────
function completeTask(text) {
  const raw = readRaw();
  const lines = raw.split('\n');
  const idx = lines.findIndex(l => /^- \[[ ]\]/.test(l) && l.toLowerCase().includes(String(text).toLowerCase()));
  if (idx === -1) return { status: 'error', message: 'No pending task found: ' + text };
  lines[idx] = lines[idx].replace(/^- \[[ ]\]/, '- [x]');
  fs.writeFileSync(TASKS_FILE, lines.join('\n'), 'utf8');
  return { status: 'ok', completed: lines[idx].replace(/^- \[x\]\s*/, '') };
}

// ── Only active (not done) tasks ────────────────────────────────────────
function activeTasks() {
  return listTasks().tasks.filter(t => !t.done).map(t => t.text);
}

// ── CLI ───────────────────────────────────────────────────────────────
function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (e) {}

  let result;
  switch (input.action) {
    case 'add': result = addTask(input.text, input.force); break;
    case 'complete': result = completeTask(input.text); break;
    case 'remove': result = removeTask(input.text); break;
    case 'list': result = listTasks(); break;
    default: result = { status: 'error', message: 'Noma\'lum action: ' + input.action + ' (add|complete|remove|list)' };
  }
  console.log(JSON.stringify(result));
}

if (require.main === module) main();

module.exports = { listTasks, addTask, completeTask, removeTask, activeTasks, TASKS_FILE };
