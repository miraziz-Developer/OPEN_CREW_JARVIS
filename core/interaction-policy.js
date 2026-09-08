'use strict';

class InteractionPolicy {
  constructor(options = {}) {
    this.progressAfterMs = options.progressAfterMs || 1800;
    this.progressRepeatMs = options.progressRepeatMs || 12000;
  }

  notification(candidate = {}, context = {}) {
    if (context.privacyMode) return { allowed: false, mode: 'silent', reason: 'privacy-mode' };
    if ((context.meeting || context.focusMode) && Number(candidate.urgency || 0) < 0.9) {
      return { allowed: false, mode: 'queue', reason: context.meeting ? 'meeting' : 'focus-mode' };
    }
    return { allowed: true, mode: Number(candidate.urgency || 0) >= 0.9 ? 'interrupt' : 'suggest', reason: 'context-allows' };
  }

  responsePlan(task = {}) {
    const expectedMs = Math.max(0, Number(task.expectedMs) || 0);
    if (expectedMs < this.progressAfterMs) return { acknowledge: false, progress: [], completion: true };
    const progress = [];
    for (let at = this.progressAfterMs; at < expectedMs; at += this.progressRepeatMs) progress.push(at);
    return { acknowledge: true, acknowledgement: 'On it.', progress, completion: true };
  }
}

module.exports = { InteractionPolicy };