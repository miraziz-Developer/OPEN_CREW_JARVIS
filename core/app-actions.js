'use strict';

const { execFile } = require('child_process');

const runOsa = script => new Promise(resolve => execFile('osascript', ['-e', script], { timeout: 6000 }, () => resolve()));
const pgrep = name => new Promise(resolve => execFile('pgrep', ['-if', name], { timeout: 3000 }, (err, stdout) =>
  resolve(String(stdout || '').trim().split(/\s+/).filter(Boolean))));
const kill = pids => new Promise(resolve => execFile('kill', ['-9', ...pids], { timeout: 3000 }, () => resolve()));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Har qanday ilova nomini (foydalanuvchi so'zlagan holicha) yopadi: avval yumshoq
// "quit" (saqlanmagan ishni ilovaning o'zi so'raydi), qisqa muhlatdan keyin ham
// tirik bo'lsa majburan tozalanadi. Ochilishga o'xshab, javob tez keladi.
async function closeApp(name, { osa = runOsa, findPids = pgrep, killPids = kill, sleep = wait, graceMs = 900 } = {}) {
  const label = String(name || '').trim();
  if (!label) throw new Error('App name kerak');
  await osa(`tell application "${label.replace(/"/g, '')}" to quit`);
  await sleep(graceMs);
  const pids = await findPids(label);
  if (pids.length) await killPids(pids);
  return { said: `Closed ${label}.`, forced: pids.length > 0 };
}

module.exports = { closeApp };
