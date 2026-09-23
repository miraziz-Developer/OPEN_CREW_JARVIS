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

// iOS'da haqiqiy barmoq bosish yo'q — Mac'dagi "iPhone Mirroring" oynasi
// sichqoncha bosish/sudrashni haqiqiy teginish sifatida telefonga uzatadi
// (Apple'ning rasmiy imkoniyati, macOS 15+ / Apple Silicon). Shu sababli
// bu modul faqat oyna chegaralarini topib, nisbiy (%) koordinatalarni
// mutlaq ekran nuqtasiga aylantiradi — qolganini cliclick/System Events
// bajaradi, xuddi haqiqiy Mac oynasidagi kabi.
class PhoneMirror {
  constructor({ run = exec, runOsa = osa, runJXA = osaJXA, tmpDir = os.tmpdir() } = {}) {
    Object.assign(this, { run, runOsa, runJXA, tmpDir });
  }

  async activate() {
    try { await this.runOsa(`tell application "${APP_NAME}" to activate`, 6000); }
    catch (e) { throw new Error('iPhone Mirroring ochib bo\'lmadi: ' + e.message); }
    // Oyna chiqishi va telefon bilan aloqa tayyor bo'lishi uchun qisqa kutish.
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
      if (isNotRunningError(e.message)) throw new Error('iPhone Mirroring oynasi topilmadi — avval activate() chaqiring va telefon ulanganini tekshiring');
      throw e;
    }
    const b = JSON.parse(raw);
    if (!b.width || !b.height) throw new Error('iPhone Mirroring oynasi hali tayyor emas (telefon ulanmagan bo\'lishi mumkin)');
    return b;
  }

  // Telefon ekranining skrinshoti (faqat mirroring oynasi, butun Mac ekrani emas) — ko'rish/tahlil uchun.
  // imageWidth/imageHeight — saqlangan PNG'ning xom piksel o'lchami (Retina bo'lsa bounds'dan katta) —
  // tapPixel() chaqiruvchisi screen-vision qaytargan xom piksel koordinatani shu bilan aniq nisbatga o'tkazadi.
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

  // screen-vision/locate_elements xom piksel koordinata qaytaradi (o'sha skrinshotning o'z o'lchamida) —
  // desktop-control'dagi click_at bilan bir xil naqsh: chaqiruvchi bo'lish/ko'paytirish qilmaydi, shu yerda hisoblanadi.
  async tapPixel(pixelX, pixelY, imageWidth, imageHeight, opts = {}) {
    if (!imageWidth || !imageHeight) throw new Error('imageWidth/imageHeight kerak (screenshot() natijasidan)');
    return this.tap(pixelX / imageWidth, pixelY / imageHeight, opts);
  }

  // holdMs>0 bo'lsa (masalan pastdan tepaga sudrab, bir oz to'xtatib) — App Switcher kabi teginish-va-ushlab-turish undirilarga ishlatiladi.
  // startHoldMs — sudrashdan OLDIN nuqtada bir oz turish: haqiqiy barmoq bosishi ham shunday, aks holda
  // iOS buni tizim "uy indikatori" gesti emas, ilova ichidagi oddiy swipe deb tushunishi mumkin (sinovda aynan shu sabab bo'ldi).
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

  // Pastdan-tepaga sudrab "uy" gestini taqlid qilish sinovda ishonchsiz chiqdi (real barmoq
  // fizikasi kerak). "iPhone Mirroring" ilovasining o'z View menyusida aynan shu buyruqlar tayyor —
  // ular 100% aniq ishlaydi, gestga hojat yo'q.
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
