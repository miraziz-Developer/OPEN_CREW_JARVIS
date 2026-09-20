#!/usr/bin/env node
"use strict";
const fs = require('fs');
const { buildVoiceProviders } = require('../core/voice-provider');
const WebSocket = require('ws');

function parseEnv(text){
  const r = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'")) v = v.slice(1, -1);
    r[m[1]] = v;
  }
  return r;
}

const envObj = parseEnv(fs.readFileSync('.env', 'utf8'));
const env = (k, def) => (envObj[k] !== undefined ? envObj[k] : process.env[k] || def);

const providers = buildVoiceProviders(env);
console.log('VOICE_PROVIDERS:', JSON.stringify(providers, null, 2));
const vl = providers.find(p => p.id === 'voice-live');
if (!vl) {
  console.error('No voice-live provider configured in .env');
  process.exit(2);
}

const url = vl.url;
const headers = vl.headers || {};
console.log('Testing WebSocket connect to:', url);

const ws = new WebSocket(url, { headers, handshakeTimeout: 7000 });
let settled = false;
const abortTimer = setTimeout(() => {
  if (settled) return;
  settled = true;
  console.error('Connection timeout (7s) — no open/error received');
  ws.terminate();
  process.exit(3);
}, 8000);

ws.on('open', () => {
  if (settled) return; settled = true; clearTimeout(abortTimer);
  console.log('WebSocket open');
  try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
  ws.close();
  process.exit(0);
});

ws.on('error', (err) => {
  if (settled) return; settled = true; clearTimeout(abortTimer);
  console.error('WebSocket error:', err && err.message ? err.message : err);
  process.exit(4);
});

ws.on('close', (code, reason) => {
  if (settled) return; settled = true; clearTimeout(abortTimer);
  console.log('WebSocket closed', code, reason && reason.toString ? reason.toString() : reason);
  process.exit(0);
});
