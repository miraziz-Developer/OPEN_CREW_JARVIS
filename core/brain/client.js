'use strict';

const http = require('http');

// JARVIS kodidan Brain xizmatiga murojaat (barcha jarayonlar bitta hakam orqali o'tadi).
function brainEnabled(env = k => process.env[k]) {
  return String(env('JARVIS_BRAIN') || '').trim().toLowerCase() === 'local';
}

function think(req, { port = Number(process.env.BRAIN_PORT) || 11435, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(req || {});
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/brain/think', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      let data = ''; res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(data); } catch (_) { return reject(new Error('Brain javobi o\'qilmadi')); }
        if (res.statusCode >= 400) return reject(new Error(parsed.error || `Brain HTTP ${res.statusCode}`));
        if (!parsed.text) return reject(new Error('bo\'sh Brain javobi'));
        resolve(parsed);
      });
    });
    r.on('error', e => reject(new Error('Brain xizmati ishlamayapti (com.jarvis.brain): ' + e.message)));
    r.setTimeout(timeoutMs, () => r.destroy(new Error('Brain timeout')));
    r.write(payload); r.end();
  });
}

module.exports = { think, brainEnabled };
