'use strict';
// Lightweight .env reader (avoids a circular dependency between llm.js and grok.js).
const fs = require('fs');
const path = require('path');
const { PROJECT_DIR } = require('./paths');

let cached = null;
function env(key, fallback) {
  if (process.env[key] !== undefined) return process.env[key];
  if (cached === null) { try { cached = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (_) { cached = ''; } }
  const match = cached.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return match ? match[1].trim() : fallback;
}
module.exports = { env };
