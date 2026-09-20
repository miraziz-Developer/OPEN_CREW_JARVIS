'use strict';

const fs = require('fs');
const path = require('path');
const { parseEnv } = require('./config');

const OPENCLAW_ENV_KEYS = Object.freeze([
  'OPENCLAW_GATEWAY_TOKEN',
  'AZURE_OPENAI_KEY',
  'OPENCLAW_CONFIG_PATH',
  'JARVIS_PROJECT_DIR'
]);

function readProjectEnv(projectDir) {
  try {
    return parseEnv(fs.readFileSync(path.join(projectDir, '.env'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function requiredValue(name, value) {
  if (String(value || '').trim()) return value;
  throw new Error(`OpenClaw credential configuration error: ${name} topilmadi (.env yoki process environment orqali bering)`);
}

function resolveOpenClawEnvironment({ projectDir, env = process.env } = {}) {
  const resolvedProjectDir = path.resolve(projectDir || env.JARVIS_PROJECT_DIR || path.resolve(__dirname, '..'));
  const fileEnv = readProjectEnv(resolvedProjectDir);
  const source = { ...fileEnv, ...env };
  const openClawEnvironment = {
    ...env,
    OPENCLAW_GATEWAY_TOKEN: requiredValue('OPENCLAW_GATEWAY_TOKEN', source.OPENCLAW_GATEWAY_TOKEN),
    JARVIS_PROJECT_DIR: source.JARVIS_PROJECT_DIR || resolvedProjectDir,
    OPENCLAW_CONFIG_PATH: source.OPENCLAW_CONFIG_PATH || path.join(resolvedProjectDir, 'openclaw.json')
  };

  if (source.AZURE_OPENAI_KEY) openClawEnvironment.AZURE_OPENAI_KEY = source.AZURE_OPENAI_KEY;
  return openClawEnvironment;
}

module.exports = { OPENCLAW_ENV_KEYS, resolveOpenClawEnvironment };