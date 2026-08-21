'use strict';

const { spawn } = require('child_process');

// ════════════════════════════════════════════
// STT PROMISE POOL (pre-spawned children)
// ════════════════════════════════════════════
class STTPool {
  constructor({ size = 2, projectDir, env } = {}) {
    this.size = size;
    this.projectDir = projectDir;
    this.pool = [];
    this.env = { ...process.env, AZURE_SPEECH_KEY: env('AZURE_SPEECH_KEY'), AZURE_SPEECH_REGION: env('AZURE_SPEECH_REGION') };
    for (let i = 0; i < size; i++) this._spawn(i);
  }

  _spawn(idx) {
    const proc = spawn('node', ['skills/azure-stt/index.js'], { cwd: this.projectDir, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    proc._busy = false;
    proc._idx = idx;
    proc._buffer = '';
    // stdout listener recognize() ichida qo'shiladi — bu yerda emas
    // (ikkalasi baravar bo'lsa har bir chunk ikki marta buffer'ga
    // qo'shilib, JSON'ni buzib, timeout'gacha "natija topilmadi" bergan)
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', () => {}); // EPIPE qo'lga olinmasa butun daemon'ni yiqitadi
    proc.on('error', () => { this._respawn(idx); });
    proc.on('exit', () => { this._respawn(idx); });
    this.pool[idx] = proc;
  }

  _respawn(idx) {
    try { this.pool[idx]?.kill?.(); } catch(e){}
    this._spawn(idx);
  }

  async recognize(audioWavBuffer, locale = 'uz-UZ') {
    // find idle child
    let child = this.pool.find(p => !p._busy);
    if (!child) {
      // all busy, just take the one with most data
      child = this.pool.reduce((a, b) => (a._buffer.length < b._buffer.length ? a : b));
      child._buffer = '';
    }
    child._busy = true;
    child._buffer = '';

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.stdout.off('data', onData); // aks holda listener to'planib, keyingi chaqiruvlarni buzadi
        child._busy = false;
        resolve({ status: 'error', text: '', reason: 'timeout' });
      }, 12000);
      const onData = (d) => {
        child._buffer += d;
        const lines = child._buffer.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.status || parsed.error) {
              clearTimeout(timeout);
              child.stdout.off('data', onData);
              child._busy = false;
              resolve(parsed.status === 'ok' ? parsed : { status: 'error', text: '', reason: parsed.error || 'unknown' });
              return;
            }
          } catch(e) {}
        }
      };
      child.stdout.on('data', onData);
      child.stdin.write(JSON.stringify({ audioBase64: audioWavBuffer.toString('base64'), locale }) + '\n');
    });
  }

  killAll() { this.pool.forEach(p => { try { p.kill('SIGKILL'); } catch(e){} }); }
}

module.exports = { STTPool };
