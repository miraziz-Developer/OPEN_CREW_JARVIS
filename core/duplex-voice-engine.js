'use strict';

function clamp16(value) { return Math.max(-32768, Math.min(32767, Math.round(value))); }
function rms(buffer) {
  if (!buffer?.length) return 0;
  let sum = 0, count = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) { const v = buffer.readInt16LE(i); sum += v * v; count++; }
  return count ? Math.sqrt(sum / count) : 0;
}

class DuplexVoiceEngine {
  constructor(options = {}) {
    this.maxReferenceMs = options.maxReferenceMs || 3000;
    this.sampleRate = options.sampleRate || 24000;
    this.echoThreshold = options.echoThreshold || 0.72;
    this.bargeInResidual = options.bargeInResidual || 650;
    this.noiseFloor = options.noiseFloor || 80;
    this.noiseMultiplier = options.noiseMultiplier || 2.4;
    this.noiseAlpha = options.noiseAlpha || 0.06;
    this.maxNoiseFloor = options.maxNoiseFloor || 700;
    this.hangoverMs = options.hangoverMs || 650;
    this.maxEchoLagMs = options.maxEchoLagMs || 180;
    this.targetRms = options.targetRms || 1800;
    this.maxGain = options.maxGain || 3;
    this.reference = Buffer.alloc(0);
    this.estimatedNoiseRms = this.noiseFloor;
    this._hangoverRemainingMs = 0;
  }

  queuePlayback(buffer) {
    if (!buffer?.length) return;
    const maxBytes = Math.floor(this.maxReferenceMs * this.sampleRate * 2 / 1000);
    this.reference = Buffer.concat([this.reference, Buffer.from(buffer)]).slice(-maxBytes);
  }

  clearPlayback() { this.reference = Buffer.alloc(0); }

  snapshot() {
    return {
      estimatedNoiseRms: Math.round(this.estimatedNoiseRms),
      speechThresholdRms: Math.round(this._speechThreshold()),
      hangoverRemainingMs: Math.round(this._hangoverRemainingMs),
      referenceMs: Math.round(this.reference.length / (this.sampleRate * 2) * 1000)
    };
  }

  _speechThreshold() {
    return Math.max(this.noiseFloor, Math.min(this.maxNoiseFloor, this.estimatedNoiseRms * this.noiseMultiplier));
  }

  _bestReference(source) {
    if (!this.reference.length) return { ref: Buffer.alloc(0), offset: 0, correlation: 0, coefficient: 0 };
    const sourceSamples = Math.floor(source.length / 2);
    const maxOffset = Math.max(0, Math.min(
      this.reference.length - source.length,
      Math.floor(this.maxEchoLagMs * this.sampleRate * 2 / 1000)
    ));
    const step = Math.max(2, Math.floor(source.length / 8 / 2) * 2);
    let best = { score: 0, offset: 0, correlation: 0, coefficient: 0 };
    for (let offset = 0; offset <= maxOffset; offset += step) {
      const usable = Math.min(source.length, this.reference.length - offset) - (Math.min(source.length, this.reference.length - offset) % 2);
      let dot = 0, inPower = 0, refPower = 0;
      for (let i = 0; i < usable; i += 2) {
        const x = source.readInt16LE(i), y = this.reference.readInt16LE(offset + i);
        dot += x * y; inPower += x * x; refPower += y * y;
      }
      const correlation = inPower > 0 && refPower > 0 ? dot / Math.sqrt(inPower * refPower) : 0;
      const score = Math.abs(correlation) * (usable / Math.max(2, sourceSamples * 2));
      if (score > best.score) best = { score, offset, correlation, coefficient: refPower > 0 ? dot / refPower : 0 };
    }
    return {
      ref: this.reference.slice(best.offset, best.offset + source.length),
      offset: best.offset,
      correlation: best.correlation,
      coefficient: Math.max(-2, Math.min(2, best.coefficient))
    };
  }

