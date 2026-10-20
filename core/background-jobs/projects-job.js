'use strict';

const { ok, wrn } = require('../log');

// PROJECTS: multi-step autonomous work done in sequence during the day
// (skills/projects). Unlike plain daily tasks, steps run in ONE shared session
// (each aware of the others), and when the project finishes a SEPARATE,
// consolidated final report is delivered (not one per step).
function createProjectsJob({ missions, stableId, beginSingleStepMission, recordMissionResult, stepMaxAttempts, askAgent, sendTelegram, writeMemory }) {
  async function run() {
    let projMod;
    try { projMod = require('../../skills/projects'); } catch (e) { return; }
    const active = projMod.activeStep();
    if (!active) return;

    const missionId = stableId('project-step', active.slug + ':' + active.step);
    const execution = beginSingleStepMission(active.step, {
      id: missionId, source: 'project', idempotencyKey: 'project:' + active.slug + ':' + active.step,
      maxAttempts: stepMaxAttempts, metadata: { project: active.project, slug: active.slug }
    });
    if (!execution.step) return;
    const sessionKey = 'agent:main:jarvis-project-' + active.slug;
    const prompt = 'Next step of project "' + active.project + '" (' + (active.doneSteps + 1) + '/' + active.totalSteps + '): "' +
      active.step + '". Do it and report the result briefly. (Earlier steps were already done in this session; ' +
      'use their context.)';
    const reply = await askAgent(prompt, sessionKey);
    if (!reply) {
      missions.failStep(missionId, execution.step.id, 'The agent returned an empty result');
      return;
    }

    // If the agent clearly says it could not do the task (error or restriction), do not
    // close it as a successful step. Attempts are persisted so this cannot loop forever.
    const stepIncomplete = /\b(xato|bajarilmadi|uddalay olmadim|muvaffaqiyatsiz|ruxsat yo.q|permission denied|failed|unable to|could(?:n'?t| not))\b/i.test(reply);
    if (stepIncomplete) {
      const failed = missions.failStep(missionId, execution.step.id, reply);
      const attempts = failed.attempts;
      wrn('Project step not completed (' + attempts + '/' + stepMaxAttempts + '): ' + active.step);
      return; // Never move an incomplete step on via completeStep().
    } else {
      const verified = recordMissionResult(missionId, execution.step.id, reply, { type: 'agent-result', value: reply });
      if (!verified || verified.status !== 'verified') return;
    }

    const result = projMod.completeStep(active.slug, active.step);
    if (result.status !== 'ok') return;

    ok('📁 Project step done: ' + active.project + ' (' + (active.doneSteps + 1) + '/' + active.totalSteps + ')');
    try {
      writeMemory('Project step: ' + active.project, 'Step: ' + active.step + '\nResult: ' + reply.substring(0, 500),
        ['project', 'autonomous', 'verified']);
    } catch (e) {}

    if (result.complete) {
      // All steps are done: write the final, consolidated report
      const reportPrompt = 'All steps of project "' + active.project + '" (' + result.allSteps.join(', ') +
        ') were completed (in this session). Write a SHORT (3-5 sentence) final report for the user: ' +
        'what was done and the key results. Plain language, no technical detail.';
      const finalReport = await askAgent(reportPrompt, sessionKey);
      if (finalReport) {
        ok('📁 Project finished: ' + active.project);
        sendTelegram('📁 Project completed — “' + active.project + '”:\n\n' + finalReport);
        try { writeMemory('Project finished: ' + active.project, finalReport, ['project', 'report', 'autonomous']); } catch (e) {}
      }
    }
  }

  return { run };
}

module.exports = { createProjectsJob };
