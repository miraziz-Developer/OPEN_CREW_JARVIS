#!/usr/bin/env node
/**
 * DESKTOP CONTROL skill: opens apps and drives the mouse and keyboard
 * through AppleScript/System Events (macOS, native, no dependencies).
 * Input (stdin JSON): { action: "...", ... }
 * Output: { status: "ok", ... } | { status: "error", message }
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { collectMacOSContext } = require('../../core/macos-context');
const { WorldModel, verifyExpectation } = require('../../core/world-model');
const { inspectAccessibility, performAccessibilityAction, findElements } = require('../../core/macos-accessibility');
const { ActionSafetyPolicy, assessAction } = require('../../core/action-safety-policy');
const { recordHighRiskCompletion } = require('../../core/autonomous-action-audit');

const { PROJECT_DIR } = require('../../core/paths');
let ENV = '';
try { ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
function env(k, def) {
  if (process.env[k] !== undefined) return process.env[k];
  const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : def;
}

const ENABLED = (env('DESKTOP_CONTROL_ENABLED', 'true') || 'true') !== 'false';
const worldModel = new WorldModel({ file: path.join(PROJECT_DIR, '.jarvis-world-model.json') });

function ensureEnabled() {
  if (!ENABLED) throw new Error('DESKTOP_CONTROL_ENABLED=false: computer control is disabled');
}

function runOsascript(script) {
  try {
    return execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 8000 }).trim();
  } catch (e) {
    if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') {
      throw new Error('Accessibility permission required: System Settings → Privacy & Security → Accessibility → allow Terminal/node');
    }
    const msg = (e.stderr || e.message || '').toString();
    if (msg.includes('not allowed') || msg.includes('(-1743)') || msg.includes('assistive access')) {
      throw new Error('Accessibility permission required: System Settings → Privacy & Security → Accessibility → allow Terminal/node');
    }
    throw new Error(msg || e.message);
  }
}

function escAS(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const CHROME_DEFAULT_PROFILE = env('CHROME_DEFAULT_PROFILE', 'Default'); // Chrome has several accounts/profiles,
// so opening it from a fully closed state showed the profile picker. This profile always
// opens directly, without asking.

function openApp(name) {
  ensureEnabled();
  if (/^(google chrome|chrome)$/i.test(name.trim())) {
    let alreadyRunning = false;
    try { execFileSync('pgrep', ['-x', 'Google Chrome']); alreadyRunning = true; } catch (e) {}
    if (!alreadyRunning) {
      try {
        execFileSync('open', ['-na', 'Google Chrome', '--args', '--profile-directory=' + CHROME_DEFAULT_PROFILE], { timeout: 8000 });
        return { status: 'ok', opened: 'Google Chrome (' + CHROME_DEFAULT_PROFILE + ' profil, picker\'siz)' };
      } catch (e) { /* aks holda pastdagi umumiy usulga tushadi */ }
    }
  }
  execFileSync('open', ['-a', name], { timeout: 8000 });
  return { status: 'ok', opened: name };
}

function openUrl(url) {
  ensureEnabled();
  execFileSync('open', [url], { timeout: 8000 });
  return { status: 'ok', opened: url };
}

function activateApp(name) {
  ensureEnabled();
  runOsascript(`tell application "${escAS(name)}" to activate`);
  return { status: 'ok', activated: name };
}

// screen-vision sees the screenshot in REAL pixels (usually 2x on Retina), but System
// Events "click at" expects LOGICAL point coordinates. Mixing the two up was the most
// common cause of clicking the wrong place, so screenshot-pixel coordinates are
// converted to logical points here (dividing by the scale); callers just pass the raw
// pixel values screen-vision returned.
let _scaleFactor = null;
function getScaleFactor() {
  if (_scaleFactor) return _scaleFactor;
  try {
    const out = execFileSync('osascript', ['-l', 'JavaScript', '-e',
      'ObjC.import("Cocoa"); $.NSScreen.mainScreen.backingScaleFactor'
    ], { encoding: 'utf8', timeout: 5000 }).trim();
    _scaleFactor = parseFloat(out) || 1;
  } catch (e) {
    _scaleFactor = 1; // if it cannot be determined, leave coordinates unchanged
  }
  return _scaleFactor;
}

