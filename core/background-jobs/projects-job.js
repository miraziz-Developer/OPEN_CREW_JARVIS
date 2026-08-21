'use strict';

const { ok, wrn } = require('../log');

// LOYIHALAR — ko'p bosqichli, kun davomida ketma-ket bajariladigan
// avtonom ishlar (skills/projects). Oddiy kunlik vazifalardan farqi:
// bosqichlar BITTA umumiy session'da (bir-biridan xabardor holda)
// ketma-ket bajariladi, va loyiha tugagach ALOHIDA, konsolidatsiyalangan
// yakuniy hisobot beriladi (har bosqich uchun alohida emas).
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
    const prompt = 'Loyiha "' + active.project + '" ning navbatdagi bosqichi (' + (active.doneSteps + 1) + '/' + active.totalSteps + '): "' +
      active.step + '". Buni bajaring va natijani qisqa ayting. (Oldingi bosqichlar shu sessiyada allaqachon bajarilgan — ' +
      'ularning kontekstidan foydalaning.)';
    const reply = await askAgent(prompt, sessionKey);
    if (!reply) {
      missions.failStep(missionId, execution.step.id, 'Agent bo‘sh natija qaytardi');
      return;
    }

    // Agent xato/cheklov sabab vazifani bajarmaganini aniq aytsa, uni
    // muvaffaqiyatli bosqich sifatida yopib yubormaymiz. Cheksiz loopga
    // tushmaslik uchun urinishlar persistent hisoblanadi.
    const stepIncomplete = /\b(xato|bajarilmadi|uddalay olmadim|muvaffaqiyatsiz|permission denied|ruxsat yo.q)\b/i.test(reply);
    if (stepIncomplete) {
      const failed = missions.failStep(missionId, execution.step.id, reply);
      const attempts = failed.attempts;
      wrn('Loyiha bosqichi bajarilmadi (' + attempts + '/' + stepMaxAttempts + '): ' + active.step);
      return; // Hech qachon chala bosqichni completeStep() orqali keyingisiga o'tkazmaymiz.
    } else {
      const verified = recordMissionResult(missionId, execution.step.id, reply, { type: 'agent-result', value: reply });
      if (!verified || verified.status !== 'verified') return;
    }

    const result = projMod.completeStep(active.slug, active.step);
    if (result.status !== 'ok') return;

    ok('📁 Loyiha bosqichi bajarildi: ' + active.project + ' (' + (active.doneSteps + 1) + '/' + active.totalSteps + ')');
    try {
      writeMemory('Loyiha bosqichi: ' + active.project, 'Bosqich: ' + active.step + '\nNatija: ' + reply.substring(0, 500),
        ['project', 'autonomous', 'verified']);
    } catch (e) {}

    if (result.complete) {
      // Barcha bosqichlar tugadi — yakuniy, konsolidatsiyalangan hisobot
      const reportPrompt = 'Loyiha "' + active.project + '" barcha bosqichlari (' + result.allSteps.join(', ') +
        ') muvaffaqiyatli bajarildi (shu sessiyada). Foydalanuvchi uchun QISQA (3-5 gap) yakuniy hisobot yozing — ' +
        'nima qilindi, muhim natijalar. Texnik tafsilotsiz, oddiy tilda.';
      const finalReport = await askAgent(reportPrompt, sessionKey);
      if (finalReport) {
        ok('📁 Loyiha yakunlandi: ' + active.project);
        sendTelegram('📁 Loyiha yakunlandi — "' + active.project + '":\n\n' + finalReport);
        try { writeMemory('Loyiha yakunlandi: ' + active.project, finalReport, ['project', 'report', 'autonomous']); } catch (e) {}
      }
    }
  }

  return { run };
}

module.exports = { createProjectsJob };
