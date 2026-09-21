'use strict';

const { OPEN } = require('./store');

const ACTIONS = new Set(['pause', 'resume', 'cancel', 'approve', 'reject', 'note']);

/**
 * Ovozli sessiya uchun missiya API'si: har chaqiruv millisekundlarda qaytadi (fayl yozish), shuning uchun
 * ovozli suhbat hech qachon uzoq missiyani kutib qolmaydi.
 */
function createMissionApi(store) {
  return {
    start(goal, options = {}) {
      const hours = Number(options.hours);
      const mission = store.create(goal, { source: 'voice', maxHours: Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 14) : 72 });
      return `Mission ${mission.n} started. It runs in the background until the goal is achieved or it needs you; I will report progress.`;
    },

    status(idOrNumber) {
      if (idOrNumber) {
        const mission = store.get(idOrNumber);
        return mission ? store.describe(mission) : `No mission matches "${idOrNumber}".`;
      }
      const open = store.list({ open: true });
      if (!open.length) {
        const last = store.list().slice(-1)[0];
        return last ? `No active missions. Last one: ${store.describe(last)}` : 'No missions yet.';
      }
      return open.slice(-4).map(mission => store.describe(mission)).join(' | ');
    },

    control(idOrNumber, action, payload = {}) {
      if (!ACTIONS.has(action)) return `Unknown action "${action}".`;
      let mission = idOrNumber ? store.get(idOrNumber) : null;
      if (!mission) {
        // Raqam aytilmasa: bitta ochiq missiya bo'lsa (yoki tasdiq kutayotgan bitta bo'lsa) shuni tanlaymiz.
        const open = store.list({ open: true });
        const waiting = open.filter(m => m.status === 'awaiting_approval');
        const candidates = ['approve', 'reject'].includes(action) ? waiting : open;
        if (candidates.length === 1) mission = candidates[0];
        else return candidates.length ? `Which mission? Open ones: ${candidates.map(m => m.n).join(', ')}.` : 'There is no matching mission.';
      }
      if (!OPEN.has(mission.status) && !(action === 'resume' && mission.status === 'blocked')) return `Mission ${mission.n} is already ${mission.status}.`;
      store.enqueue(mission.id, action, payload);
      return `${action[0].toUpperCase()}${action.slice(1)} sent to mission ${mission.n}.`;
    }
  };
}

module.exports = { createMissionApi };
