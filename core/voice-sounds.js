'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// While this sound plays the microphone is NOT sent to the live session at all (so
// JARVIS never hears itself as the user), which makes it fully DEAD time: the user is
// not heard either. So the sound must be as SHORT as possible. The duration is READ
// from the file, so swapping the file never leaves a stale hand-coded number.
function detectWakeSoundMs(wakeSoundPath) {
  try {
    const out = execSync('afinfo "' + wakeSoundPath + '" 2>/dev/null | grep -i "estimated duration"', { encoding: 'utf8' });
    const m = out.match(/([\d.]+)\s*sec/);
    // One small margin is enough to cover the speaker/driver tail before `afplay`
    // returns. The daemon adds no extra guard on top: otherwise the 0.84 s "Labbay,
    // boss" clip actually caused 1.12 s of microphone dead time.
    if (m) return Math.round(parseFloat(m[1]) * 1000) + 100;
  } catch (e) {}
  return 1000; // if afinfo fails: cautious, but far below the old 2400
}

function playWakeSound(wakeSoundPath) {
  if (!fs.existsSync(wakeSoundPath)) return;
  try {
    const p = spawn('afplay', [wakeSoundPath], { stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch (e) {}
}

// ── EXTRA SOUND CUES ── built-in macOS system sounds are used (good quality, no new
// audio generation needed). Sosumi = the classic "attention" alert (before an urgent
// signal); Glass = a light, positive "done" sound (when a longer run_task finishes,
// giving a HUD-like "completed" feel). Deliberately NOT used for fast_action: it is
// already near-instant, so an extra sound would only be noise.
function playSystemSound(name) {
  const p_ = path.join('/System/Library/Sounds', name + '.aiff');
  if (!fs.existsSync(p_)) return;
  try {
    const p = spawn('afplay', [p_], { stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch (e) {}
}
function playUrgentSound() { playSystemSound('Sosumi'); }
function playTaskDoneSound() { playSystemSound('Glass'); }

module.exports = { detectWakeSoundMs, playWakeSound, playSystemSound, playUrgentSound, playTaskDoneSound };
