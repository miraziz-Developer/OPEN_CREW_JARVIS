'use strict';

const fs = require('fs');
const path = require('path');
const { ok } = require('../log');

function loadFastActionLearnState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return { lastCheck: 0 }; }
}
function saveFastActionLearnState(stateFile, s) {
  try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch (e) {}
}

// TEZ AMALLARNI O'RGANISH (fast-actions) — vaqti-vaqti bilan Obsidian
// xotirasidagi so'nggi kunlar vazifalarini ("Vazifa boshlandi"/"Vazifa
// yakunlandi" sifatida yozilgan) ko'rib, "shunchaki biror dastur ochish"
// turidagi, hali fast-actions ro'yxatida yo'q so'rovlarni topadi va
// avtomatik qo'shadi (faqat "ilova ochish" turi — xavfsiz, chunki
// noto'g'ri/mavjud bo'lmagan nom shunchaki xato qaytaradi, boshqa hech
// qanday amal bajarilmaydi).
function createFastActionLearnJob({ projectDir, localDateStr, askAgent, sendTelegram, writeMemory, skillPlatform }) {
  const stateFile = path.join(projectDir, '.fast-action-learn-state.json');

  async function run() {
    let mem;
    try { mem = require('../../skills/memory'); } catch (e) { return; }
    const state = loadFastActionLearnState(stateFile);

    // So'nggi 3 kunlik xotiradan vazifa tavsiflarini yig'amiz.
    const descriptions = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const fp = path.join(mem.MEMORY_DIR, localDateStr(d) + '.md');
      if (!fs.existsSync(fp)) continue;
      const content = fs.readFileSync(fp, 'utf8');
      const blocks = content.split(/^---$/m);
      for (const b of blocks) {
        const m = b.match(/^## \d{2}:\d{2} — Vazifa (boshlandi|yakunlandi)\n([\s\S]{0,300})/m);
        if (m) descriptions.push(m[2].trim());
      }
    }
    state.lastCheck = Date.now();
    saveFastActionLearnState(stateFile, state);
    if (descriptions.length < 3) return; // yetarli tarix yo'q, keyingi safar qayta ko'radi

    let existingIds;
    try { existingIds = (await skillPlatform.invoke('fast-actions', 'actionIds', {})).join(', '); } catch (e) { return; }

    const prompt = 'Quyidagi ro\'yxat — foydalanuvchi so\'nggi kunlarda ovozli buyruq bilan so\'ragan vazifalar tavsifi:\n\n' +
      descriptions.slice(-60).map(d => '- ' + d).join('\n') +
      '\n\nHozir tizimda quyidagi TEZ AMALLAR (fast actions) allaqachon mavjud (id ro\'yxati): ' + existingIds +
      '\n\nYuqoridagi vazifalar orasidan, FAQAT "biror kompyuter dasturi/ilovasini shunchaki OCHISH" turidagi ' +
      '(boshqa hech narsa qilmasdan, murakkab bo\'lmagan) so\'rovlarni top, va ular orasida HALI fast actions ' +
      'ro\'yxatida YO\'Q bo\'lgan, ANIQ ilova nomlarini JSON massiv sifatida qaytar (masalan ["Figma","Discord"]). ' +
      'Agar mos keluvchi yangi ilova topilmasa, bo\'sh massiv qaytar: []. Faqat JSON massiv yoz, boshqa hech narsa qo\'shma.';

    const reply = await askAgent(prompt, 'agent:main:jarvis-fast-action-learn');
    if (!reply) return;
    let apps = [];
    try {
      const jsonMatch = reply.match(/\[[\s\S]*\]/);
      if (jsonMatch) apps = JSON.parse(jsonMatch[0]);
    } catch (e) { return; }
    if (!Array.isArray(apps) || !apps.length) return;

    const added = [];
    for (const app of apps.slice(0, 5)) { // bir safarda ko'pi bilan 5 ta — sekin-asta, nazorat ostida o'sish
      if (typeof app !== 'string' || !app.trim()) continue;
      try {
        const r = await skillPlatform.invoke('fast-actions', 'learnOpenAppAction', { appName: app.trim() });
        if (r.status === 'ok') added.push(app.trim());
      } catch (e) {}
    }
    if (added.length) {
      ok('⚡ Yangi tez amallar o\'rganildi: ' + added.join(', '));
      sendTelegram('⚡ So\'rovlaringiz asosida yangi tez amallar qo\'shdim: ' + added.join(', ') + ' — endi bular tezroq bajariladi.');
      try { writeMemory('Tez amal o\'rganildi', 'Avtomatik qo\'shilgan yangi fast-action(lar): ' + added.join(', '), ['fast-action', 'autonomous']); } catch (e) {}
    }
  }

  return { run };
}

module.exports = { createFastActionLearnJob };
