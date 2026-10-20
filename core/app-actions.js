'use strict';

const { execFile } = require('child_process');

const runOsa = script => new Promise(resolve => execFile('osascript', ['-e', script], { timeout: 6000 }, () => resolve()));
const pgrep = name => new Promise(resolve => execFile('pgrep', ['-if', name], { timeout: 3000 }, (err, stdout) =>
  resolve(String(stdout || '').trim().split(/\s+/).filter(Boolean))));
const kill = pids => new Promise(resolve => execFile('kill', ['-9', ...pids], { timeout: 3000 }, () => resolve()));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Closes any app by the name the user said: first a soft "quit" (the app itself asks about
// unsaved work), and if it is still alive after a short grace period it is force-closed.
// Like opening, the reply comes quickly.
async function closeApp(name, { osa = runOsa, findPids = pgrep, killPids = kill, sleep = wait, graceMs = 900 } = {}) {
  const label = String(name || '').trim();
  if (!label) throw new Error('App name is required');
  await osa(`tell application "${label.replace(/"/g, '')}" to quit`);
  await sleep(graceMs);
  const pids = await findPids(label);
  if (pids.length) await killPids(pids);
  return { said: `Closed ${label}.`, forced: pids.length > 0 };
}

module.exports = { closeApp };
