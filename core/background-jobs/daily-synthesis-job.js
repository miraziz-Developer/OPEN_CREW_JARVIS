'use strict';

const { ok, er } = require('../log');

// Kunlik o'rganish: xom kuzatuvlardan barqaror naqshlarni ajratib,
// profilga qo'shadi. Skill o'zi qaysi kunlar bajarilganini eslab qoladi,
// shuning uchun tez-tez chaqirish xavfsiz (takror bajarilmaydi).
function createDailySynthesisJob({ sendTelegram }) {
  async function run() {
    try {
      const { synthesize, yesterday } = require('../../skills/daily-synthesis');
      const r = await synthesize(yesterday());
      if (r && r.learned && r.learned.length) {
        ok('🧠 O\'rganildi (' + r.date + '): ' + r.learned.length + ' ta naqsh profilga qo\'shildi');
        sendTelegram('🧠 Patterns learned from yesterday:\n' + r.learned.join('\n'));
      }
    } catch (e) { er('Kunlik o\'rganish xatolik: ' + (e.message || e)); }
  }

  return { run };
}

module.exports = { createDailySynthesisJob };
