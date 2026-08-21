'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ok } = require('../log');

function loadProactiveState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return { lastCheck: Date.now() }; }
}
function saveProactiveState(stateFile, s) {
  try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch (e) {}
}

// PROAKTIV REJIM — davriy ravishda screen-monitor yozgan Obsidian
// xotirasini ko'rib chiqadi; agent chindan foydali narsa topsa, faqat
// KUZATIB (mustaqil harakat qilmasdan) taklif beradi.
function createProactiveCheckJob({ projectDir, intervalMin, localDateStr, proactivePolicy, askAgent, sendTelegram, ttsToFile }) {
  const stateFile = path.join(projectDir, '.proactive-state.json');

  async function run() {
    const state = loadProactiveState(stateFile);
    let mem;
    try { mem = require('../../skills/memory'); } catch (e) { return; }
    const date = localDateStr();
    const filePath = path.join(mem.MEMORY_DIR, date + '.md');
    if (!fs.existsSync(filePath)) { state.lastCheck = Date.now(); saveProactiveState(stateFile, state); return; }

    const content = fs.readFileSync(filePath, 'utf8');
    const blocks = content.split(/^---$/m).map(b => b.trim()).filter(Boolean);
    const newBlocks = [];
    const now = new Date();
    for (const block of blocks) {
      const m = block.match(/^## (\d{2}):(\d{2}) — (.+)$/m);
      if (!m) continue;
      const [, hh, mm, topic] = m;
      if (!topic.includes('Ekran')) continue;
      const blockTime = new Date(now); blockTime.setHours(+hh, +mm, 0, 0);
      if (blockTime.getTime() > state.lastCheck) newBlocks.push(block);
    }

    state.lastCheck = Date.now();
    saveProactiveState(stateFile, state);
    if (!newBlocks.length) return;

    // Ko'p kunlik o'rganilgan naqshlarni ham qo'shamiz — shunda taklif faqat
    // "hozir shu ko'rinyapti" emas, balki "odatda shu vaqt/holatda siz shuni
    // qilasiz" darajasida, haqiqiy odatlarga asoslangan bo'ladi.
    let patternsBlock = '';
    try {
      const profile = mem.readProfile();
      if (profile.status === 'ok') {
        const sections = profile.content.split(/^## /m).slice(1).filter(s => s.startsWith('O\'rganilgan naqshlar') || s.startsWith('Odatlar'));
        if (sections.length) patternsBlock = '\n\n=== SIZNING ODDIY VAQTLARDA O\'RGANILGAN ODATLARINGIZ ===\n' + sections.slice(-5).map(s => '## ' + s).join('\n');
      }
    } catch (e) {}

    const now2 = new Date();
    const prompt = 'Hozirgi vaqt: ' + now2.toTimeString().slice(0, 5) + ' (' + ['Yakshanba','Dushanba','Seshanba','Chorshanba','Payshanba','Juma','Shanba'][now2.getDay()] + ').\n\n' +
      'So\'nggi ' + intervalMin + ' daqiqada ekranda quyidagi o\'zgarishlar qayd etildi:\n\n' +
      newBlocks.join('\n\n') +
      patternsBlock +
      '\n\nYuqoridagi ODATLARGA qarab, hozirgi vaqt/holat bilan solishtiring: foydalanuvchi odatda shu payt/holatda ' +
      'nima qilishi kerak edi, lekin qilmagandek ko\'rinsa (masalan unutgan, chalg\'igan) — yoki hozirgi ekrandan chindan ' +
      'foydali/muhim bir taklif (xato, unutilgan vazifa, yordam kerak bo\'lgan holat) ko\'rsangiz — qisqa (2-3 gap) taklif ' +
      'qiling, nega bu taklifni berayotganingizni ham qisqa izohlang (masalan "odatda shu vaqt atrofida..."). Aks holda ' +
      'faqat "HECH_NARSA" deb javob bering, boshqa hech narsa yozmang.';
    const reply = await askAgent(prompt, 'agent:main:jarvis-proactive');
    const decision = proactivePolicy.evaluate({
      source: 'screen-proactive', summary: reply, confidence: 0.72,
      urgency: 0.35, benefit: 0.65, reversibility: 1, risk: 0.15, disruption: 0.35
    });
    if (reply && !reply.includes('HECH_NARSA') && reply.trim().length > 5 && decision.mode === 'suggest') {
      ok('💡 Proaktiv taklif: ' + reply.substring(0, 80));
      sendTelegram('💡 ' + reply);
      const audio = await ttsToFile(reply.substring(0, 300));
      if (audio) { try { execSync('afplay "' + audio + '"'); } catch (e) {} }
    }
  }

  return { run };
}

module.exports = { createProactiveCheckJob };
