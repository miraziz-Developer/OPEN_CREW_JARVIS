'use strict';

const http = require('http');

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const DEFAULT_MODEL = 'llama3.2:1b';

function isOllamaAvailable() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/tags',
      method: 'GET',
      timeout: 1000
    }, res => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function completeLocal({ prompt, system, model = DEFAULT_MODEL, maxTokens = 60, temperature = 0.3, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      prompt: String(prompt || '').trim(),
      system: String(system || '').trim(),
      stream: false,
      options: {
        temperature,
        num_predict: maxTokens
      }
    });

    const req = http.request({
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.response?.trim() || '');
        } catch (e) {
          reject(new Error(`Ollama JSON parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Ollama request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

module.exports = {
  isOllamaAvailable,
  completeLocal,
  DEFAULT_MODEL
};
