'use strict';

/**
 * RAM hakami: bir vaqtda faqat BITTA backend (ollama yoki bonsai) xotirada bo'ladi.
 * - Boshqa backend kerak bo'lsa: joriy so'rovlar tugashini kutadi → eskisini chiqaradi → xotirani tekshiradi → yangisini beradi.
 * - Bir xil backend'ga kelgan so'rovlar navbatsiz o'tadi (Ollama o'z modellarini o'zi almashtiradi, MAX_LOADED_MODELS=1).
 * - Bonsai uchun bo'sh xotira yetmasa MemoryPressureError — chaqiruvchi kichikroq modelga tushadi (kompyuter qotmasin).
 */
class MemoryPressureError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'MemoryPressureError'; this.details = details; }
}

class BrainArbiter {
  constructor({ backends = {}, availableBytes = async () => Infinity, requirements = {}, log = () => {} } = {}) {
    this.backends = backends;           // { ollama: { evict() }, bonsai: { evict() } }
    this.availableBytes = availableBytes;
    this.requirements = requirements;   // { bonsai: bytes } — yuklashdan oldin kerakli bo'sh xotira
    this.log = log;
    this.resident = null;               // hozir xotiradagi backend nomi
    this.inFlight = 0;
    this.chain = Promise.resolve();     // backend almashtirishlar ketma-ket bo'ladi
    this.idleWaiters = [];
  }

  _waitIdle() {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  _release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight === 0) { const waiters = this.idleWaiters.splice(0); waiters.forEach(w => w()); }
  }

  // Slot oladi; qaytgan funksiya bilan bo'shatiladi. Har chaqiruv albatta release qilinishi kerak.
  acquire(backend) {
    const step = this.chain.then(async () => {
      if (this.resident !== backend) {
        await this._waitIdle();
        const previous = this.resident;
        if (previous && this.backends[previous]?.evict) {
          this.log(`evict ${previous} → ${backend}`);
          try { await this.backends[previous].evict(); } catch (e) { this.log(`evict ${previous} failed: ${e.message}`); }
        }
        this.resident = null;
        const need = this.requirements[backend] || 0;
        if (need) {
          const free = await this.availableBytes();
          if (free < need) {
            throw new MemoryPressureError(`not enough free memory for ${backend}: ${(free / 2 ** 30).toFixed(1)} GB < ${(need / 2 ** 30).toFixed(1)} GB`, { free, need });
          }
        }
        this.resident = backend;
      }
      this.inFlight += 1;
      let released = false;
      return () => { if (!released) { released = true; this._release(); } };
    });
    // Zanjir xatodan uzilmasin: keyingi so'rovlar davom etadi.
    this.chain = step.then(() => {}, () => {});
    return step;
  }

  // Backend o'zi bo'shasa (masalan bonsai idle-timeout bilan yopilsa) hakamga xabar beriladi.
  markEvicted(backend) { if (this.resident === backend && this.inFlight === 0) this.resident = null; }

  status() { return { resident: this.resident, inFlight: this.inFlight }; }
}

module.exports = { BrainArbiter, MemoryPressureError };
