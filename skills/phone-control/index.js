#!/usr/bin/env node
/**
 * PHONE CONTROL Skill — iPhone Mirroring (macOS 15+, Apple Silicon) orqali
 * bog'langan iPhone'ni boshqaradi: skrinshot, bosish, sudrash, yozish, uy/App
 * Switcher/Spotlight. Haqiqiy teginish sifatida telefonga uzatiladi.
 * Kirish (stdin JSON): { action: "...", ... }
 * Chiqish: { status: "ok", ... } | { status: "error", message }
 */
'use strict';

const { PhoneMirror } = require('../../core/phone-mirror');

async function main() {
  let input = {};
  try { input = JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}'); } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: 'stdin JSON noto\'g\'ri: ' + e.message }));
    process.exit(1);
  }
  const pm = new PhoneMirror();
  try {
    let result;
    switch (input.action) {
      case 'is_connected': result = { status: 'ok', connected: await pm.isConnected() }; break;
      case 'screenshot': result = { status: 'ok', ...(await pm.screenshot(input.destPath)) }; break;
      case 'tap':
        result = input.imageWidth && input.imageHeight
          ? { status: 'ok', ...(await pm.tapPixel(input.x, input.y, input.imageWidth, input.imageHeight, { double: input.double })) }
          : { status: 'ok', ...(await pm.tap(input.xPct, input.yPct, { double: input.double })) };
        break;
      case 'swipe': result = { status: 'ok', ...(await pm.swipe(input.fromXPct, input.fromYPct, input.toXPct, input.toYPct, { holdMs: input.holdMs, startHoldMs: input.startHoldMs, steps: input.steps })) }; break;
      case 'type_text': result = { status: 'ok', ...(await pm.type(input.text)) }; break;
      case 'home': result = await pm.home(); break;
      case 'app_switcher': result = await pm.appSwitcher(); break;
      case 'spotlight': result = await pm.spotlight(); break;
      default: result = { status: 'error', message: "Noma'lum action: " + input.action };
    }
    console.log(JSON.stringify(result));
    if (result.status === 'error') process.exit(1);
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message }));
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { main };