  process(input, options = {}) {
    const source = Buffer.from(input || Buffer.alloc(0));
    if (!source.length) return { send: false, audio: source, reason: 'empty', residualRms: 0, correlation: 0 };
    const match = this._bestReference(source);
    const ref = match.ref;
    const usable = Math.min(source.length, ref.length) - (Math.min(source.length, ref.length) % 2);
    const coefficient = match.coefficient;
    const correlation = match.correlation;
    const residual = Buffer.alloc(source.length);
    for (let i = 0; i + 1 < source.length; i += 2) {
      const x = source.readInt16LE(i);
      const y = i < usable ? ref.readInt16LE(i) : 0;
      residual.writeInt16LE(clamp16(x - coefficient * y), i);
    }
    if (usable) this.reference = this.reference.slice(Math.min(this.reference.length, match.offset + usable));
    const residualRms = rms(residual);
    const echoOnly = options.assistantSpeaking && Math.abs(correlation) >= this.echoThreshold && residualRms < this.bargeInResidual;
    if (echoOnly) return { send: false, audio: residual, reason: 'echo', residualRms, correlation, ...this.snapshot() };

    const chunkMs = source.length / (this.sampleRate * 2) * 1000;
    const noiseCandidateCeiling = this.maxNoiseFloor / this.noiseMultiplier;
    if (!options.assistantSpeaking && residualRms <= noiseCandidateCeiling) {
      // Past energiyali barqaror fonni boshlang'ich threshold noto'g'ri past
      // bo'lsa ham o'rganadi. Ceiling odatiy nutqni profilga qo'shmaydi.
      this.estimatedNoiseRms = (1 - this.noiseAlpha) * this.estimatedNoiseRms +
        this.noiseAlpha * residualRms;
    }
    const threshold = this._speechThreshold();
    // Playback vaqtida oddiy speech threshold yetarli emas: AEC reference
    // bilan yaxshi mos kelmagan xona aks-sadosi ham shu chegaradan o'tishi
    // mumkin. Barge-in faqat kalibratsiyadan olingan yuqoriroq residual
    // chegarani ham bosib o'tganda serverga yuboriladi. Avval assistantSpeaking
    // holatida `speech === false` bo'lsa ham chunk yuborilardi; server VAD uni
    // yangi turn deb ko'rib, Jarvisning tayyor javobini o'rtasida bekor qilardi.
    const activeSpeechThreshold = options.assistantSpeaking
      ? Math.max(threshold, this.bargeInResidual)
      : threshold;
    const speech = residualRms >= activeSpeechThreshold;
    if (options.assistantSpeaking && !speech) {
      return {
        send: false,
        audio: residual,
        reason: 'playback-noise',
        residualRms,
        correlation,
        ...this.snapshot()
      };
    }
    if (!options.assistantSpeaking && !speech) {
      // Xona fonini faqat nutq bo'lmagan chunklarda sekin o'rganamiz. Yuqori
      // chegara konditsioner/shamolni nutq deb qabul qilmaslikka yordam beradi,
      // lekin haqiqiy past ovozni "noise floor" ichiga yutib yubormaydi.
      if (this._hangoverRemainingMs <= 0) {
        return { send: false, audio: residual, reason: 'noise', residualRms, correlation, ...this.snapshot() };
      }
      this._hangoverRemainingMs = Math.max(0, this._hangoverRemainingMs - chunkMs);
    } else if (speech) {
      // Trailing silence server VAD'ga yetib borishi shart. Avvalgi qattiq
      // gate jim chunklarni butunlay tashlab, speech_stopped'ni kechiktirardi.
      this._hangoverRemainingMs = this.hangoverMs;
    }
    const gain = Math.max(1, Math.min(this.maxGain, this.targetRms / Math.max(residualRms, 1)));
    for (let i = 0; i + 1 < residual.length; i += 2) residual.writeInt16LE(clamp16(residual.readInt16LE(i) * gain), i);
    const reason = options.assistantSpeaking ? 'barge-in' : (speech ? 'speech' : 'hangover');
    return { send: true, audio: residual, reason, residualRms, correlation, gain, ...this.snapshot() };
  }
}

module.exports = { DuplexVoiceEngine, rms };