'use strict';

const { execFile } = require('child_process');
const path = require('path');
const os = require('os');

const APP_NAME = 'iPhone Mirroring';

const exec = (file, args, timeout = 8000) => new Promise((resolve, reject) =>
  execFile(file, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout)));

const osa = (script, timeout) => exec('osascript', ['-e', script], timeout);
const osaJXA = (script, timeout) => exec('osascript', ['-l', 'JavaScript', '-e', script], timeout);

function isNotRunningError(message) {
  return /not running|can't get window|Invalid index|doesn't understand the .window. message/i.test(String(message || ''));
}

// iOS has no real finger input here: the Mac's "iPhone Mirroring" window delivers mouse
// clicks and drags to the phone as real touches (Apple's official feature, macOS 15+ /
// Apple Silicon). This module only finds the window bounds and converts relative (%)
// coordinates to absolute screen points; cliclick/System Events do the rest, just like
// in a normal Mac window.
class PhoneMirror {
  constructor({ run = exec, runOsa = osa, runJXA = osaJXA, tmpDir = os.tmpdir() } = {}) {
    Object.assign(this, { run, runOsa, runJXA, tmpDir });
  }

  async activate() {
    try { await this.runOsa(`tell application "${APP_NAME}" to activate`, 6000); }
    catch (e) { throw new Error('Could not open iPhone Mirroring: ' + e.message); }
    // Short wait for the window to appear and the phone link to become ready.
    await new Promise(r => setTimeout(r, 400));
  }

  async isConnected() {
    try {
      const out = await this.runOsa(`tell application "System Events" to exists application process "${APP_NAME}"`, 4000);
      return out.trim() === 'true';
    } catch (_) { return false; }
  }

  // Oynaning ekrandagi mutlaq (logical point) chegarasi: { x, y, width, height }.
  async bounds() {
    const script = `
      var se = Application('System Events');
      var proc = se.applicationProcesses.byName('${APP_NAME}');
      var win = proc.windows[0];
      var pos = win.position(), size = win.size();
      JSON.stringify({ x: pos[0], y: pos[1], width: size[0], height: size[1] });
    `;
    let raw;
    try { raw = await this.runJXA(script, 5000); }
    catch (e) {
      if (isNotRunningError(e.message)) throw new Error('iPhone Mirroring window not found; call activate() first and check the phone is connected');
      throw e;
    }
    const b = JSON.parse(raw);
    if (!b.width || !b.height) throw new Error('iPhone Mirroring window is not ready yet (the phone may not be connected)');
    return b;
  }

  // Screenshot of the phone screen only (the mirroring window, not the whole Mac screen), for viewing/analysis.
  // imageWidth/imageHeight are the saved PNG's raw pixel size (larger than bounds on Retina); tapPixel()
  // uses them to convert the raw pixel coordinates from screen-vision into an exact ratio.
  async screenshot(destPath) {
    await this.activate();
    const b = await this.bounds();
    const file = destPath || path.join(this.tmpDir, 'jarvis-phone-' + Date.now() + '.png');
    await this.run('/usr/sbin/screencapture', ['-x', '-R', `${b.x},${b.y},${b.width},${b.height}`, file], 8000);
    const size = await this._imageSize(file);
    return { path: file, bounds: b, imageWidth: size.width, imageHeight: size.height };
  }

  async _imageSize(file) {
    try {
      const out = await this.run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], 5000);
      const w = out.match(/pixelWidth:\s*(\d+)/), h = out.match(/pixelHeight:\s*(\d+)/);
      return { width: w ? parseInt(w[1], 10) : 0, height: h ? parseInt(h[1], 10) : 0 };
    } catch (_) { return { width: 0, height: 0 }; }
  }

  // (xPct, yPct) — 0..1, telefon ekranining o'zida nisbiy joylashuv (chapdan/yuqoridan foiz).
  static toPoint(bounds, xPct, yPct) {
    return { x: Math.round(bounds.x + clamp01(xPct) * bounds.width), y: Math.round(bounds.y + clamp01(yPct) * bounds.height) };
  }

  async tap(xPct, yPct, { double = false } = {}) {
    await this.activate();
    const b = await this.bounds();
    const p = PhoneMirror.toPoint(b, xPct, yPct);
    await this.run('cliclick', [(double ? 'dc' : 'c') + ':' + p.x + ',' + p.y], 6000);
    return { status: 'ok', tapped: { xPct, yPct, point: p } };
  }

  // screen-vision/locate_elements returns raw pixel coordinates (in that screenshot's own size); same
  // pattern as click_at in desktop-control: callers never divide or multiply, it is computed here.
  async tapPixel(pixelX, pixelY, imageWidth, imageHeight, opts = {}) {
    if (!imageWidth || !imageHeight) throw new Error('imageWidth/imageHeight are required (from the screenshot() result)');
    return this.tap(pixelX / imageWidth, pixelY / imageHeight, opts);
  }

  // holdMs>0 (e.g. drag up from the bottom and pause) is used for touch-and-hold gestures like the App Switcher.
  // startHoldMs: rest on the point briefly BEFORE dragging, like a real finger; otherwise iOS may treat it as an
  // ordinary in-app swipe instead of the system home-indicator gesture (exactly what happened in testing).
  async swipe(fromXPct, fromYPct, toXPct, toYPct, { holdMs = 0, startHoldMs = 0, steps: stepCount = 1 } = {}) {
    await this.activate();
    const b = await this.bounds();
    const from = PhoneMirror.toPoint(b, fromXPct, fromYPct);
    const to = PhoneMirror.toPoint(b, toXPct, toYPct);
    const steps = [`dd:${from.x},${from.y}`];
    if (startHoldMs > 0) steps.push(`w:${startHoldMs}`);
    for (let i = 1; i <= stepCount; i++) {
      const x = Math.round(from.x + (to.x - from.x) * (i / stepCount));
      const y = Math.round(from.y + (to.y - from.y) * (i / stepCount));
      steps.push(`dm:${x},${y}`);
    }
    if (holdMs > 0) steps.push(`w:${holdMs}`);
    steps.push(`du:${to.x},${to.y}`);
    await this.run('cliclick', steps, 8000);
    return { status: 'ok', swiped: { from, to, holdMs, startHoldMs } };
  }

  // Simulating the "home" gesture by dragging up from the bottom proved unreliable in testing (it needs real
  // finger physics). The "iPhone Mirroring" app's own View menu has exactly these commands, which work 100%
  // reliably, so no gesture is needed.
  async _menuCommand(menuItemName) {
    await this.activate();
    await this.runOsa(
      `tell application "System Events" to tell process "${APP_NAME}" to click menu item "${menuItemName}" of menu "View" of menu bar 1`,
      6000
    );
    return { status: 'ok', command: menuItemName };
  }
  async home() { return this._menuCommand('Home Screen'); }
  async appSwitcher() { return this._menuCommand('App Switcher'); }
  async spotlight() { return this._menuCommand('Spotlight'); }

  async type(text) {
    await this.activate();
    const escaped = String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await this.runOsa(`tell application "System Events" to keystroke "${escaped}"`, 8000);
    return { status: 'ok', typed: String(text).length + ' belgi' };
  }
}

function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }

module.exports = { PhoneMirror, APP_NAME };
