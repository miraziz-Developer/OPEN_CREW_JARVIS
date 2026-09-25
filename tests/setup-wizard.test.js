'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateAzureOpenAI, validateSpeech, validateTelegram, runWizard, parse, baseUrl } = require('../scripts/setup-env');

const respond = status => async () => ({ status, body: '{}' });

test('Azure OpenAI validation classifies auth, missing deployment and network problems', async () => {
  const args = { endpoint: 'https://x.services.ai.azure.com/', key: 'k', deployment: 'gpt-5-mini' };
  assert.equal((await validateAzureOpenAI(args, respond(200))).ok, true);
  assert.equal((await validateAzureOpenAI(args, respond(401))).ok, false);
  const missing = await validateAzureOpenAI(args, respond(404));
  assert.equal(missing.ok, false); assert.match(missing.message, /deployment/);
  assert.equal((await validateAzureOpenAI(args, async () => ({ status: 0, error: 'ENOTFOUND' }))).ok, null);
  assert.equal((await validateAzureOpenAI({ ...args, endpoint: 'not-a-url' }, respond(200))).ok, false);
  assert.equal(baseUrl('https://x.services.ai.azure.com/openai/v1/'), 'https://x.services.ai.azure.com');
});

test('Speech and Telegram validation', async () => {
  assert.equal((await validateSpeech({ key: 'k', region: 'swedencentral' }, respond(200))).ok, true);
  assert.equal((await validateSpeech({ key: 'k', region: 'swedencentral' }, respond(401))).ok, false);
  const ok = await validateTelegram('123:abc', async () => ({ status: 200, body: JSON.stringify({ ok: true, result: { username: 'my_bot' } }) }));
  assert.deepEqual([ok.ok, ok.username], [true, 'my_bot']);
  assert.equal((await validateTelegram('bad', async () => ({ status: 401, body: '{"ok":false}' }))).ok, false);
});

function scripted(answers) {
  const queue = [...answers];
  return { ask: async () => (queue.length ? queue.shift() : ''), log: () => {} };
}

test('wizard writes keys, copies voice defaults, generates a gateway token, sets a safe confirm mode, 0600', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-'));
  const envPath = path.join(dir, '.env');
  const io = scripted(['https://r.services.ai.azure.com', 'OPENAI-KEY', '',   // llm (Enter = default deployment)
                       '', '', '',                                            // voice: Enter, Enter, Enter
                       'SPEECH-KEY', 'swedencentral',                          // speech
                       '', '',                                                 // telegram skipped
                       '']);                                                   // confirm mode: Enter = payments
  const result = await runWizard({ envPath, interactive: true, request: respond(200), io });
  assert.equal(result.ok, true);
  const env = parse(fs.readFileSync(envPath, 'utf8'));
  assert.equal(env.get('AZURE_OPENAI_KEY'), 'OPENAI-KEY');
  assert.equal(env.get('AZURE_OPENAI_DEPLOYMENT'), 'gpt-5-mini');
  assert.equal(env.get('AZURE_VOICELIVE_ENDPOINT'), 'https://r.services.ai.azure.com');
  assert.equal(env.get('AZURE_VOICELIVE_KEY'), 'OPENAI-KEY');
  assert.equal(env.get('AZURE_VOICELIVE_API_KEY'), 'OPENAI-KEY');
  assert.equal(env.get('AZURE_VOICELIVE_MODEL'), 'gpt-realtime');
  assert.equal(env.get('JARVIS_CONFIRM_MODE'), 'payments');
  // Har bir javob o'z maydoniga tushganini tekshiramiz (avval javoblar siljib, Telegram tokeniga region yozilib qolgan edi).
  assert.equal(env.get('AZURE_SPEECH_KEY'), 'SPEECH-KEY');
  assert.equal(env.get('AZURE_SPEECH_REGION'), 'swedencentral');
  assert.equal(env.get('TELEGRAM_BOT_TOKEN') || '', '');
  assert.equal(env.get('TELEGRAM_OWNER_IDS') || '', '');
  assert.match(env.get('OPENCLAW_GATEWAY_TOKEN'), /^[0-9a-f]{48}$/);
  assert.equal((fs.statSync(envPath).mode & 0o777).toString(8), '600');
});

test('wizard does not re-ask values that are already set, and non-interactive mode only reports what is missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-'));
  const envPath = path.join(dir, '.env');
  const r1 = await runWizard({ envPath, interactive: false, io: { ask: async () => '', log: () => {} } });
  assert.equal(r1.ok, false);
  assert.ok(r1.missing.includes('AZURE_OPENAI_KEY') && r1.missing.includes('AZURE_SPEECH_KEY'));
  fs.appendFileSync(envPath, '\nAZURE_OPENAI_ENDPOINT=https://e\nAZURE_OPENAI_KEY=k\nAZURE_SPEECH_KEY=s\nAZURE_SPEECH_REGION=r\n');
  let asked = 0;
  const r2 = await runWizard({ envPath, interactive: false, io: { ask: async () => { asked++; return ''; }, log: () => {} } });
  assert.equal(r2.ok, true); assert.equal(asked, 0);
});

test('Azure validation calls the same endpoint the missions use (/openai/v1/responses with api-key)', async () => {
  let seen;
  await validateAzureOpenAI({ endpoint: 'https://x.services.ai.azure.com/api/projects/p', key: 'K', deployment: 'd' }, async req => { seen = req; return { status: 200 }; });
  assert.equal(seen.url, 'https://x.services.ai.azure.com/openai/v1/responses');
  assert.equal(seen.headers['api-key'], 'K');
});

test('a rejected key can be re-entered in place, and deployment/region defaults are shown and editable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-'));
  const envPath = path.join(dir, '.env');
  const prompts = [];
  const queue = ['https://r.services.ai.azure.com', 'BAD-KEY', 'my-deploy',     // llm, 1-urinish (kalit noto'g'ri)
                 'y', '', 'GOOD-KEY', '',                                        // qayta: endpoint saqlanadi, yangi kalit, deployment saqlanadi
                 '', '', '',                                                     // voice
                 'S', 'westeurope',                                              // speech
                 '', '',                                                         // telegram
                 '3'];                                                           // strict
  const io = { ask: async (_rl, q) => { prompts.push(q); return queue.length ? queue.shift() : ''; }, log: () => {} };
  const request = async req => ({ status: req.url.includes('/openai/v1/responses') ? (req.headers['api-key'] === 'GOOD-KEY' ? 200 : 401) : 200, body: '{}' });
  const r = await runWizard({ envPath, interactive: true, request, io });
  assert.equal(r.ok, true);
  const env = parse(fs.readFileSync(envPath, 'utf8'));
  assert.equal(env.get('AZURE_OPENAI_KEY'), 'GOOD-KEY');
  assert.equal(env.get('AZURE_OPENAI_DEPLOYMENT'), 'my-deploy');
  assert.equal(env.get('AZURE_SPEECH_REGION'), 'westeurope');
  assert.equal(env.get('JARVIS_CONFIRM_MODE'), 'strict');
  assert.ok(prompts.some(p => /Model deployment nomi \[gpt-5-mini\]/.test(p)), 'deployment default shown');
  assert.ok(prompts.some(p => /Speech region/.test(p)), 'region asked');
  assert.ok(prompts.some(p => /Qayta kiritasizmi/.test(p)), 'retry offered');
  assert.ok(prompts.some(p => /API key \[Enter = saqlangan\]/.test(p)), 'saved secret offered as default on retry');
});
