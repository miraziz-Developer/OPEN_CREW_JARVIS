#!/usr/bin/env node
/**
 * DESKTOP CONTROL Skill — ilova ochish, sichqoncha va klaviaturani
 * AppleScript/System Events orqali boshqaradi (macOS, native, dependency yo'q).
 * Kirish (stdin JSON): { action: "...", ... }
 * Chiqish: { status: "ok", ... } | { status: "error", message }
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = '/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS';
const ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8');
function env(k, def) { const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : def; }

const ENABLED = (env('DESKTOP_CONTROL_ENABLED', 'true') || 'true') !== 'false';

function ensureEnabled() {
  if (!ENABLED) throw new Error('DESKTOP_CONTROL_ENABLED=false — kompyuter boshqaruvi o\'chirilgan');
}

function runOsascript(script) {
  try {
    return execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 8000 }).trim();
  } catch (e) {
    if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') {
      throw new Error('Accessibility ruxsati kerak: Tizim sozlamalari → Maxfiylik va xavfsizlik → Accessibility → Terminal/node\'ga ruxsat bering');
    }
    const msg = (e.stderr || e.message || '').toString();
    if (msg.includes('not allowed') || msg.includes('(-1743)') || msg.includes('assistive access')) {
      throw new Error('Accessibility ruxsati kerak: Tizim sozlamalari → Maxfiylik va xavfsizlik → Accessibility → Terminal/node\'ga ruxsat bering');
    }
    throw new Error(msg || e.message);
  }
}

function escAS(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const CHROME_DEFAULT_PROFILE = env('CHROME_DEFAULT_PROFILE', 'Default'); // Chrome'da bir nechta hisob/profil bo'lgani uchun,
// Chrome to'liq yopiq holatdan ochilganda profil-tanlash oynasi (picker)
// chiqib qolardi. Shu profil har doim to'g'ridan-to'g'ri, so'ramasdan ochiladi.

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

// screen-vision skrinshotni HAQIQIY piksel o'lchamida ko'radi (Retina
// ekranda odatda 2x), lekin System Events "click at" LOGIK nuqta
// (point) koordinatasini kutadi. Shu ikkisini chalkashtirib yuborish —
// noto'g'ri joyga bosishning eng ko'p uchraydigan sababi edi. Shuning
// uchun bu yerda skrinshot-piksel koordinatani avtomatik logik
// nuqtaga aylantiramiz (masshtabni bo'lib), chaqiruvchi har doim
// screen-vision qaytargan xom piksel qiymatlarini yuborishi kifoya.
let _scaleFactor = null;
function getScaleFactor() {
  if (_scaleFactor) return _scaleFactor;
  try {
    const out = execFileSync('osascript', ['-l', 'JavaScript', '-e',
      'ObjC.import("Cocoa"); $.NSScreen.mainScreen.backingScaleFactor'
    ], { encoding: 'utf8', timeout: 5000 }).trim();
    _scaleFactor = parseFloat(out) || 1;
  } catch (e) {
    _scaleFactor = 1; // aniqlab bo'lmasa — o'zgartirmasdan qoldiramiz
  }
  return _scaleFactor;
}

// System Events'ning "click at" buyrug'i macOS'da doim ham ishonchli
// ishlamaydi (ruxsatlar to'g'ri bo'lsa ham xatolik berishi mumkin edi).
// Shuning uchun shu maqsad uchun maxsus yaratilgan `cliclick` vositasi
// ishlatiladi (brew orqali o'rnatilgan, CGEvent asosida ishlaydi).
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
  const specialKeyCodes = { return: 36, tab: 48, space: 49, delete: 51, escape: 53, left: 123, right: 124, down: 125, up: 126 };
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

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (e) {}

  try {
    let result;
    switch (input.action) {
      case 'open_app': result = openApp(input.name); break;
      case 'open_url': result = openUrl(input.url); break;
      case 'click_at': result = clickAt(input.x, input.y, input.double); break;
      case 'type_text': result = typeText(input.text); break;
      case 'key_press': result = keyPress(input.key); break;
      case 'frontmost_app': result = frontmostApp(); break;
      default: result = { status: 'error', message: 'Noma\'lum action: ' + input.action };
    }
    console.log(JSON.stringify(result));
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message || String(e) }));
  }
}

if (require.main === module) main();

module.exports = { openApp, openUrl, clickAt, typeText, keyPress, frontmostApp };
