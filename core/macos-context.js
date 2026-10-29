'use strict';

const { execFile, execFileSync } = require('child_process');

const CONTEXT_SCRIPT = `
ObjC.import('AppKit');
function safe(fn, fallback) { try { var value = fn(); return value === undefined || value === null ? fallback : value; } catch (e) { return fallback; } }
var workspace = $.NSWorkspace.sharedWorkspace;
var app = workspace.frontmostApplication;
var result = { capturedAt: Date.now(), source: 'macos-context', app: safe(() => ObjC.unwrap(app.localizedName), ''), bundleId: safe(() => ObjC.unwrap(app.bundleIdentifier), ''), pid: safe(() => Number(app.processIdentifier), null), window: { title: '', bounds: null }, browser: null, focus: null };
var se = Application('System Events'); se.includeStandardAdditions = true;
var proc = safe(() => se.applicationProcesses.whose({frontmost: true})()[0], null);
if (proc) {
  var win = safe(() => proc.attributes.byName('AXFocusedWindow').value(), null);
  if (!win) win = safe(() => proc.windows().filter(w => safe(() => w.subrole(), '') === 'AXStandardWindow')[0], null);
  if (win) {
    result.window.title = safe(() => win.name(), '');
    var pos = safe(() => win.position(), null), size = safe(() => win.size(), null);
    if (pos && size) result.window.bounds = { x: Number(pos[0]), y: Number(pos[1]), width: Number(size[0]), height: Number(size[1]) };
  }
  var el = safe(() => proc.attributes.byName('AXFocusedUIElement').value(), null);
  if (el) result.focus = { role: safe(() => el.role(), ''), title: safe(() => el.title(), ''), value: safe(() => el.value(), ''), description: safe(() => el.description(), '') };
}
if (result.app === 'Google Chrome') { var b = Application('Google Chrome'); result.browser = safe(() => { var t = b.windows[0].activeTab(); return { name: 'Google Chrome', url: t.url(), title: t.title() }; }, null); }
else if (result.app === 'Safari') { var s = Application('Safari'); result.browser = safe(() => { var d = s.documents[0]; return { name: 'Safari', url: d.url(), title: d.name() }; }, null); }
else if (result.app === 'Arc') { var a = Application('Arc'); result.browser = safe(() => { var t = a.windows[0].activeTab(); return { name: 'Arc', url: t.url(), title: t.title() }; }, null); }
JSON.stringify(result);
`;

function parseJxaJson(output) {
  try {
    const parsed = JSON.parse(String(output || '').trim());
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) { return null; }
}

function parseContextOutput(output) {
  const parsed = parseJxaJson(output);
  if (!parsed) throw new Error('JXA returned invalid JSON');
  if (!parsed.app) throw new Error('Could not detect the frontmost app');
  return parsed;
}

function contextError(error) {
  const message = String(error.stderr || error.message || error);
  if (/assistive|not authorized|not allowed|-1743/i.test(message)) return new Error('Accessibility or Automation permission required');
  return new Error('Could not read the macOS context: ' + message.trim().slice(0, 300));
}

function collectMacOSContext(options = {}) {
  const exec = options.execFileSync || execFileSync;
  try {
    return parseContextOutput(exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', CONTEXT_SCRIPT], { encoding: 'utf8', timeout: options.timeout || 5000 }).trim());
  } catch (error) {
    throw contextError(error);
  }
}

// Non-blocking variant for the voice daemon: osascript takes ~300 ms, and blocking
// the event loop that long starves the speaker queue mid-sentence.
function collectMacOSContextAsync(options = {}) {
  const exec = options.execFile || execFile;
  return new Promise((resolve, reject) => {
    exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', CONTEXT_SCRIPT], { encoding: 'utf8', timeout: options.timeout || 5000 }, (error, stdout, stderr) => {
      if (error) return reject(contextError(Object.assign(error, { stderr })));
      try { resolve(parseContextOutput(stdout)); } catch (parseError) { reject(contextError(parseError)); }
    });
  });
}

module.exports = { collectMacOSContext, collectMacOSContextAsync, parseJxaJson, CONTEXT_SCRIPT };