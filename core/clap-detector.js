'use strict';

// ════════════════════════════════════════════
// IKKI MARTA QARSAK TRIGGER (ovozsiz chaqirish)
// Har step'da hisoblangan xom energiyani kuzatadi: tinch → keskin spike
// ikki marta ketma-ket bo'lsa — hotword bilan bir xil trigger ishlaydi.
// Yangi audio pipeline shart emas, mavjud getEnergy() qiymatidan foydalanadi.
// ════════════════════════════════════════════
class ClapDetector {
  constructor({ absFloor = 250, spikeRatio = 4, quietRatio = 0.4, minGapMs = 120, maxGapMs = 900 } = {}) {
    this.prevEnergy = 0;
    this.baseline = 40;     // tinch fon energiyasi — sekin adaptatsiya qilinadi
    this.absFloor = absFloor;
    this.spikeRatio = spikeRatio;
    this.quietRatio = quietRatio;
    this.minGapMs = minGapMs;
    this.maxGapMs = maxGapMs;
    this.threshold = absFloor;
    this.firstClapAt = 0;
    this.recentLoud = [];   // so'nggi steplar "baland bo'ldimi" tarixi — uzluksiz gapirishni sezish uchun
  }

  // Har step'da chaqiriladi. Ikkinchi qarsak aniqlansa true qaytaradi.
  feedEnergy(energy, now) {
    // Baseline faqat tinch paytlarda (spike emasda) sekin yangilanadi,
    // shunda turli mikrofon sezgirligi/xona shovqiniga o'zi moslashadi.
    if (energy < this.baseline * 2.5) this.baseline = this.baseline * 0.95 + energy * 0.05;
    this.threshold = Math.max(this.absFloor, this.baseline * this.spikeRatio);
    const quietCutoff = this.threshold * this.quietRatio;

    const isTransient = energy > this.threshold && this.prevEnergy < quietCutoff;
    this.prevEnergy = energy;

    // Uzluksiz gapirishda ham ayrim bo'g'inlar orasida qisqa "tinch"
    // moment bo'lib, tasodifan "tinch->spike" ko'rinishini hosil qilishi
    // mumkin (ayniqsa peak asosidagi o'lchovda). Shuni ajratish uchun:
    // so'nggi ~1.2s (6 step) ichida necha marta baland bo'lganini
    // kuzatamiz — agar ko'p bo'lsa (uzluksiz faol tovush, ya'ni gapirish),
    // bu vaqt oralig'ida yangi qarsak-trigger qabul qilinmaydi. Haqiqiy
    // qarsak esa aksincha, tinch fonda YAKKA holda sodir bo'ladi.
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
