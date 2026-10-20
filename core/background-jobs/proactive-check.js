'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ok } = require('../log');

function loadProactiveState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return { lastCheck: Date.now() }; }
}
function saveProactiveState(stateFile, s) {
  try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch (e) {}
}

// "No action" conclusions are internal results and are never sent to the user.
// Only suggestions that match the strict contract and carry evidence become notifications.
function extractSuggestion(reply) {
  const match = String(reply || '').trim().match(/^SUGGESTION:\s*(.+)$/s);
  if (!match) return null;
  const suggestion = match[1].trim();
  return suggestion.length > 5 ? suggestion : null;
}

// PROACTIVE MODE: periodically reviews the Obsidian memory the screen monitor writes;
// when the agent finds something genuinely useful it only SUGGESTS it (it never acts
// on its own).
function createProactiveCheckJob({ projectDir, intervalMin, localDateStr, proactivePolicy, askAgent, sendTelegram, ttsToFile }) {
  const stateFile = path.join(projectDir, '.proactive-state.json');

  async function run() {
    const state = loadProactiveState(stateFile);
    let mem;
    try { mem = require('../../skills/memory'); } catch (e) { return; }
    const date = localDateStr();
    const filePath = path.join(mem.MEMORY_DIR, date + '.md');
    if (!fs.existsSync(filePath)) { state.lastCheck = Date.now(); saveProactiveState(stateFile, state); return; }

    const content = fs.readFileSync(filePath, 'utf8');
    const blocks = content.split(/^---$/m).map(b => b.trim()).filter(Boolean);
    const newBlocks = [];
    const now = new Date();
    for (const block of blocks) {
      const m = block.match(/^## (\d{2}):(\d{2}) — (.+)$/m);
      if (!m) continue;
      const [, hh, mm, topic] = m;
      if (!topic.includes('Ekran')) continue;
      const blockTime = new Date(now); blockTime.setHours(+hh, +mm, 0, 0);
      if (blockTime.getTime() > state.lastCheck) newBlocks.push(block);
    }

    state.lastCheck = Date.now();
    saveProactiveState(stateFile, state);
    if (!newBlocks.length) return;

    // Patterns learned over many days are included too, so suggestions are based on
    // real habits ("you usually do this at this time") rather than only on what is
    // visible right now.
    let patternsBlock = '';
    try {
      const profile = mem.readProfile();
      if (profile.status === 'ok') {
        const sections = profile.content.split(/^## /m).slice(1).filter(s => /^(?:O'rganilgan naqshlar|Learned patterns|Odatlar|Habits)/.test(s));
        if (sections.length) patternsBlock = '\n\n=== YOUR HABITS LEARNED OVER TIME ===\n' + sections.slice(-5).map(s => '## ' + s).join('\n');
      }
    } catch (e) {}

    const now2 = new Date();
    const prompt = 'Current time: ' + now2.toTimeString().slice(0, 5) + ' (' + ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now2.getDay()] + ').\n\n' +
      'In the last ' + intervalMin + ' minutes these screen changes were recorded:\n\n' +
      newBlocks.join('\n\n') +
      patternsBlock +
      '\n\nCompare the current time and situation with the HABITS above: if the user usually does something at this ' +
      'time or in this situation but seems not to have done it (e.g. forgot, got distracted), or if you see a genuinely ' +
      'useful or important suggestion on the current screen (an error, a forgotten task, a situation that needs help), reply ' +
      'only in the form "SUGGESTION: <a short, concrete suggestion and its evidence>". If there is no concrete suggestion, reply ' +
      'only "NO_ACTION". Never comment on missing memory search or other tools, on the evaluation process, or on why ' +
      'you are not sending a message.';
    const reply = await askAgent(prompt, 'agent:main:jarvis-proactive');
    const suggestion = extractSuggestion(reply);
    if (!suggestion) return;
    const decision = proactivePolicy.evaluate({
      source: 'screen-proactive', summary: suggestion, confidence: 0.72,
      urgency: 0.35, benefit: 0.65, reversibility: 1, risk: 0.15, disruption: 0.35
    });
    if (decision.mode === 'suggest') {
      ok('💡 Proaktiv taklif: ' + suggestion.substring(0, 80));
      sendTelegram('💡 ' + suggestion);
      const audio = await ttsToFile(suggestion.substring(0, 300));
      if (audio) { try { execSync('afplay "' + audio + '"'); } catch (e) {} }
    }
  }

  return { run };
}

module.exports = { createProactiveCheckJob, extractSuggestion };