// System Events "click at" is not always reliable on macOS (it could fail even with the
// right permissions), so the purpose-built `cliclick` tool is used instead (installed via
// brew, based on CGEvent).
function clickAt(pxX, pxY, double) {
  ensureEnabled();
  const scale = getScaleFactor();
  const x = Math.round(pxX / scale);
  const y = Math.round(pxY / scale);
  execFileSync('cliclick', [(double ? 'dc' : 'c') + ':' + x + ',' + y], { timeout: 8000 });
  return { status: 'ok', clicked: { screenshotPx: { x: pxX, y: pxY }, logicalPt: { x, y }, scale, double: !!double } };
}

function typeText(text) {
  ensureEnabled();
  runOsascript(`tell application "System Events" to keystroke "${escAS(text)}"`);
  return { status: 'ok', typed: text.length + ' belgi' };
}

// key: "return" | "tab" | "escape" | "space" | "delete" | "cmd+c" | "cmd+shift+4" ...
function keyPress(key) {
  ensureEnabled();
  const parts = String(key).toLowerCase().split('+').map(s => s.trim());
  const keyName = parts.pop();
  const modMap = { cmd: 'command down', command: 'command down', shift: 'shift down', opt: 'option down', option: 'option down', alt: 'option down', ctrl: 'control down', control: 'control down' };
  const mods = parts.map(m => modMap[m]).filter(Boolean);
  const specialKeyCodes = { return: 36, enter: 36, tab: 48, space: 49, delete: 51, escape: 53, home: 115, end: 119, pageup: 116, pagedown: 121, left: 123, right: 124, down: 125, up: 126 };
  let script;
  if (specialKeyCodes[keyName] !== undefined) {
    script = mods.length
      ? `tell application "System Events" to key code ${specialKeyCodes[keyName]} using {${mods.join(', ')}}`
      : `tell application "System Events" to key code ${specialKeyCodes[keyName]}`;
  } else {
    script = mods.length
      ? `tell application "System Events" to keystroke "${escAS(keyName)}" using {${mods.join(', ')}}`
      : `tell application "System Events" to keystroke "${escAS(keyName)}"`;
  }
  runOsascript(script);
  return { status: 'ok', pressed: key };
}

function frontmostApp() {
  const name = runOsascript('tell application "System Events" to name of first application process whose frontmost is true');
  return { status: 'ok', app: name };
}

function observeContext() {
  return worldModel.observe(collectMacOSContext()).snapshot;
}

function publicElement(element) {
  if (!element) return null;
  const { path: elementPath, role, subrole, title, description, value, identifier, enabled, focused, selected, bounds, actions, score, rank } = element;
  return { path: elementPath, role, subrole, title, description, value, identifier, enabled, focused, selected, bounds, actions, score, rank };
}

function inspectUi(input = {}) {
  ensureEnabled();
  const snapshot = inspectAccessibility(input);
  const query = input.query || null;
  const elements = query ? findElements(snapshot.elements, query, { limit: input.limit || query.limit }) : snapshot.elements.slice(0, Math.max(1, Math.min(600, Number(input.limit || 200))));
  return {
    status: 'ok', app: snapshot.app, pid: snapshot.pid, capturedAt: snapshot.capturedAt,
    truncated: snapshot.truncated, totalCount: snapshot.count, count: elements.length,
    elements: elements.map(publicElement)
  };
}

function resolveElement(input = {}) {
  const snapshot = inspectAccessibility(input);
  const matches = findElements(snapshot.elements, input.query || input, { limit: 5, minScore: input.minScore });
  if (!matches.length) throw new Error('UI element not found: ' + JSON.stringify(input.query || input));
  const selectedIndex = Number(input.index || 0);
  const element = matches[selectedIndex];
  if (!element) throw new Error(`UI element index not found: ${selectedIndex}; matches: ${matches.length}`);
  const ambiguous = selectedIndex === 0 && matches[1] && Math.abs(matches[0].score - matches[1].score) < 1 &&
    matches[0].title === matches[1].title && matches[0].role === matches[1].role;
  if (ambiguous) throw new Error('UI element is ambiguous: several equally strong matches; refine the query or index');
  return { snapshot, element, alternatives: matches.slice(1).map(publicElement) };
}

