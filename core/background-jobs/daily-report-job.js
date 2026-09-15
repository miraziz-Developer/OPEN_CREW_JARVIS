'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ok } = require('../log');

const REPORT_TAGS = ['task', 'daily-task', 'realtime', 'voice', 'autonomous'];

function loadDailyReportState(stateFile, todayStr) {
  let s;
  try { s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { s = null; }
  if (!s || s.date !== todayStr()) s = { date: todayStr(), sent: false };
  return s;
}
function saveDailyReportState(stateFile, s) {
  try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch (e) {}
}

// KUNLIK O'Z-O'ZINI HISOBOT — kun oxirida (mahalliy soat) bugun mustaqil
// bajarilgan barcha ishlar (ovozli buyruqlar, kunlik vazifalar, jonli
// suhbatdagi parallel task'lar) qisqa xulosa qilinib, Telegram+ovoz orqali
// aytiladi. To'liq avtonom ruxsat berilgani uchun — nazorat o'rniga
// shaffoflikni saqlash uchun.
function createDailyReportJob({ projectDir, localDateStr, reportHour, askAgent, sendTelegram, writeMemory, ttsToFile }) {
  const stateFile = path.join(projectDir, '.daily-report-state.json');
  const todayStr = () => localDateStr();

  async function run() {
    const state = loadDailyReportState(stateFile, todayStr);
    if (state.sent) return;
    if (new Date().getHours() < reportHour) return;

    let mem;
    try { mem = require('../../skills/memory'); } catch (e) { return; }
    const filePath = path.join(mem.MEMORY_DIR, todayStr() + '.md');
    if (!fs.existsSync(filePath)) { state.sent = true; saveDailyReportState(stateFile, state); return; }

    const content = fs.readFileSync(filePath, 'utf8');
    const blocks = content.split(/^---$/m).map(b => b.trim()).filter(Boolean);
    const relevant = blocks.filter(b => REPORT_TAGS.some(t => b.includes('#' + t)));

    state.sent = true; // natijadan qat'iy nazar bugun qayta yubormaymiz
    saveDailyReportState(stateFile, state);
    if (!relevant.length) return; // bugun mustaqil ish bo'lmagan bo'lsa, hisobot yubormaymiz

    const prompt = 'Bugun quyidagi ishlar (ovozli buyruqlar, mustaqil bajarilgan vazifalar) amalga oshirildi:\n\n' +
      relevant.join('\n\n').slice(0, 8000) +
      '\n\nFoydalanuvchi uchun QISQA (3-6 gap), oddiy tilda, texnik tafsilotsiz kunlik hisobot yozing — nima qilindi, ' +
      'muhim natijalar. Kirish/xulosa jumlasi shart emas, to\'g\'ridan-to\'g\'ri mazmun bilan boshlang.';
    const reply = await askAgent(prompt, 'agent:main:jarvis-daily-report-' + todayStr());
    if (!reply) return;

    ok('📊 Kunlik hisobot tayyor');
    sendTelegram('📊 Today’s report:\n\n' + reply);
    try { writeMemory('Kunlik hisobot', reply, ['report']); } catch (e) {}
    const audio = await ttsToFile(reply.substring(0, 400));
    if (audio) { try { execSync('afplay "' + audio + '"'); } catch (e) {} }
  }

  return { run };
}

module.exports = { createDailyReportJob };
