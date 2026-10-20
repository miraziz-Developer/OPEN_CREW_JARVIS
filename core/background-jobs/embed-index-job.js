'use strict';

const { inf, wrn } = require('../log');

// BACKGROUND MEMORY INDEXING: for semantic (meaning-based) search to cover the whole
// history, every new memory block must be indexed. Indexing used to run INSIDE the
// search: 125 SECONDS in a real measurement (the search itself took only 611 ms). It
// now runs regularly here, in the background, and searches read a ready index and
// answer instantly.
function createEmbedIndexJob() {
  let running = false;

  async function run() {
    if (running) return; // if the previous run is still going, do not start another on top
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
