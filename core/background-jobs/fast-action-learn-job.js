'use strict';

const fs = require('fs');
const path = require('path');
const { ok } = require('../log');

function loadFastActionLearnState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return { lastCheck: 0 }; }
}
function saveFastActionLearnState(stateFile, s) {
  try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch (e) {}
}

/**
 * Pulls the user's spoken requests out of one day's memory markdown.
 * Voice turns are written as "## HH:MM — Voice turn" blocks with a "User: ..." line
 * (older notes: "Ovozli turn" / "Foydalanuvchi: ..."); the oldest format used
 * "## HH:MM — Vazifa boshlandi|yakunlandi" blocks.
 */
function extractRequestDescriptions(markdown) {
  const descriptions = [];
  for (const block of String(markdown || '').split(/^---$/m)) {
    if (/^## \d{2}:\d{2} — (?:Voice turn|Ovozli turn)\s*$/m.test(block)) {
      const user = block.match(/^(?:User|Foydalanuvchi): (.+)$/m);
      if (user && !/^\((?:awaiting reply|javob kutilmoqda)\)$/.test(user[1].trim())) descriptions.push(user[1].trim().slice(0, 300));
      continue;
    }
    const legacy = block.match(/^## \d{2}:\d{2} — Vazifa (?:boshlandi|yakunlandi)\n([\s\S]{0,300})/m);
    if (legacy) descriptions.push(legacy[1].trim());
  }
  return descriptions;
}

// FAST-ACTION LEARNING: periodically reviews the user's recent spoken requests in Obsidian
// memory, finds "just open some app" requests that are not yet in the fast-actions list,
// and adds them automatically. Only the "open app" type is learned: it is safe, because a
// wrong or unknown name simply returns an error and nothing else happens.
function createFastActionLearnJob({ projectDir, localDateStr, askAgent, sendTelegram, writeMemory, skillPlatform }) {
  const stateFile = path.join(projectDir, '.fast-action-learn-state.json');

  async function run() {
    let mem;
    try { mem = require('../../skills/memory'); } catch (e) { return; }
    const state = loadFastActionLearnState(stateFile);

    // Collect request descriptions from the last 3 days of memory.
    const descriptions = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const fp = path.join(mem.MEMORY_DIR, localDateStr(d) + '.md');
      if (!fs.existsSync(fp)) continue;
      descriptions.push(...extractRequestDescriptions(fs.readFileSync(fp, 'utf8')));
    }
    state.lastCheck = Date.now();
    saveFastActionLearnState(stateFile, state);
    if (descriptions.length < 3) return; // not enough history yet; try again next time

    let existingIds;
    try { existingIds = (await skillPlatform.invoke('fast-actions', 'actionIds', {})).join(', '); } catch (e) { return; }

    const prompt = 'Below are requests the user made by voice in the last few days:\n\n' +
      descriptions.slice(-60).map(d => '- ' + d).join('\n') +
      '\n\nThese FAST ACTIONS already exist (ids): ' + existingIds +
      '\n\nFrom the requests above, find ONLY those that simply OPEN a computer program or app (nothing else, ' +
      'nothing complex), and return the EXACT app names that are NOT yet in the fast-actions list as a JSON array ' +
      '(e.g. ["Figma","Discord"]). If there is no new matching app, return an empty array: []. ' +
      'Reply with the JSON array only, nothing else.';

    const reply = await askAgent(prompt, 'agent:main:jarvis-fast-action-learn');
    if (!reply) return;
    let apps = [];
    try {
      const jsonMatch = reply.match(/\[[\s\S]*\]/);
      if (jsonMatch) apps = JSON.parse(jsonMatch[0]);
    } catch (e) { return; }
    if (!Array.isArray(apps) || !apps.length) return;

    const added = [];
    for (const app of apps.slice(0, 5)) { // at most 5 per run: slow, controlled growth
      if (typeof app !== 'string' || !app.trim()) continue;
      try {
        const r = await skillPlatform.invoke('fast-actions', 'learnOpenAppAction', { appName: app.trim() });
        if (r.status === 'ok') added.push(app.trim());
      } catch (e) {}
    }
    if (added.length) {
      ok('⚡ Learned new fast actions: ' + added.join(', '));
      sendTelegram('⚡ I added new fast actions based on your requests: ' + added.join(', ') + '. These will now run faster.');
      try { writeMemory('Fast action learned', 'Automatically added fast action(s): ' + added.join(', '), ['fast-action', 'autonomous']); } catch (e) {}
    }
  }

  return { run };
}

module.exports = { createFastActionLearnJob, extractRequestDescriptions };
