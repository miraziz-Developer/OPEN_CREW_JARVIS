#!/usr/bin/env node
'use strict';

// JARVIS Brain xizmati (launchd: com.jarvis.brain). Port: BRAIN_PORT (standart 11435).
const path = require('path');
const { PROJECT_DIR } = require('../paths');
const { createBrainService } = require('./service');
const { createOllamaBackend, createBonsaiBackend } = require('./backends');
const { availableBytes } = require('./memory');

const log = m => console.log(`[${new Date().toISOString()}] [brain] ${m}`);
const bonsai = createBonsaiBackend({ projectDir: PROJECT_DIR, port: Number(process.env.BONSAI_PORT) || 11436, log });
const brain = createBrainService({
  ollama: createOllamaBackend({ port: Number(process.env.OLLAMA_PORT) || 11434 }),
  bonsai,
  availableBytes: () => availableBytes(),
  bonsaiNeedBytes: (Number(process.env.BONSAI_MIN_FREE_GB) || (process.env.BONSAI_RUNTIME === 'mlx' ? 9.5 : 7)) * 2 ** 30,
  bonsaiIdleMs: (Number(process.env.BONSAI_IDLE_MIN) || 3) * 60000,
  log
});
const port = Number(process.env.BRAIN_PORT) || 11435;
brain.server().listen(port, '127.0.0.1', () => log(`listening on 127.0.0.1:${port} (project ${path.basename(PROJECT_DIR)})`));
setInterval(() => brain.idleSweep().catch(e => log('idle sweep: ' + e.message)), 30000).unref();
// Xizmat to'xtasa Bonsai jarayoni ham to'xtaydi — aks holda u RAM'da qolib ketardi.
const shutdown = async () => { log('stopping'); try { await bonsai.evict(); } catch (_) {} process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
