#!/usr/bin/env node
const path = require('node:path');
const ProjectRoot = path.resolve(__dirname, '..');
const { VoiceLiveWake } = require(path.join(ProjectRoot, 'core', 'voicelive-wake'));

function now() { return new Date().toISOString(); }

const vl = new VoiceLiveWake({
  provider: { id: 'voice-live', voice: 'default' },
  inputRate: parseInt(process.env.MIC_CAPTURE_RATE || '16000', 10),
  prefixPaddingMs: 200,
  silenceMs: 350
});

vl.on('ready', () => console.log(now(), 'READY'));
vl.on('error', (e) => console.error(now(), 'ERROR', e && e.message ? e.message : String(e)));
vl.on('transcript', (t) => console.log(now(), 'TRANSCRIPT', t));
vl.on('connect', () => console.log(now(), 'WS CONNECT'));
vl.on('disconnect', () => console.log(now(), 'WS DISCONNECT'));

console.log(now(), 'Starting diag-voicelive-wake; will run 12s. Feed raw 16-bit PCM from stdin (mono).');
vl.start();

setTimeout(() => {
  console.log(now(), 'Stopping');
  process.exit(0);
}, 12 * 1000);
