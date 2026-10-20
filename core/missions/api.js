'use strict';

const path = require('path');
const { OPEN } = require('./store');
const { StandingApprovals, SCOPES } = require('./standing');
const { resolveProject } = require('../project-locator');

const ACTIONS = new Set(['pause', 'resume', 'cancel', 'approve', 'reject', 'note']);

/**
 * Mission API for the voice session: every call returns in milliseconds (a file write), so the voice
 * conversation never waits on a long mission.
 */
function createMissionApi(store, options = {}) {
  const standing = options.standing || new StandingApprovals({ file: path.join(store.dir, 'standing-approvals.json') });
  return {
    standing,
    standingScopes: Object.keys(SCOPES),

    start(goal, options = {}) {
      const hours = Number(options.hours);
      let context = {};
      if (options.project) {
        const project = (options.resolveProject || resolveProject)(options.project);
        if (!project.ok) {
          const choices = project.candidates?.length ? ` Projects I found: ${project.candidates.join(', ')}.` : '';
          return `Mission not started: ${project.reason}.${choices} Ask the user which project they mean.`;
        }
        context = { projectDir: project.path, projectName: project.name };
      }
      const mission = store.create(goal, { source: 'voice', context, maxHours: Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 14) : 72 });
      const where = context.projectDir ? ` in project ${context.projectName}` : '';
      return `Mission ${mission.n} started${where}. It runs in the background until the goal is achieved or it needs you; I will report progress.`;
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

    grantStanding(options = {}) {
      const rule = standing.grant(options);
      return `Standing permission ${rule.id} granted: ${rule.scopes.join(', ')}, up to ${rule.perDay} per day for ${Math.round((rule.expiresAt - Date.now()) / 86400000)} days. Payments, deletions, passwords and permission changes are never covered.`;
    },

    listStanding() {
      const rules = standing.list();
      if (!rules.length) return 'No standing permissions are active.';
      return rules.map(rule => `${rule.id}: ${rule.scopes.join(', ')}, ${rule.perDay}/day, ${rule.usage.count} used today, expires in ${Math.max(0, Math.round((rule.expiresAt - Date.now()) / 86400000))} days`).join(' | ');
    },

    revokeStanding(id) {
      const count = standing.revoke(String(id || 'all'));
      return count ? `Revoked ${count} standing permission${count > 1 ? 's' : ''}.` : 'No matching standing permission.';
    },

    control(idOrNumber, action, payload = {}) {
      if (!ACTIONS.has(action)) return `Unknown action "${action}".`;
      let mission = idOrNumber ? store.get(idOrNumber) : null;
      if (!mission) {
        // No number given: pick the single open mission (or the single one awaiting approval).
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
