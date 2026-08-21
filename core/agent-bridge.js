'use strict';

const fs = require('fs');
const https = require('https');
const { spawn, execSync } = require('child_process');
const { ProviderPool } = require('./skill-platform');
const { er } = require('./log');

// Telegram/TTS/agent-provider bridge — jarvis_daemon.js va telegram-bot.js
// bir xil "asosiy agent" (openclaw CLI, deep-think fallback bilan) va bir
// xil Telegram/TTS chiqishiga murojaat qiladi; bu shu mantiqning yagona
// nusxasi (daemon-tomon uchun — dependency'lar options orqali uzatiladi,
// module-level closure emas, shunda alohida test/qayta ishlatish mumkin).
function createAgentBridge({ chatId, token, projectDir, env, azureOpenAiKey, skillPlatform, runtime } = {}) {
  function sendTelegram(text) {
    return new Promise((resolve) => {
      if (!chatId) { resolve(false); return; }
      const payload = JSON.stringify({ chat_id: chatId, text: String(text).substring(0, 4096) });
      const req = https.request({ hostname: 'api.telegram.org', path: '/bot' + token + '/sendMessage', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(true)); });
      req.on('error', () => resolve(false)); req.setTimeout(15000, () => { req.destroy(); resolve(false); });
      req.write(payload); req.end();
    });
  }

  function sendTelegramVoice(oggPath) {
    return new Promise((resolve) => {
      if (!chatId || !fs.existsSync(oggPath)) { resolve(false); return; }
      try { execSync('curl -s -X POST "https://api.telegram.org/bot' + token + '/sendVoice" -F "chat_id=' + chatId + '" -F "voice=@' + oggPath + '" > /dev/null 2>&1'); resolve(true); }
      catch (e) { resolve(false); }
    });
  }

  async function ttsToFile(text) {
    const cleanText = String(text || '').trim();
    // Agent ba'zan bo'sh JSON konteyner qaytaradi. Azure bunday matn uchun
    // yaroqsiz/juda kichik MP3 berishi mumkin va afplay "AudioFileOpen failed"
    // deb stderr'ni to'ldiradi.
    if (!cleanText || /^(?:\[\s*\]|\{\s*\}|null|undefined)$/i.test(cleanText)) return null;
    return new Promise((resolve) => {
      const tmpIn = '/tmp/tts_' + Date.now() + '.json';
      fs.writeFileSync(tmpIn, JSON.stringify({ text: cleanText }), 'utf8');
      const proc = spawn('node', ['skills/azure-tts/index.js'], {
        cwd: projectDir, env: { ...process.env, AZURE_SPEECH_KEY: env('AZURE_SPEECH_KEY'), AZURE_SPEECH_REGION: env('AZURE_SPEECH_REGION'), AZURE_SPEECH_VOICE: env('AZURE_SPEECH_VOICE') || 'uz-UZ-SardorNeural' }
      });
      let out = '';
      proc.stdout.on('data', d => out += d); proc.stderr.on('data', () => {});
      proc.on('close', (code) => {
        try { fs.unlinkSync(tmpIn); } catch(e){}
        try {
          const audioFile = JSON.parse(out.trim()).audioFile;
          if (code === 0 && audioFile && fs.statSync(audioFile).size > 512) resolve(audioFile);
          else resolve(null);
        } catch(e) { resolve(null); }
      });
      fs.createReadStream(tmpIn).pipe(proc.stdin);
    });
  }

  function askOpenClaw(message, sessionKey) {
    return new Promise((resolve, reject) => {
      const proc = spawn('openclaw', ['agent', '--message', message, '--agent', 'main'], { cwd: projectDir, env: { ...process.env, AZURE_OPENAI_KEY: azureOpenAiKey }, timeout: 15000 });
      let out = '';
      let procErr = '';
      proc.stdout.on('data', d => out += d); proc.stderr.on('data', d => procErr += d);
      proc.on('error', reject);
      proc.on('close', (code) => {
        const clean = out.split('\n').filter(l => !l.includes('Waiting') && !l.includes('◒') && l.trim()).join('\n').trim();
        const emptyPayload = /^(?:\[\s*\]|\{\s*\}|null|undefined)$/i.test(clean);
        if (code !== 0 || !clean || emptyPayload || clean.includes("couldn't generate") || clean.includes('tool policy removed')) {
          reject(new Error((procErr || clean || `openclaw exit ${code}`).slice(0, 300)));
          return;
        }
        resolve(clean);
      });
    });
  }

  const agentProviders = new ProviderPool([
    { id: 'openclaw', priority: 0, timeoutMs: 18000, invoke: (message, context) => askOpenClaw(message, context.sessionKey) },
    {
      id: 'azure-deep-think', priority: 1, timeoutMs: 45000,
      invoke: (message, context) => skillPlatform.invoke('deep-think', 'askExpert', {
        question: message,
        context: context.sessionKey ? `Session: ${context.sessionKey}` : undefined
      })
    }
  ], { failureThreshold: 2, cooldownMs: 120000 });

  async function askAgent(message, sessionKey) {
    try {
      const response = await agentProviders.invoke(message, { sessionKey });
      return response.value;
    } catch (error) {
      runtime.recordError?.('agent.providers', error);
      er('Barcha agent providerlari ishlamadi: ' + error.message);
      return null;
    }
  }

  return { sendTelegram, sendTelegramVoice, ttsToFile, askOpenClaw, agentProviders, askAgent };
}

module.exports = { createAgentBridge };
