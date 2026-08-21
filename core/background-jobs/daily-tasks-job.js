'use strict';

const fs = require('fs');
const path = require('path');
const { ok, wrn } = require('../log');

function loadDailyTasksState(stateFile, todayStr) {
  let s;
  try { s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { s = null; }
  if (!s || s.date !== todayStr()) s = { date: todayStr(), completed: [] };
  return s;
}
function saveDailyTasksState(stateFile, s) {
  try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch (e) {}
}

// Vazifa matnidagi vaqt belgisi ("Har kuni 19:30 — ...", "soat 11:00 da")
// — shu vaqtdan OLDIN bajarilmasligi kerak.
function scheduledMinutes(text) {
  const m = String(text).match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]);
}
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// KUNLIK VAZIFALAR — Obsidian'dagi ro'yxat (skills/tasks). Ro'yxatga
// tushgan narsa uchun alohida ruxsat so'ralmaydi — kun davomida navbat
// bilan avtomatik bajariladi (SOUL.md Chegaralar hali kuchda: qaytarib
// bo'lmaydigan amallar baribir so'raladi).
function createDailyTasksJob({ projectDir, localDateStr, leadMin, stableId, beginSingleStepMission, recordMissionResult, askAgent, sendTelegram, writeMemory }) {
  const stateFile = path.join(projectDir, '.daily-tasks-state.json');
  const todayStr = () => localDateStr();

  async function run() {
    let tasksMod;
    try { tasksMod = require('../../skills/tasks'); } catch (e) { return; }
    const active = tasksMod.activeTasks();
    if (!active.length) return;

    const state = loadDailyTasksState(stateFile, todayStr);
    const cur = nowMinutes();
    // Vaqti belgilangan vazifa faqat o'sha vaqt kelgach bajariladi. Vaqt
    // yozilmagan vazifa (avvalgidek) istalgan paytda bajarilaveradi.
    // Belgilangan vaqt o'tib ketgan bo'lsa ham bajariladi (masalan kompyuter
    // 19:30da o'chiq bo'lsa, 20:10da yoqilganda baribir eslatadi).
    // Oldindan tayyorlanish: vazifaning o'zi bajarilishi ham vaqt oladi
    // (agent chaqiruvi, brauzer va h.k.), shuning uchun belgilangan vaqtdan
    // leadMin daqiqa oldin boshlanadi — natija/eslatma foydalanuvchiga
    // aynan kerakli vaqtda yetib borsin, kechikib emas.
    const next = active.find(t => {
      if (state.completed.includes(t)) return false;
      const sched = scheduledMinutes(t);
      return sched === null || cur >= (sched - leadMin);
    });
    if (!next) return;

    const execution = beginSingleStepMission(next, {
      id: stableId('daily', todayStr() + ':' + next), source: 'daily-task',
      idempotencyKey: 'daily:' + todayStr() + ':' + next, maxAttempts: 3
    });
    if (!execution.step) return;
    const prompt = 'Kunlik vazifalar ro\'yxatidagi vazifa: "' + next + '". Buni bajaring va natijani qisqa ayting.';
    const reply = await askAgent(prompt, 'agent:main:jarvis-daily-tasks-' + Date.now());
    const verified = recordMissionResult(execution.mission.id, execution.step.id, reply, { type: 'agent-result', value: reply });
    if (!verified || verified.status !== 'verified') {
      wrn('📋 Vazifa tasdiqlanmadi, completed qilinmadi: ' + next);
      return;
    }
    state.completed.push(next);
    saveDailyTasksState(stateFile, state);
    if (reply) {
      ok('📋 Vazifa bajarildi: ' + next);
      sendTelegram('✅ "' + next + '":\n' + reply);
      try { writeMemory('Kunlik vazifa bajarildi', 'Vazifa: ' + next + '\nNatija: ' + reply.substring(0, 500), ['daily-task', 'autonomous']); } catch (e) {}
    }
  }

  return { run };
}

module.exports = { createDailyTasksJob };