function findElement(input = {}) {
  ensureEnabled();
  const resolved = resolveElement(input);
  return { status: 'ok', app: resolved.snapshot.app, element: publicElement(resolved.element), alternatives: resolved.alternatives };
}

async function waitForElement(input = {}) {
  ensureEnabled();
  const timeoutMs = Math.max(0, Math.min(30000, Number(input.timeoutMs ?? 5000)));
  const intervalMs = Math.max(50, Math.min(1000, Number(input.intervalMs ?? 200)));
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      const found = findElement(input);
      if (input.absent === true) lastError = new Error('Element is still present');
      else return found;
    } catch (error) {
      if (input.absent === true) return { status: 'ok', absent: true, query: input.query || input };
      lastError = error;
    }
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  throw lastError || new Error('UI element did not appear in time');
}

async function actOnElementOnce(input = {}, action = input.elementAction || 'press') {
  ensureEnabled();
  const resolved = resolveElement(input);
  if (!resolved.element.enabled && action !== 'focus') throw new Error('UI element is disabled; action not performed');
  const before = publicElement(resolved.element);
  const performed = performAccessibilityAction({ app: resolved.snapshot.app, path: resolved.element.path, action, value: input.value });
  if (input.verify === false) return { status: 'ok', performed, before };
  const expectation = input.expect || (action === 'focus'
    ? { ...input.query, focused: true }
    : action === 'set_value' ? { ...input.query, value: input.value } : null);
  if (expectation) {
    const verified = await waitForElement({
      app: resolved.snapshot.app, query: expectation, timeoutMs: input.timeoutMs || 4000,
      intervalMs: input.intervalMs, maxDepth: input.maxDepth, maxElements: input.maxElements
    });
    return { status: 'ok', performed, before, verification: { method: 'accessibility', element: verified.element } };
  }
  let after = null;
  try { after = inspectAccessibility({ app: resolved.snapshot.app, maxDepth: input.maxDepth, maxElements: input.maxElements }); } catch (_) {}
  return { status: 'ok', performed, before, verification: { method: 'accessibility-action', observedAt: after?.capturedAt || Date.now(), app: after?.app || resolved.snapshot.app } };
}

async function actOnElement(input = {}, action = input.elementAction || 'press') {
  const maxAttempts = Math.max(1, Math.min(3, Number(input.maxAttempts || 2)));
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await actOnElementOnce(input, action);
      return { ...result, attempt, recovered: attempt > 1 };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, Math.min(800, 150 * attempt)));
    }
  }
  throw new Error(`Semantic UI action failed after ${maxAttempts} attempts: ${lastError?.message || lastError}`);
}

function authorizeDesktopInput(input = {}, options = {}) {
  const mutating = new Set(['click_at', 'type_text', 'key_press', 'click_element', 'set_text', 'toggle_element', 'select_menu', 'verified_action']);
  if (!mutating.has(input.action)) return { allowed: true, assessment: assessAction({ kind: 'desktop', description: input.action }) };
  const description = [input.action, input.name, input.text, input.value, input.menu, input.item, JSON.stringify(input.query || {})].filter(Boolean).join(' ');
  const policy = options.policy || new ActionSafetyPolicy({ fullAutonomyProvider: options.fullAutonomyProvider });
  const authorization = policy.authorize({ kind: 'task', id: input.action, description });
  if (!authorization.allowed && input.confirmed === true) return { allowed: true, assessment: authorization.assessment, reason: 'explicit-confirmation' };
  return authorization;
}

function scroll(input = {}) {
  ensureEnabled();
  if (input.query) return actOnElement(input, input.direction === 'up' ? 'scroll_up' : 'scroll_down');
  return keyPress(input.direction === 'up' ? 'pageup' : 'pagedown');
}

