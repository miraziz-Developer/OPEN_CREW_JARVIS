#!/usr/bin/env node
/**
 * SCREEN MONITOR skill: trigger-based screen observation.
 * Takes a screenshot every N seconds and computes a pixel diff; when the diff
 * exceeds the threshold AND the active context changed, the screen is analysed
 * by a vision model. It never interrupts the user (log and memory only).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { collectMacOSContext } = require('../../core/macos-context');
const { WorldModel } = require('../../core/world-model');

const { PROJECT_DIR } = require('../../core/paths');
const STATE_FILE = path.join(PROJECT_DIR, '.screen-monitor-state');
const LAST_SCREENSHOT = '/tmp/jarvis_prev_screen.png';
const CUR_SCREENSHOT = '/tmp/jarvis_curr_screen.png';
const WORLD_MODEL_FILE = path.join(PROJECT_DIR, '.jarvis-world-model.json');
const worldModel = new WorldModel({ file: WORLD_MODEL_FILE });

// ── Config (environment overrides .env) ──────────────────────────────
let ENV = ''; try { ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (_) {}
function getEnv(key, def) {
  if (process.env[key] !== undefined) return process.env[key];
  const m = ENV.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim() : def;
}

const INTERVAL_MS = parseInt(getEnv('SCREEN_MONITOR_INTERVAL', '90000'), 10); // 90 s default
const DIFF_THRESHOLD = parseFloat(getEnv('SCREEN_MONITOR_THRESHOLD', '15'));   // 15% default
const ENABLED = getEnv('SCREEN_MONITOR_ENABLED', 'true') === 'true';

// ── State ─────────────────────────────────────────────────────────────
let isRunning = false;
let lastLLMCall = 0;
// Last front window, kept in process memory. A reconstructed version once used
// it without declaring it, throwing a ReferenceError on the first diff and
// sending the monitor into a useless error loop.
let lastFrontWindow = null;
const llmCooldownMs = parseInt(getEnv('SCREEN_MONITOR_VISION_COOLDOWN', '120000'), 10); // minimum gap between vision calls

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return { enabled: s.enabled !== false, lastTrigger: s.lastTrigger || 0, lastSummary: s.lastSummary || '' };
    }
  } catch (e) {}
  return { enabled: ENABLED, lastTrigger: 0, lastSummary: '' };
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ── Screenshot ────────────────────────────────────────────────────────
function takeScreenshot(outPath) {
  try {
    execSync('screencapture -x "' + outPath + '"');
    return fs.existsSync(outPath);
  } catch (e) { return false; }
}

// ── Pixel diff (ImageMagick, or a file-size fallback) ─────────────────
function pixelDiff(prevPath, currPath) {
  try {
    const result = execSync('compare -metric MAE "' + prevPath + '" "' + currPath + '" /tmp/jarvis_diff.png 2>&1', { encoding: 'utf8', timeout: 10000 });
    // Output looks like: 1234.56 (0.0188321)
    const match = result.match(/\(([^)]+)\)/);
    if (match) return parseFloat(match[1]) * 100; // 0.0188 -> 1.88%
  } catch (e) {
    // ImageMagick is not installed
  }

  // Fallback: compare file sizes
  try {
    const s1 = fs.statSync(prevPath).size;
    const s2 = fs.statSync(currPath).size;
    const max = Math.max(s1, s2);
    if (max === 0) return 100;
    return Math.abs(s1 - s2) / max * 100;
  } catch (e) { return 100; }
}

// ── Vision analysis (sends the real screenshot to the vision model) ───
const { describeImage, buildGroundedPrompt } = require('./../screen-vision/index.js');

// In local-brain mode (JARVIS_BRAIN=local) background image analysis would occupy
// the single local model and evict the agent's prompt cache, slowing the next
// command by minutes. So only metadata (app, window, browser page) is recorded
// there. SCREEN_MONITOR_LOCAL_VISION=1 forces image analysis anyway.
function metadataSummary(context) {
  if (!context) return '';
  const parts = [context.app, context.window?.title, context.browser?.title, context.browser?.url].filter(Boolean);
  return [...new Set(parts.map(p => String(p).trim()))].join(' — ').slice(0, 500);
}

const ANALYSIS_PROMPT =
  'Analyse this screenshot in detail: what exactly is the user doing right now? ' +
  'If several windows or apps are visible, describe EACH separately: which app and what exactly is in it ' +
  '(file or project name, which part of the code or text, who they are talking to and about what, which site or video, etc.). ' +
  'Do not guess; describe only what is clearly visible. Be concrete and detailed, not vague. ' +
  'If only the clock changed or there is genuinely no meaningful activity, reply with exactly: NOTHING\n\n' +
  'IMPORTANT: if the screen shows something truly URGENT the user must know IMMEDIATELY (for example an error or crash ' +
  'dialog, a security warning, a usage limit or quota running out, an important deadline approaching, a payment or ' +
  'account warning), start your reply with exactly "URGENT: " (e.g. "URGENT: the Xcode build stopped with an error"). ' +
  'NEVER use this prefix for normal, expected work (writing code, browsing, chatting); only for genuinely unusual ' +
  'situations that could cause harm if ignored.';

async function analyzeScreen(imagePath, context) {
  const now = Date.now();
  if (String(getEnv('JARVIS_BRAIN', '')).toLowerCase() === 'local' && getEnv('SCREEN_MONITOR_LOCAL_VISION', '') !== '1') {
    const summary = metadataSummary(context);
    return summary ? { status: 'ok', summary } : { status: 'error', message: 'no context' };
  }
  if (now - lastLLMCall < llmCooldownMs) {
    return { status: 'cooldown', message: 'LLM cooldown active' };
  }

  try {
    const summary = await describeImage(imagePath, buildGroundedPrompt(ANALYSIS_PROMPT, context));
    lastLLMCall = Date.now();
    return { status: 'ok', summary };
  } catch (e) {
    lastLLMCall = Date.now();
    return { status: 'error', message: e.message || String(e) };
  }
}

/**
 * Interprets a vision summary: "NOTHING" means skip; an "URGENT:" prefix marks an urgent entry.
 * The Uzbek markers of the previous prompt ("hech narsa", "SHOSHILINCH:") are still understood.
 */
