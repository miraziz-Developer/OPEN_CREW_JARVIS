'use strict';

function makeWavHeader(dataLen, sampleRate = 16000, channels = 1, bits = 16) {
  const blockAlign = channels * bits / 8;
  const byteRate = sampleRate * blockAlign;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);        // subchunk1Size
  buf.writeUInt16LE(1, 20);         // audioFormat PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

function pcmToWavBuffer(pcm16leBuffer) {
  return Buffer.concat([makeWavHeader(pcm16leBuffer.length, 16000, 1, 16), pcm16leBuffer]);
}

function getEnergy(pcm16leBuffer) {
  if (pcm16leBuffer.length < 2) return 0;
  const samples = pcm16leBuffer.length / 2;
  let sum = 0;
  for (let i = 0; i < pcm16leBuffer.length; i += 2) {
    const v = pcm16leBuffer.readInt16LE(i);
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

// Qarsak — juda qisqa (bir necha millisekund) zarba. getEnergy() (RMS)
// butun 200ms oynani o'rtachalashtiradi, shuning uchun qisqa zarba tinch
// fon bilan aralashib, "yumshab" ketadi va chegaradan pastda qolib
// ketishi mumkin edi. Peak (eng baland cho'qqi) qarsakni yo'qotmaydi.
function getPeakAmplitude(pcm16leBuffer) {
  let peak = 0;
  for (let i = 0; i < pcm16leBuffer.length; i += 2) {
    const v = Math.abs(pcm16leBuffer.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}

module.exports = { makeWavHeader, pcmToWavBuffer, getEnergy, getPeakAmplitude };
