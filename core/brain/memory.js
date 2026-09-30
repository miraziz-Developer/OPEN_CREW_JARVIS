'use strict';

const { execFile } = require('child_process');

// macOS'da os.freemem() keshni "band" deb hisoblaydi va juda kam ko'rsatadi. vm_stat bo'yicha haqiqatan
// qaytarib olinadigan xotira: free + inactive + speculative + purgeable sahifalar.
function parseVmStat(text) {
  const pageSize = Number((String(text).match(/page size of (\d+) bytes/) || [])[1]) || 16384;
  const pages = name => Number((String(text).match(new RegExp(`Pages ${name}:\\s+(\\d+)`)) || [])[1]) || 0;
  return (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * pageSize;
}

function parseMemoryPressure(text, totalBytes = require('os').totalmem()) {
  const pct = Number((String(text).match(/free percentage:\s*(\d+)%/) || [])[1]);
  return Number.isFinite(pct) ? totalBytes * pct / 100 : null;
}

// macOS'ning o'z baholashi (qaytarib olinadigan kesh bilan) — vm_stat'dan aniqroq; bo'lmasa vm_stat.
function availableBytes({ exec = execFile } = {}) {
  return new Promise(resolve => exec('/usr/bin/memory_pressure', { timeout: 5000 }, (err, stdout) => {
    const fromPressure = err ? null : parseMemoryPressure(stdout);
    if (fromPressure !== null) return resolve(fromPressure);
    exec('/usr/bin/vm_stat', { timeout: 3000 }, (err2, out2) => resolve(err2 ? Infinity : parseVmStat(out2)));
  }));
}

module.exports = { parseVmStat, parseMemoryPressure, availableBytes };