function parseScreenAnalysis(summary) {
  const text = String(summary || '').trim();
  if (!text || /^(?:nothing|hech narsa)[.!]?$/i.test(text)) return { skip: true, urgent: false, text: '' };
  const urgentMatch = text.match(/^(?:URGENT|SHOSHILINCH):\s*/i);
  return { skip: false, urgent: Boolean(urgentMatch), text: urgentMatch ? text.slice(urgentMatch[0].length).trim() : text };
}

// ── Cheap signal: the front window (app + title) ──────────────────────
// No image and no LLM needed: ~0.5 s and free. Pixel diff is a very coarse
// measure: scrolling, video playback and typing all produce large diffs while
// the user is doing the SAME work. That once produced 52 nearly identical
// (paid) vision calls and 52 duplicate memory entries in a day. The expensive
// analysis now runs only when the CONTEXT really changes.
const FRONT_WINDOW_SCRIPT = 'tell application "System Events"\n' +
  '  set frontApp to name of first application process whose frontmost is true\n' +
  '  set winName to ""\n' +
  '  try\n' +
  '    tell process frontApp to set winName to name of front window\n' +
  '  end try\n' +
  'end tell\n' +
  'return frontApp & " | " & winName';

function getFrontWindow() {
  try {
    // Timeout: System Events sometimes stops responding; the loop must not hang on it.
    return execSync('osascript -e ' + JSON.stringify(FRONT_WINDOW_SCRIPT) + ' 2>/dev/null',
      { encoding: 'utf8', timeout: 5000 }).trim();
  } catch (e) { return null; }
}

function observeWorld(screen) {
  const context = collectMacOSContext();
  if (screen) context.screen = screen;
  return worldModel.observe(context, { type: screen ? 'screen.analyzed' : 'context.observed' });
}

function recordAnalysis(state, summary) {
  const result = parseScreenAnalysis(summary);
  if (result.skip) return false;

  // Urgent entries get an extra #urgent tag; the urgent-check job polls for it every
  // few minutes (much more often than the 30-minute proactive cycle) and announces it.
  const tags = result.urgent ? ['screen', 'trigger', 'auto', 'urgent'] : ['screen', 'trigger', 'auto'];
  try {
    const memPath = path.join(PROJECT_DIR, 'skills', 'memory', 'index.js');
    if (fs.existsSync(memPath)) require(memPath).writeMemory('Screen change', result.text, tags);
  } catch (e) {}

  state.lastTrigger = Date.now();
  state.lastSummary = result.text;
  saveState(state);
  return true;
}

