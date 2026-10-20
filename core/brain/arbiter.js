'use strict';

/**
 * RAM arbiter: only ONE backend (ollama or bonsai) is in memory at a time.
 * - When another backend is needed: wait for current requests → unload the old one → check memory → hand out the new one.
 * - Requests for the same backend pass without queueing (Ollama swaps its own models, MAX_LOADED_MODELS=1).
 * - If free memory is not enough for Bonsai: MemoryPressureError, and the caller falls back to a smaller model (the Mac must not freeze).
 */
class MemoryPressureError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'MemoryPressureError'; this.details = details; }
}

class BrainArbiter {
  constructor({ backends = {}, availableBytes = async () => Infinity, requirements = {}, log = () => {}, settleMs = 8000 } = {}) {
    this.settleMs = settleMs;
    this.backends = backends;           // { ollama: { evict() }, bonsai: { evict() } }
    this.availableBytes = availableBytes;
    this.requirements = requirements;   // { bonsai: bytes }: free memory required before loading
    this.log = log;
    this.resident = null;               // name of the backend currently in memory
    this.inFlight = 0;
    this.chain = Promise.resolve();     // backend switches happen one after another
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

  // Acquires a slot; the returned function releases it. Every call must be released.
  acquire(backend) {
    if (backend === 'gemini') {
      this.inFlight += 1;
      return Promise.resolve(() => this._release());
    }
    const step = this.chain.then(async () => {
      if (this.resident !== backend) {
        await this._waitIdle();
        const previous = this.resident;
        const need = this.requirements[backend] || 0;
        // Check first: is unloading the current model enough? If not, touch nothing; otherwise Qwen
        // would be unloaded for nothing and then reloaded for ~60 s (seen in the live log).
        if (need) {
          const free = await this.availableBytes();
          const reclaim = previous && this.backends[previous]?.footprintBytes ? await this.backends[previous].footprintBytes().catch(() => 0) : 0;
          if (free + reclaim < need) {
            throw new MemoryPressureError(`not enough free memory for ${backend}: ${((free + reclaim) / 2 ** 30).toFixed(1)} GB < ${(need / 2 ** 30).toFixed(1)} GB`, { free, reclaim, need });
          }
        }
        if (previous && this.backends[previous]?.evict) {
          this.log(`evict ${previous} → ${backend}`);
          try { await this.backends[previous].evict(); } catch (e) { this.log(`evict ${previous} failed: ${e.message}`); }
        }
        this.resident = null;
        if (need) {
          // Unloading is asynchronous (Ollama returns memory within a few seconds), so wait for it.
          let free = await this.availableBytes();
          for (const deadline = Date.now() + this.settleMs; free < need && Date.now() < deadline;) {
            await new Promise(r => setTimeout(r, 250));
            free = await this.availableBytes();
          }
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
    // An error must not break the chain: later requests continue.
    this.chain = step.then(() => {}, () => {});
    return step;
  }

  // The arbiter is told when a backend frees itself (e.g. bonsai closes on idle timeout).
  markEvicted(backend) { if (this.resident === backend && this.inFlight === 0) this.resident = null; }

  status() { return { resident: this.resident, inFlight: this.inFlight }; }
}

module.exports = { BrainArbiter, MemoryPressureError };