async function selectMenu(input = {}) {
  if (!input.menu || !input.item) throw new Error('select_menu needs menu and item');
  await actOnElement({ app: input.app, query: { name: input.menu, role: 'AXMenuBarItem' }, timeoutMs: input.timeoutMs }, 'press');
  return actOnElement({ app: input.app, query: { name: input.item, role: 'AXMenuItem' }, timeoutMs: input.timeoutMs, expect: input.expect }, 'press');
}

async function waitForExpectation(before, expected, timeoutMs = 4000, intervalMs = 200) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let after = null;
  let verification = null;
  do {
    try {
      after = observeContext();
      verification = verifyExpectation(before, after, expected);
      if (verification.ok) {
        worldModel.verify(before, after, expected);
        return { status: 'ok', verification, context: after };
      }
    } catch (e) {
      verification = { ok: false, error: e.message };
    }
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  if (after) worldModel.verify(before, after, expected);
  return { status: 'error', message: 'The action result could not be confirmed on screen', verification, context: after };
}

async function executeVerified(input) {
  const before = observeContext();
  let action;
  switch (input.action) {
    case 'open_app': action = openApp(input.name); break;
    case 'open_url': action = openUrl(input.url); break;
    case 'activate_app': action = activateApp(input.name); break;
    case 'click_at': action = clickAt(input.x, input.y, input.double); break;
    case 'type_text': action = typeText(input.text); break;
    case 'key_press': action = keyPress(input.key); break;
    case 'click_element': action = await actOnElement(input, 'press'); break;
    case 'focus_element': action = await actOnElement(input, 'focus'); break;
    case 'set_text': action = await actOnElement(input, 'set_value'); break;
    case 'toggle_element': action = await actOnElement(input, 'press'); break;
    case 'scroll': action = await scroll(input); break;
    case 'select_menu': action = await selectMenu(input); break;
    default: return { status: 'error', message: 'Action does not support verification: ' + input.action };
  }
  const verified = await waitForExpectation(before, input.expect || { changed: true }, input.timeoutMs);
  return { ...verified, action };
}

async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (e) {}

  try {
    const safety = authorizeDesktopInput(input);
    if (!safety.allowed) {
      console.log(JSON.stringify({
        status: 'confirmation_required', message: 'This action may have external, private or irreversible effects. Call again with confirmed:true after confirmation.',
        risk: safety.assessment.risk, fingerprint: safety.assessment.fingerprint
      }));
      return;
    }
    let result;
    switch (input.action) {
      case 'open_app': result = openApp(input.name); break;
      case 'open_url': result = openUrl(input.url); break;
      case 'activate_app': result = activateApp(input.name); break;
      case 'click_at': result = clickAt(input.x, input.y, input.double); break;
      case 'type_text': result = typeText(input.text); break;
      case 'key_press': result = keyPress(input.key); break;
      case 'frontmost_app': result = frontmostApp(); break;
      case 'observe_context': result = { status: 'ok', context: observeContext() }; break;
      case 'inspect_ui': result = inspectUi(input); break;
      case 'find_element': result = findElement(input); break;
      case 'wait_for_element': result = await waitForElement(input); break;
      case 'click_element': result = await actOnElement(input, 'press'); break;
      case 'focus_element': result = await actOnElement(input, 'focus'); break;
      case 'set_text': result = await actOnElement(input, 'set_value'); break;
      case 'toggle_element': result = await actOnElement(input, 'press'); break;
      case 'scroll': result = await scroll(input); break;
      case 'select_menu': result = await selectMenu(input); break;
      case 'verified_action': result = await executeVerified(input.command || {}); break;
      default: result = { status: 'error', message: 'Noma\'lum action: ' + input.action };
    }
    if (result?.status === 'ok') await recordHighRiskCompletion(safety.assessment, { source: 'desktop', requestId: input.requestId, taskId: input.taskId });
    console.log(JSON.stringify(result));
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message || String(e) }));
  }
}

if (require.main === module) main().catch(e => console.log(JSON.stringify({ status: 'error', message: e.message || String(e) })));

module.exports = {
  openApp, openUrl, activateApp, clickAt, typeText, keyPress, frontmostApp,
  inspectUi, findElement, waitForElement, actOnElement, scroll, selectMenu,
  observeContext, waitForExpectation, executeVerified, resolveElement, authorizeDesktopInput
};