// ── Main loop ─────────────────────────────────────────────────────────
async function runLoop() {
  const state = loadState();
  if (!state.enabled) {
    console.log('Screen monitor is disabled (.screen-monitor-state)');
    return;
  }

  isRunning = true;
  console.log('Screen monitor started. Interval: ' + INTERVAL_MS + 'ms, threshold: ' + DIFF_THRESHOLD + '%');

  while (isRunning) {
    try {
      const s = loadState();
      if (!s.enabled) { console.log('Disabled'); break; }

      // 1. Screenshot
      const ok = takeScreenshot(CUR_SCREENSHOT);
      if (!ok) { await sleep(INTERVAL_MS); continue; }

      // 2. Diff (the first frame is skipped)
      if (fs.existsSync(LAST_SCREENSHOT)) {
        const diff = pixelDiff(LAST_SCREENSHOT, CUR_SCREENSHOT);
        let observation = null;
        try { observation = observeWorld(); } catch (e) { console.warn('World model:', e.message); }
        const frontWindow = observation
          ? [observation.snapshot.app, observation.snapshot.window?.title || observation.snapshot.browser?.title].filter(Boolean).join(' | ')
          : getFrontWindow();
        const contextChanged = observation ? observation.diff.contextChanged : frontWindow !== null && frontWindow !== lastFrontWindow;
        if (frontWindow !== null) lastFrontWindow = frontWindow;
        console.log('Diff: ' + diff.toFixed(2) + '% (threshold: ' + DIFF_THRESHOLD + '%)' +
          ' | window: ' + (frontWindow || '?') + (contextChanged ? ' [CHANGED]' : ''));

        // Expensive vision analysis only when the CONTEXT changed. A large pixel diff
        // while the user stays in the same app/window (scrolling, video, typing) is
        // not new information, so it is skipped.
        if (diff > DIFF_THRESHOLD && contextChanged) {
          console.log('  ⚠️ TRIGGER: context changed (' + diff.toFixed(1) + '%)');

          // 3. Analysis (only on a real change)
          const analysis = await analyzeScreen(CUR_SCREENSHOT, observation?.snapshot);
          if (analysis.status === 'ok' && analysis.summary && analysis.summary.length > 5) {
            try { observeWorld({ summary: analysis.summary, imagePath: CUR_SCREENSHOT }); } catch (e) {}
            // Never sent to Telegram (it must not disturb the user); console only.
            if (recordAnalysis(state, analysis.summary)) console.log('  📋 Analysis:', analysis.summary.substring(0, 120));
          }
        }
      }

      // 4. Rotate frames
      try { fs.copyFileSync(CUR_SCREENSHOT, LAST_SCREENSHOT); } catch (e) {}

    } catch (e) {
      console.error('Screen monitor error:', e.message);
    }

    await sleep(INTERVAL_MS);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── On/Off ────────────────────────────────────────────────────────────
function setEnabled(val) {
  const s = loadState();
  s.enabled = val;
  saveState(s);
  console.log('Screen monitor:', val ? 'ON ✅' : 'OFF ❌');
}

// ── CLI ───────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const input = fs.readFileSync(0, 'utf8').trim();
  let payload = {};
  try { payload = JSON.parse(input); } catch (e) {}

  const action = payload.action || args[0] || 'status';

  switch (action) {
    case 'start':
      setEnabled(true);
      runLoop();
      break;
    case 'stop':
      setEnabled(false);
      isRunning = false;
      console.log(JSON.stringify({ status: 'ok', enabled: false }));
      break;
    case 'status': {
      const s = loadState();
      console.log(JSON.stringify({ status: 'ok', enabled: s.enabled, lastTrigger: s.lastTrigger, lastSummary: s.lastSummary }));
      break;
    }
    case 'toggle': {
      const st = loadState();
      setEnabled(!st.enabled);
      console.log(JSON.stringify({ status: 'ok', enabled: !st.enabled }));
      break;
    }
    default:
      console.log(JSON.stringify({ status: 'error', message: 'Unknown action: ' + action }));
  }
}

if (require.main === module) main();

module.exports = { runLoop, setEnabled, pixelDiff, loadState, observeWorld, analyzeScreen, metadataSummary, parseScreenAnalysis };
