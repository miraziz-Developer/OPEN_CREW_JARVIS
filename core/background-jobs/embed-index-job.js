'use strict';

const { inf, wrn } = require('../log');

// XOTIRA INDEKSINI FONDA YANGILASH — semantik (ma'no bo'yicha) qidiruv
// butun tarix bo'ylab ishlashi uchun har bir yangi xotira bloki
// indekslanishi kerak. Avval bu indekslash QIDIRUV ichida bajarilardi —
// real o'lchovda 125 SONIYA (qidiruvning o'zi esa atigi 611 ms). Endi u
// shu yerda, fonda, muntazam bajariladi; qidiruv esa doim tayyor
// indeksdan o'qib, bir zumda javob beradi.
function createEmbedIndexJob() {
  let running = false;

  async function run() {
    if (running) return; // oldingisi hali tugamagan bo'lsa, ustma-ust ishga tushmasin
    running = true;
    try {
      const mem = require('../../skills/memory');
      const t0 = Date.now();
      const r = await mem.updateEmbedIndex();
      if (r && r.added > 0) inf('🧠 Xotira indeksi yangilandi: +' + r.added + ' (jami ' + r.total + ', ' + Math.round((Date.now() - t0) / 1000) + 's)');
    } catch (e) { wrn('Xotira indeksi yangilanmadi: ' + (e.message || e)); }
    finally { running = false; }
  }

  return { run };
}

module.exports = { createEmbedIndexJob };
