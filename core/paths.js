'use strict';

const path = require('path');

// OpenClaw runs skills from a private workspace copy, but runtime state, .env and logs
// must stay in the single authoritative project folder; the daemon passes that path to
// the agent's child. A plain local call keeps the previous __dirname behaviour.
const PROJECT_DIR = process.env.JARVIS_PROJECT_DIR
  ? path.resolve(process.env.JARVIS_PROJECT_DIR)
  : path.resolve(__dirname, '..');

module.exports = { PROJECT_DIR };