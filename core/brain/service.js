'use strict';

const http = require('http');
const { BrainArbiter, MemoryPressureError } = require('./arbiter');
const { routeTask, MODELS } = require('./router');

const HEAVY_OLLAMA = new Set(['/api/chat', '/api/generate', '/api/embed', '/api/embeddings']);

/**
 * JARVIS Brain: barcha lokal model chaqiruvlari shu yerdan o'tadi (RAM'da bir vaqtda bitta model).
 *   POST /brain/think   { system, user, images[], audio[], hard, maxTokens, format, think }
 *   GET  /brain/status
 *   /api/*              → Ollama (OpenClaw agenti uchun shaffof o'tkazgich, hakam orqali)
 */
function createBrainService({ ollama, bonsai, availableBytes, bonsaiNeedBytes = 9 * 2 ** 30, bonsaiIdleMs = 180000, log = () => {}, now = Date.now } = {}) {
  const arbiter = new BrainArbiter({ backends: { ollama, bonsai }, availableBytes, requirements: { bonsai: bonsaiNeedBytes }, log });
  let lastBonsaiUse = 0;
  const stats = { think: 0, fallbacks: 0, byModel: {} };

  async function run(target, req) {
    const release = await arbiter.acquire(target.backend);
    try {
      const started = now();
      const backend = target.backend === 'bonsai' ? bonsai : ollama;
      const out = await backend.chat({ ...req, model: target.model });
      if (target.backend === 'bonsai') lastBonsaiUse = now();
      stats.byModel[target.model] = (stats.byModel[target.model] || 0) + 1;
      return { ...out, model: target.model, backend: target.backend, ms: now() - started };
    } finally { release(); }
  }

  async function think(req = {}) {
    stats.think += 1;
    const target = routeTask({ text: `${req.system || ''}\n${req.user || ''}`, images: req.images, audio: req.audio, hard: req.hard });
    try {
      return { ...(await run(target, req)), reason: target.reason };
    } catch (error) {
      if (!target.fallback) throw error;
      stats.fallbacks += 1;
      log(`fallback ${target.model} → ${target.fallback.model}: ${error.message}`);
      const why = error instanceof MemoryPressureError ? 'memory' : 'error';
      return { ...(await run(target.fallback, req)), reason: target.reason, fallback: why };
    }
  }

  async function status() {
    return {
      arbiter: arbiter.status(), ollamaLoaded: await ollama.loaded().catch(() => []), bonsaiRunning: bonsai.running(),
      bonsaiInstalled: bonsai.installed?.() ?? false, freeGB: Number(((await availableBytes()) / 2 ** 30).toFixed(1)), models: MODELS, stats
    };
  }

  // Bo'sh turgan Bonsai'ni to'xtatamiz — RAM darhol qaytadi.
  async function idleSweep() {
    const s = arbiter.status();
    if (bonsai.running() && s.resident === 'bonsai' && s.inFlight === 0 && now() - lastBonsaiUse > bonsaiIdleMs) {
      log('bonsai idle — stopping');
      await bonsai.evict();
      arbiter.markEvicted('bonsai');
    }
  }

  function proxyToOllama(req, res) {
    const heavy = req.method === 'POST' && HEAVY_OLLAMA.has(req.url.split('?')[0]);
    const forward = release => {
      const upstream = http.request({ host: '127.0.0.1', port: ollama.port, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${ollama.port}` } }, up => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
        up.on('end', release); up.on('error', release);
      });
      upstream.on('error', err => { release(); if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); });
      res.on('close', release);
      req.pipe(upstream);
    };
    if (!heavy) return forward(() => {});
    arbiter.acquire('ollama').then(release => forward(release), err => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); });
  }

  function handler(req, res) {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/api/')) return proxyToOllama(req, res);
    if (req.method === 'GET' && req.url === '/brain/status') return status().then(s => send(200, s), e => send(500, { error: e.message }));
    if (req.method === 'POST' && req.url === '/brain/think') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 64 * 2 ** 20) req.destroy(); });
      req.on('end', () => {
        let payload; try { payload = JSON.parse(body || '{}'); } catch (_) { return send(400, { error: 'bad json' }); }
        think(payload).then(r => send(200, r), e => send(500, { error: e.message }));
      });
      return;
    }
    send(404, { error: 'not found' });
  }

  return { arbiter, think, status, idleSweep, handler, server: () => http.createServer(handler) };
}

module.exports = { createBrainService };
