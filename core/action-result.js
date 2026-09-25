'use strict';

const FAILURE_TEXT = /\b(?:i can(?:not|'t|’t)|unable to|cannot directly|could(?: not|n't|n’t)|do it (?:yourself|manually)|you(?:'ll| will) need to|qila olmayman|bajara olmadim|o['‘’]?zingiz|xato|error|failed|bajarilmadi|muvaffaqiyatsiz|permission denied|timeout)\b/i;
const TRUSTED_EVIDENCE = new Set([
  'accessibility', 'api-response', 'command-exit', 'dom', 'file-stat', 'process-state',
  'screenshot', 'test-report', 'world-state'
]);

function clean(value, max = 12000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function parseResult(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = clean(value);
  if (!text) return {};
  try { return JSON.parse(text); } catch (_) {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) try { return JSON.parse(fenced[1]); } catch (_) {}
  return { status: FAILURE_TEXT.test(text) ? 'failed' : 'unverified', summary: text };
}

function normalizeEvidence(evidence) {
  const list = Array.isArray(evidence) ? evidence : evidence ? [evidence] : [];
  return list.slice(0, 30).map(item => {
    if (typeof item === 'string') return { type: 'text', value: clean(item, 4000) };
    return {
      type: clean(item?.type || 'unknown', 80).toLowerCase(),
      value: item?.value ?? item?.path ?? item?.summary ?? null,
      ...(Number.isFinite(item?.exitCode) ? { exitCode: item.exitCode } : {}),
      ...(item?.before !== undefined ? { before: item.before } : {}),
      ...(item?.after !== undefined ? { after: item.after } : {})
    };
  }).filter(item => item.value !== null || item.exitCode !== undefined || item.after !== undefined);
}

function normalizeActionResult(value) {
  const raw = parseResult(value);
  const status = ['completed', 'failed', 'blocked', 'cancelled', 'unverified'].includes(raw.status)
    ? raw.status : 'unverified';
  const actions = (Array.isArray(raw.actions) ? raw.actions : []).slice(0, 30).map((action, index) => ({
    id: clean(action?.id || `action-${index + 1}`, 100),
    description: clean(action?.description || action?.action || action, 1000),
    status: ['completed', 'failed', 'skipped'].includes(action?.status) ? action.status : 'completed'
  }));
  return {
    version: 1,
    status,
    actions,
    verification: {
      passed: raw.verification?.passed === true,
      method: clean(raw.verification?.method, 120),
      checks: Array.isArray(raw.verification?.checks) ? raw.verification.checks.slice(0, 30) : []
    },
    evidence: normalizeEvidence(raw.evidence),
    summary: clean(raw.summary || raw.result || raw.message, 7000),
    error: clean(raw.error, 1000) || null
  };
}

function evidencePasses(item) {
  if (!TRUSTED_EVIDENCE.has(item.type)) return false;
  if (item.type === 'command-exit') return item.exitCode === 0 || item.value === 0 || item.value === '0';
  if (item.type === 'test-report' && item.value && typeof item.value === 'object') {
    return item.value.passed === true || (Number(item.value.failed) === 0 && Number(item.value.total) > 0);
  }
  return item.value !== null || item.after !== undefined;
}

function verifyActionResult(value, options = {}) {
  const result = normalizeActionResult(value);
  const checks = [];
  checks.push({ name: 'executor-status', passed: result.status === 'completed' });
  checks.push({ name: 'no-refusal-or-error', passed: !FAILURE_TEXT.test(`${result.summary} ${result.error || ''}`) });

  if (options.expected && options.worldModel) {
    const observed = options.worldModel.verify(options.before || null, options.after || options.worldModel.current(), options.expected);
    checks.push({ name: 'world-state', passed: observed.ok === true, details: observed.checks });
    if (observed.ok) result.evidence.push({ type: 'world-state', value: observed });
  }

  const trusted = result.evidence.filter(evidencePasses);
  checks.push({ name: 'trusted-evidence', passed: trusted.length > 0, count: trusted.length });

  const passed = result.verification.passed === true && checks.every(check => check.passed);
  result.verification = {
    passed,
    method: options.expected ? 'independent-world-model' : 'independent-evidence',
    checks
  };
  if (!passed && result.status === 'completed') result.status = 'unverified';
  return result;
}

function actionResultText(result) {
  const normalized = normalizeActionResult(result);
  return normalized.summary || normalized.error || 'Action did not produce a verified result.';
}

module.exports = {
  FAILURE_TEXT, TRUSTED_EVIDENCE, normalizeActionResult, verifyActionResult, actionResultText
};