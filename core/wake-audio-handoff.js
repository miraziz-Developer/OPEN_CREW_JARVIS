'use strict';

function createWakeAudioHandoff(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const muteUntil = Math.max(0, Number(options.muteUntil) || 0);
  const maxBytes = Math.max(0, Number(options.maxBytes) || 0);
  const chunks = Array.isArray(options.initialChunks)
    ? options.initialChunks.filter(Boolean).map(chunk => Buffer.from(chunk)) : [];
  let bytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
  let ready = false;

  function trim() {
    while (bytes > maxBytes && chunks.length) {
      const overflow = bytes - maxBytes;
      const first = chunks[0];
      if (first.length <= overflow) {
        chunks.shift();
        bytes -= first.length;
      } else {
        chunks[0] = first.subarray(overflow);
        bytes -= overflow;
      }
    }
  }

  trim();
  return {
    queue(chunk) {
      if (now() < muteUntil) return true;
      if (ready) return false;
      const audio = Buffer.from(chunk || []);
      if (audio.length) {
        chunks.push(audio);
        bytes += audio.length;
        trim();
      }
      return true;
    },
    markReady() { ready = true; },
    drain() {
      const buffered = chunks.splice(0);
      bytes = 0;
      return buffered;
    },
    get byteLength() { return bytes; }
  };
}

module.exports = { createWakeAudioHandoff };