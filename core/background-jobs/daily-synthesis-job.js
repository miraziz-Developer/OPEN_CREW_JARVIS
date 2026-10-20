'use strict';

const { ok, er } = require('../log');

// Daily learning: distils stable patterns from raw observations into the profile.
// The skill remembers which days it already processed, so frequent calls are safe
// (nothing runs twice).
function createDailySynthesisJob({ sendTelegram }) {
  async function run() {
    try {
      const { synthesize, yesterday } = require('../../skills/daily-synthesis');
      const r = await synthesize(yesterday());
      if (r && r.learned && r.learned.length) {
        ok('🧠 Learned (' + r.date + '): ' + r.learned.length + ' patterns added to the profile');
        sendTelegram('🧠 Patterns learned from yesterday:\n' + r.learned.join('\n'));
      }
    } catch (e) { er('Daily learning error: ' + (e.message || e)); }
  }

  return { run };
}

module.exports = { createDailySynthesisJob };
