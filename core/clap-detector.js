'use strict';

// ════════════════════════════════════════════
// DOUBLE-CLAP TRIGGER (silent wake)
// Tracks the raw energy computed each step: two quick quiet → sharp spike transitions
// in a row fire the same trigger as the hotword. No new audio pipeline is needed; it
// uses the existing getEnergy() value.
// ════════════════════════════════════════════
class ClapDetector {
  constructor({ absFloor = 250, spikeRatio = 4, quietRatio = 0.4, minGapMs = 120, maxGapMs = 900 } = {}) {
    this.prevEnergy = 0;
    this.baseline = 40;     // quiet background energy, adapted slowly
    this.absFloor = absFloor;
    this.spikeRatio = spikeRatio;
    this.quietRatio = quietRatio;
    this.minGapMs = minGapMs;
    this.maxGapMs = maxGapMs;
    this.threshold = absFloor;
    this.firstClapAt = 0;
    this.recentLoud = [];   // "was it loud" history of recent steps, to detect continuous speech
  }

  // Called every step. Returns true when the second clap is detected.
  feedEnergy(energy, now) {
    // The baseline updates slowly only during quiet moments (not spikes), so it adapts
    // to different microphone sensitivity and room noise on its own.
    if (energy < this.baseline * 2.5) this.baseline = this.baseline * 0.95 + energy * 0.05;
    this.threshold = Math.max(this.absFloor, this.baseline * this.spikeRatio);
    const quietCutoff = this.threshold * this.quietRatio;

    const isTransient = energy > this.threshold && this.prevEnergy < quietCutoff;
    this.prevEnergy = energy;

    // Continuous speech also has short "quiet" moments between syllables that can
    // accidentally look like "quiet -> spike" (especially with peak-based measurement).
    // To tell them apart, count how often the last ~1.2 s (6 steps) were loud: if often
    // (continuous activity, i.e. speech), no new clap trigger is accepted in that window.
    // A real clap, by contrast, happens ALONE against a quiet background.
    this.recentLoud.push(energy > quietCutoff);
    if (this.recentLoud.length > 6) this.recentLoud.shift();
    const busyLikelySpeech = this.recentLoud.filter(Boolean).length >= 4;

    if (!isTransient || busyLikelySpeech) {
      if (this.firstClapAt && (now - this.firstClapAt) > this.maxGapMs) this.firstClapAt = 0;
      return false;
    }

    if (!this.firstClapAt) {
      this.firstClapAt = now;
      return false;
    }

    const gap = now - this.firstClapAt;
    this.firstClapAt = 0;
    return gap >= this.minGapMs && gap <= this.maxGapMs;
  }
}

module.exports = { ClapDetector };
