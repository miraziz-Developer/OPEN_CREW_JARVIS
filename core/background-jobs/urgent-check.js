'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ok } = require('../log');
const { playUrgentSound } = require('../voice-sounds');

function loadUrgentState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return { lastCheck: Date.now() }; }
}
function saveUrgentState(stateFile, s) {
  try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch (e) {}
}

// SHOSHILINCH ekran ogohlantirishlari — proactive-check'ning umumiy
// 30 daqiqalik tsiklidan FARQLI, screen-monitor #urgent deb belgilagan
// (xato/crash, xavfsizlik, muddat kabi) yozuvlarni ANCHA tez-tez (default
// 3 daqiqada) tekshiradi va DARHOL ovozli+Telegram xabar beradi — muhim
// narsa 30 daqiqagacha "kutib qolmasin". Alohida state fayli ishlatadi.
function createUrgentCheckJob({ projectDir, localDateStr, proactivePolicy, askAgent, sendTelegram, ttsToFile }) {
  const stateFile = path.join(projectDir, '.urgent-check-state.json');

  async function run() {
    const state = loadUrgentState(stateFile);
    let mem;
    try { mem = require('../../skills/memory'); } catch (e) { return; }
    const filePath = path.join(mem.MEMORY_DIR, localDateStr() + '.md');
    if (!fs.existsSync(filePath)) { state.lastCheck = Date.now(); saveUrgentState(stateFile, state); return; }

    const content = fs.readFileSync(filePath, 'utf8');
    const blocks = content.split(/^---$/m).map(b => b.trim()).filter(Boolean);
    const now = new Date();
    const urgentBlocks = [];
    for (const block of blocks) {
      if (!/#urgent\b/.test(block)) continue;
      const m = block.match(/^## (\d{2}):(\d{2}) — (.+)$/m);
      if (!m) continue;
      const [, hh, mm, topic] = m;
      const blockTime = new Date(now); blockTime.setHours(+hh, +mm, 0, 0);
      if (blockTime.getTime() > state.lastCheck) urgentBlocks.push({ topic, block });
    }
    state.lastCheck = Date.now();
    saveUrgentState(stateFile, state);
    if (!urgentBlocks.length) return;

    for (const { block } of urgentBlocks) {
      const summary = block.replace(/^## .+$/m, '').replace(/\*\*Teglar:\*\*.*$/m, '').trim();
      const decision = proactivePolicy.evaluate({
        source: 'screen-urgent', summary, confidence: 0.82, urgency: 0.95,
        benefit: 0.9, reversibility: 1, risk: 0.25, disruption: 0.25
      });
      if (decision.mode === 'observe') continue;
      ok('🚨 Shoshilinch: ' + summary.substring(0, 80));
      playUrgentSound();
      sendTelegram('🚨 ' + summary);
      const audio = await ttsToFile(('Diqqat. ' + summary).substring(0, 300));
      if (audio) { try { execSync('afplay "' + audio + '"'); } catch (e) {} }
    }
  }

  return { run };
}

module.exports = { createUrgentCheckJob };
