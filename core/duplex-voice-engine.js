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
    // Providers such as Gemini Live stream reply audio far ahead of real time, so
    // the reference must hold the whole queued reply. Truncating it to the newest
    // few seconds dropped the audio actually playing; echo then looked like a
    // barge-in and paused JARVIS mid-sentence.
    this.maxReferenceMs = options.maxReferenceMs || 120000;
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
    // `reference` is the contiguous head being aligned with the microphone;
    // `_pending` holds queued chunks so a long burst is not re-copied per chunk.
    this.reference = Buffer.alloc(0);
    this._pending = [];
    this._pendingBytes = 0;
    this.estimatedNoiseRms = this.noiseFloor;
    this._hangoverRemainingMs = 0;
  }

  queuePlayback(buffer) {
    if (!buffer?.length) return;
    const maxBytes = Math.floor(this.maxReferenceMs * this.sampleRate * 2 / 1000);
    if (this.reference.length + this._pendingBytes + buffer.length > maxBytes) return;
    this._pending.push(Buffer.from(buffer));
    this._pendingBytes += buffer.length;
  }

  clearPlayback() {
    this.reference = Buffer.alloc(0);
    this._pending = [];
    this._pendingBytes = 0;
  }

  _fillReference(bytes) {
    if (this.reference.length >= bytes || !this._pending.length) return;
    const parts = [this.reference];
    let total = this.reference.length;
    while (total < bytes && this._pending.length) {
      const next = this._pending.shift();
      this._pendingBytes -= next.length;
      parts.push(next);
      total += next.length;
    }
    this.reference = Buffer.concat(parts, total);
  }

  snapshot() {
    return {
      estimatedNoiseRms: Math.round(this.estimatedNoiseRms),
      speechThresholdRms: Math.round(this._speechThreshold()),
      hangoverRemainingMs: Math.round(this._hangoverRemainingMs),
      referenceMs: Math.round((this.reference.length + this._pendingBytes) / (this.sampleRate * 2) * 1000)
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
    this._fillReference(source.length + Math.floor(this.maxEchoLagMs * this.sampleRate * 2 / 1000) + 2);
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
    // While the player is paused (barge-in verification) nothing has been played,
    // so the reference must not advance or it runs ahead of the speaker.
    if (usable && !options.playbackPaused) this.reference = this.reference.slice(Math.min(this.reference.length, match.offset + usable));
    const residualRms = rms(residual);
    const echoOnly = options.assistantSpeaking && Math.abs(correlation) >= this.echoThreshold && residualRms < this.bargeInResidual;
    if (echoOnly) return { send: false, audio: residual, reason: 'echo', residualRms, correlation, ...this.snapshot() };

    const chunkMs = source.length / (this.sampleRate * 2) * 1000;
    const noiseCandidateCeiling = this.maxNoiseFloor / this.noiseMultiplier;
    if (!options.assistantSpeaking && residualRms <= noiseCandidateCeiling) {
      // Learns a steady low-energy background even if the initial threshold is wrongly
      // low. The ceiling keeps ordinary speech out of the profile.
      this.estimatedNoiseRms = (1 - this.noiseAlpha) * this.estimatedNoiseRms +
        this.noiseAlpha * residualRms;
    }
    const threshold = this._speechThreshold();
    // During playback the plain speech threshold is not enough: room echo that the AEC
    // reference does not match well can also pass it. Barge-in audio is sent to the
    // server only when it also exceeds the higher residual threshold from calibration.
    // Previously chunks were sent while assistantSpeaking even with `speech === false`;
    // server VAD saw them as a new turn and cancelled JARVIS's finished reply mid-way.
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
      // The room background is learned slowly, only from non-speech chunks. The upper
      // limit keeps air conditioning/wind from counting as speech without swallowing
      // genuinely quiet speech into the noise floor.
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