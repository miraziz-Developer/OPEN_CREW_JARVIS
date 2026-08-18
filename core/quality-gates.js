'use strict';

const DEFAULT_GATES = Object.freeze({
  wakeRecallPct: { target: 97, direction: 'min' },
  falseWakesPerDay: { target: 1, direction: 'max-exclusive' },
  sttAccuracyPct: { target: 93, direction: 'min' },
  firstAudioP95Ms: { target: 800, direction: 'max' },
  taskVerifiedSuccessPct: { target: 98, direction: 'min' },
  duplicateActions: { target: 0, direction: 'max' },
  falseCompletionClaims: { target: 0, direction: 'max' }
});

function evaluateMetric(value, gate) {
  if (!Number.isFinite(value)) return { status: 'not_measured', pass: false };
  let pass = false;
  if (gate.direction === 'min') pass = value >= gate.target;
  if (gate.direction === 'max') pass = value <= gate.target;
  if (gate.direction === 'max-exclusive') pass = value < gate.target;
  return { status: pass ? 'pass' : 'fail', pass };
}

function evaluateQuality(metrics, gates = DEFAULT_GATES) {
  const results = {};
  for (const [name, gate] of Object.entries(gates)) {
    const value = metrics[name];
    results[name] = { value: Number.isFinite(value) ? value : null, ...gate, ...evaluateMetric(value, gate) };
  }
  const measured = Object.values(results).filter(item => item.status !== 'not_measured');
  return {
    pass: measured.length === Object.keys(results).length && measured.every(item => item.pass),
    measured: measured.length,
    total: Object.keys(results).length,
    results
  };
}

module.exports = { DEFAULT_GATES, evaluateMetric, evaluateQuality };