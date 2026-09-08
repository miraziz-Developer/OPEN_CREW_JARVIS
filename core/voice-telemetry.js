'use strict';

const fs = require('fs');
const { percentile } = require('./voice-flight-recorder');

function readRecords(file, options = {}) {
  const maxLines = Number.isFinite(options.maxLines) ? options.maxLines : 5000;
  const since = Number.isFinite(options.since) ? options.since : null;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  return text.split('\n').filter(Boolean).slice(-maxLines).flatMap(line => {
    try {
      const record = JSON.parse(line);
      const occurredAt = record.type === 'turn.summary'
        ? (record.data?.startedAt ?? record.at)
        : record.at;
      return since === null || (Number.isFinite(occurredAt) && occurredAt >= since) ? [record] : [];
    } catch (_) { return []; }
  });
}

const STAGE_DEFINITIONS = Object.freeze({
  commandToRoute: ['command.accepted', 'router.decision'],
  routeToRequest: ['router.decision', 'provider.request.sent'],
  requestToResponseCreated: ['provider.request.sent', 'provider.response.created'],
  requestToFirstText: ['provider.request.sent', 'assistant.text.first'],
  requestToFirstAudio: ['provider.request.sent', 'assistant.audio.first'],
  firstAudioToPlayback: ['assistant.audio.first', 'playback.started'],
  commandToPlayback: ['command.accepted', 'playback.started']
});

function firstEvent(events, type, notBefore = -Infinity) {
  return events.find(event => event.type === type && Number.isFinite(event.at) && event.at >= notBefore);
}

function stageSamplesForTurn(events) {
  const samples = {};
  for (const [name, [startType, endType]] of Object.entries(STAGE_DEFINITIONS)) {
    const start = firstEvent(events, startType);
    const end = start && firstEvent(events, endType, start.at);
    if (start && end) samples[name] = Math.max(0, end.at - start.at);
  }
  return samples;
}

function summarizeStages(samples) {
  const result = {};
  for (const name of Object.keys(STAGE_DEFINITIONS)) {
    const values = samples.map(sample => sample[name]).filter(Number.isFinite);
    result[name] = {
      measuredTurns: values.length,
      p50Ms: percentile(values, 0.5),
      p95Ms: percentile(values, 0.95)
    };
  }
  return result;
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
  const latencySamples = summaries.map(turn => {
    const turnEvents = eventsByTurn.get(turn.turnId) || [];
    const firstAudio = turnEvents.find(event => event.type === 'assistant.audio.first');
    const route = turnEvents.find(event => event.type === 'router.decision')?.data?.route || 'unknown';
    if (Number.isFinite(turn.responseToFirstAudioMs)) return turn.responseToFirstAudioMs;
    if (!firstAudio) return Number.isFinite(turn.timeToFirstAudioMs)
      ? { value: turn.timeToFirstAudioMs, route }
      : null;
    const accepted = turnEvents
      .filter(event => event.type === 'command.accepted' && event.at <= firstAudio.at)
      .at(-1);
    return accepted ? { value: Math.max(0, firstAudio.at - accepted.at), route } : null;
  }).map((sample, index) => Number.isFinite(sample)
    ? {
        value: sample,
        route: (eventsByTurn.get(summaries[index].turnId) || [])
          .find(event => event.type === 'router.decision')?.data?.route || 'unknown'
      }
    : sample).filter(sample => Number.isFinite(sample?.value));
  const responseLatency = latencySamples.map(sample => sample.value);
  const latencyByRoute = {};
  for (const route of new Set(latencySamples.map(sample => sample.route))) {
    const values = latencySamples.filter(sample => sample.route === route).map(sample => sample.value);
    latencyByRoute[route] = {
      measuredTurns: values.length,
      firstAudioP50Ms: percentile(values, 0.5),
      firstAudioP95Ms: percentile(values, 0.95)
    };
  }
  const stageSamples = summaries.map(turn => {
    const turnEvents = eventsByTurn.get(turn.turnId) || [];
    return {
      route: firstEvent(turnEvents, 'router.decision')?.data?.route || 'unknown',
      stages: stageSamplesForTurn(turnEvents)
    };
  });
  const stageLatencyByRoute = {};
  for (const route of new Set(stageSamples.map(sample => sample.route))) {
    stageLatencyByRoute[route] = summarizeStages(
      stageSamples.filter(sample => sample.route === route).map(sample => sample.stages)
    );
  }
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
      basis: 'command-accepted-to-first-audio',
      byRoute: latencyByRoute,
      stages: summarizeStages(stageSamples.map(sample => sample.stages)),
      stagesByRoute: stageLatencyByRoute
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