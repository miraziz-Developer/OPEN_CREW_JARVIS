'use strict';

const fs = require('fs');
const { percentile } = require('./voice-flight-recorder');

function readRecords(file, options = {}) {
  const maxLines = Number.isFinite(options.maxLines) ? options.maxLines : 5000;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  return text.split('\n').filter(Boolean).slice(-maxLines).flatMap(line => {
    try { return [JSON.parse(line)]; } catch (_) { return []; }
  });
}

function summarizeVoiceTelemetry(records) {
  const summaries = records.filter(record => record.type === 'turn.summary').map(record => record.data || {});
  const events = records.filter(record => record.type !== 'turn.summary');
  const eventCounts = {};
  for (const event of events) eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
  const eventsByTurn = new Map();
  for (const event of events) {
    if (!event.turnId) continue;
    if (!eventsByTurn.has(event.turnId)) eventsByTurn.set(event.turnId, []);
    eventsByTurn.get(event.turnId).push(event);
  }
  const responseLatency = summaries.map(turn => {
    if (Number.isFinite(turn.responseToFirstAudioMs)) return turn.responseToFirstAudioMs;
    const turnEvents = eventsByTurn.get(turn.turnId) || [];
    const firstAudio = turnEvents.find(event => event.type === 'assistant.audio.first');
    if (!firstAudio) return Number.isFinite(turn.timeToFirstAudioMs) ? turn.timeToFirstAudioMs : null;
    const accepted = turnEvents
      .filter(event => event.type === 'command.accepted' && event.at <= firstAudio.at)
      .at(-1);
    return accepted ? Math.max(0, firstAudio.at - accepted.at) : null;
  }).filter(Number.isFinite);
  const completed = summaries.filter(turn => turn.outcome === 'turn.completed').length;
  const suppressed = summaries.filter(turn => turn.outcome === 'turn.suppressed').length;
  const failed = summaries.filter(turn => turn.outcome === 'turn.failed').length;
  const total = summaries.length;
  const reasons = {};
  for (const event of events.filter(item => item.type === 'turn.suppressed')) {
    const reason = event.data?.reason || 'unknown';
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    privacy: { rawAudioStored: false, transcriptTextExpected: false },
    totals: { turns: total, completed, suppressed, failed },
    rates: {
      completionPct: total ? Math.round(completed / total * 10000) / 100 : null,
      suppressionPct: total ? Math.round(suppressed / total * 10000) / 100 : null,
      failurePct: total ? Math.round(failed / total * 10000) / 100 : null
    },
    latency: {
      firstAudioP50Ms: percentile(responseLatency, 0.5),
      firstAudioP95Ms: percentile(responseLatency, 0.95),
      measuredTurns: responseLatency.length,
      basis: 'command-accepted-to-first-audio'
    },
    eventCounts,
    suppressionReasons: reasons,
    recentTurns: summaries.slice(-20).reverse()
  };
}

function loadVoiceTelemetry(file, options) {
  return summarizeVoiceTelemetry(readRecords(file, options));
}

module.exports = { readRecords, summarizeVoiceTelemetry, loadVoiceTelemetry };