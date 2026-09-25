#!/usr/bin/env node
'use strict';

const { performance } = require('node:perf_hooks');
const { selectAgentModel, modelConfig } = require('../core/model-routing');

const CASES = Object.freeze([
  { id: 'simple-fact', prompt: 'What is the capital of France?', expectedTier: 'fast', minChars: 5 },
  { id: 'tool-task', prompt: 'Open the project files, fix the failing test, and run the test suite.', expectedTier: 'strong', minChars: 20 },
  { id: 'architecture', prompt: 'Design a secure multi-step migration architecture with rollback tradeoffs.', expectedTier: 'strong', minChars: 40 }
]);

function routeCases(cases = CASES, env) {
  const config = modelConfig(env);
  return cases.map(item => {
    const selectedModel = selectAgentModel(item.prompt, env);
    const expectedModel = item.expectedTier === 'strong' ? config.strong : config.fast;
    return { ...item, selectedModel, expectedModel, routeOk: selectedModel === expectedModel };
  });
}

async function runLive(rows, complete = require('../core/llm').complete) {
  const results = [];
  for (const row of rows) {
    const started = performance.now();
    try {
      const output = await complete({
        model: row.selectedModel,
        system: 'Answer accurately and concisely. Do not use tools.',
        user: row.prompt,
        maxOutputTokens: 500,
        timeoutMs: 90000,
        retries: 0
      });
      results.push({
        ...row, latencyMs: Math.round(performance.now() - started),
        qualityOk: String(output).trim().length >= row.minChars,
        outputChars: String(output).trim().length
      });
    } catch (error) {
      results.push({ ...row, latencyMs: Math.round(performance.now() - started), qualityOk: false, error: String(error.message || error).slice(0, 200) });
    }
  }
  return results;
}

async function main() {
  const live = process.argv.includes('--live');
  const routed = routeCases();
  const results = live ? await runLive(routed) : routed;
  const ok = results.every(row => row.routeOk && (!live || row.qualityOk));
  console.log(JSON.stringify({ mode: live ? 'live' : 'routing-only', ok, results }, null, 2));
  if (!ok) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.message || error); process.exitCode = 1; });

module.exports = { CASES, routeCases, runLive };