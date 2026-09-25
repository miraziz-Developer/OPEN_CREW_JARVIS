'use strict';

const COMPLEX_TASK = /\b(architecture|architect|strategy|tradeoffs?|design (?:a|an|the)?|multi[ -]?step|roadmap|migration|root cause|debug(?:ging)?|security review|implementation plan|system design|comprehensive|in[- ]depth|plan|research|analysis|implement(?:ation)?|refactor|code review|coding|chuqur|arxitektura|strategiya|taqqosla|reja(?:si|lashtir)?|ko'p bosqich|muammoni tahlil)\b/i;
const TOOL_TASK = /\b(run|execute|terminal|shell|command|script|code|file|folder|browser|website|email|calendar|deploy|test|build|fix|create|update|install|download|upload|send|open|click|phone|iphone|screen|telegram|whatsapp)\b/i;

function unique(values) {
  return values.map(value => String(value || '').trim()).filter((value, index, list) => value && list.indexOf(value) === index);
}

function isComplexTask(text) {
  const value = String(text || '');
  return value.length > 700 || COMPLEX_TASK.test(value);
}

function needsStrongAgentModel(text) {
  return isComplexTask(text) || TOOL_TASK.test(String(text || ''));
}

function modelConfig(env = (name, fallback) => process.env[name] || fallback) {
  const read = (name, fallback) => String(env(name, fallback) || '').trim() || fallback;
  const fast = read('AGENT_FAST_MODEL', 'gpt-6-astra');
  const strong = read('AGENT_STRONG_MODEL', read('DEEP_THINK_COMPLEX_MODEL', 'gpt-6-sol'));
  const fallbacks = read('AGENT_STRONG_FALLBACK_MODELS', 'gpt-6-astra,gpt-5.6-sol,gpt-5-mini').split(',');
  return { fast, strong, strongChain: unique([strong, ...fallbacks, fast]) };
}

function selectAgentModel(text, env) {
  const config = modelConfig(env);
  return needsStrongAgentModel(text) ? config.strong : config.fast;
}

module.exports = { isComplexTask, needsStrongAgentModel, modelConfig, selectAgentModel };