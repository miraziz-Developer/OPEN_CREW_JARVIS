'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function jsonRequest({ port, method = 'POST', path: urlPath, body, timeoutMs = 600000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, res => {
      let data = ''; res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = null; try { parsed = data ? JSON.parse(data) : null; } catch (_) {}
        if (res.statusCode >= 400) return reject(new Error((parsed && (parsed.error?.message || parsed.error)) || `HTTP ${res.statusCode}`));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

const stripDataUrl = s => String(s).replace(/^data:[^,]+,/, '');

// ── Ollama (Qwen, Gemma) ─────────────────────────────────────────────
function createOllamaBackend({ port = 11434, request = jsonRequest } = {}) {
  return {
    port,
    async loaded() { const r = await request({ port, method: 'GET', path: '/api/ps', timeoutMs: 5000 }).catch(() => null); return (r?.models || []).map(m => m.name || m.model); },
    // Xotiradagi barcha Ollama modellarini darhol chiqaradi.
    async evict() { for (const model of await this.loaded()) await request({ port, path: '/api/generate', body: { model, keep_alive: 0 }, timeoutMs: 30000 }).catch(() => {}); },
    async chat({ model, system, user, images = [], audio = [], maxTokens = 1024, format, think = false, timeoutMs }) {
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      const msg = { role: 'user', content: String(user || '') };
      if (images.length) msg.images = images.map(stripDataUrl);
      if (audio.length) msg.audio = audio.map(stripDataUrl);
      messages.push(msg);
      const body = { model, messages, stream: false, think, options: { num_predict: maxTokens } };
      if (format) body.format = format;
      const r = await request({ port, path: '/api/chat', body, timeoutMs });
      return { text: String(r?.message?.content || '').trim(), usage: { prompt: r?.prompt_eval_count || 0, completion: r?.eval_count || 0 } };
    }
  };
}

// ── Bonsai 27B — alohida jarayon; to'xtatilsa RAM to'liq bo'shaydi ─────────────────
// Standart: 1-bit Bonsai 27B (til modeli 3.8 GB + rasm uchun 0.63 GB) — PrismML llama.cpp fork'idagi llama-server.
// Ixtiyoriy: BONSAI_RUNTIME=mlx — Ternary Bonsai 2 27B (8.6 GB, aqlliroq, lekin 16 GB Mac'da ko'pincha sig'maydi).
function bonsaiCommand({ projectDir, port, runtime = process.env.BONSAI_RUNTIME || 'llamacpp' }) {
  const llm = path.join(projectDir, 'models', 'llm');
  if (runtime === 'mlx') {
    const py = path.join(projectDir, '.venv-bonsai', 'bin', 'python');
    const dir = path.join(llm, 'bonsai2-27b-mlx');
    return { bin: py, args: [path.join(projectDir, 'scripts', 'bonsai-server.py'), '--model', dir, '--port', String(port)], required: [py, path.join(dir, 'config.json')] };
  }
  const bin = process.env.BONSAI_LLAMA_SERVER || path.join(llm, 'llama.cpp-prism', 'build', 'bin', 'llama-server');
  const model = path.join(llm, 'bonsai-27b-gguf', 'Bonsai-27B-Q1_0.gguf');
  const mmproj = path.join(llm, 'bonsai-27b-gguf', 'Bonsai-27B-mmproj-Q8_0.gguf');
  const args = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-ngl', '99', '--jinja',
    '-c', process.env.BONSAI_CTX || '16384', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '-fa', 'on', '--no-webui'];
  if (fs.existsSync(mmproj)) args.push('--mmproj', mmproj);
  return { bin, args, required: [bin, model] };
}

function createBonsaiBackend({ projectDir, port = 11436, startTimeoutMs = 240000, request = jsonRequest, spawnFn = spawn, log = () => {}, command } = {}) {
  const cmd = () => command || bonsaiCommand({ projectDir, port });
  let proc = null, starting = null;
  const healthy = () => request({ port, method: 'GET', path: '/health', timeoutMs: 2000 }).then(() => true, () => false);
  const backend = {
    port,
    installed() { return cmd().required.every(f => fs.existsSync(f)); },
    running() { return Boolean(proc); },
    async start() {
      if (proc && await healthy()) return;
      if (starting) return starting;
      if (!backend.installed()) throw new Error('Bonsai o\'rnatilmagan: ' + cmd().required.filter(f => !fs.existsSync(f)).join(', '));
      starting = (async () => {
        const { bin, args } = cmd();
        fs.mkdirSync(path.join(projectDir, 'logs'), { recursive: true });
        const out = fs.openSync(path.join(projectDir, 'logs', 'bonsai.log'), 'a');
        proc = spawnFn(bin, args, { cwd: projectDir, stdio: ['ignore', out, out] });
        proc.on('exit', code => { log(`bonsai exited (${code})`); proc = null; });
        const end = Date.now() + startTimeoutMs;
        while (Date.now() < end) {
          if (!proc) throw new Error('Bonsai jarayoni ishga tushmadi (logs/bonsai.log)');
          if (await healthy()) return;
          await new Promise(r => setTimeout(r, 1000));
        }
        await backend.evict();
        throw new Error('Bonsai yuklanishi juda uzoq cho\'zildi');
      })();
      try { await starting; } finally { starting = null; }
    },
    async evict() {
      if (!proc) return;
      const p = proc;
      await new Promise(resolve => { const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} resolve(); }, 8000); p.once('exit', () => { clearTimeout(t); resolve(); }); try { p.kill('SIGTERM'); } catch (_) { clearTimeout(t); resolve(); } });
      proc = null;
    },
    async chat({ system, user, images = [], maxTokens = 1024, think = false, timeoutMs }) {
      await backend.start();
      const content = images.length
        ? [{ type: 'text', text: String(user || '') }, ...images.map(img => ({ type: 'image_url', image_url: { url: String(img).startsWith('data:') ? img : 'data:image/png;base64,' + img } }))]
        : String(user || '');
      const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }];
      const body = { messages, max_tokens: maxTokens, thinking: think, chat_template_kwargs: { enable_thinking: Boolean(think) } };
      const r = await request({ port, path: '/v1/chat/completions', body, timeoutMs });
      return { text: String(r?.choices?.[0]?.message?.content || '').trim(), usage: { prompt: r?.usage?.prompt_tokens || 0, completion: r?.usage?.completion_tokens || 0 } };
    }
  };
  return backend;
}

module.exports = { createOllamaBackend, createBonsaiBackend, bonsaiCommand, jsonRequest };
