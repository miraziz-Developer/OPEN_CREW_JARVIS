#!/usr/bin/env node
/**
 * JARVIS Telegram Bot — v8 Final
 * OpenClaw + Azure Speech TTS/STT.
 * User-facing output is always natural English.
 */

const TelegramBotModule = require('node-telegram-bot-api');
const TelegramBot = TelegramBotModule.default || TelegramBotModule;
const { execSync, spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeMemory, searchMemory, readProfile } = require('./skills/memory');
const { createTelegramPoller } = require('./core/telegram-poller');
const { createKeyedTaskQueue } = require('./core/keyed-task-queue');
const { prepareVoiceMessage, transcodeVoiceReply } = require('./core/telegram-media');
const { analyzeVideoNote, validateVideoNote } = require('./core/video-note-analysis');
const { createAgentBridge } = require('./core/agent-bridge');
const { resolveOpenClawEnvironment } = require('./core/openclaw-credentials');
const { createSkillPlatform } = require('./skills/platform');
const { RuntimeTelemetry } = require('./core/runtime-telemetry');
const { isComplexTask } = require('./core/model-routing');

const { PROJECT_DIR } = require('./core/paths');
process.chdir(PROJECT_DIR);

const ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8');
function getEnv(key) {
  const m = ENV.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim() : '';
}

const TOKEN = getEnv('TELEGRAM_BOT_TOKEN');
if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN was not found'); process.exit(1); }

const AZURE_SPEECH_KEY = getEnv('AZURE_SPEECH_KEY');
const AZURE_SPEECH_REGION = getEnv('AZURE_SPEECH_REGION');
const AZURE_SPEECH_VOICE = getEnv('AZURE_SPEECH_VOICE') || 'en-US-GuyNeural';
const AZURE_OPENAI_KEY = getEnv('AZURE_OPENAI_KEY');
const AZURE_OPENAI_ENDPOINT = getEnv('AZURE_OPENAI_ENDPOINT');
const AZURE_OPENAI_VISION_DEPLOYMENT = getEnv('AZURE_OPENAI_VISION_DEPLOYMENT') || 'gpt-4.1';
const TELEGRAM_VIDEO_NOTE_MAX_BYTES = Number(getEnv('TELEGRAM_VIDEO_NOTE_MAX_BYTES')) || 20 * 1024 * 1024;
const TELEGRAM_VIDEO_NOTE_MAX_SECONDS = Number(getEnv('TELEGRAM_VIDEO_NOTE_MAX_SECONDS')) || 90;

const chatHistory = {};
const MAX_HISTORY = 10;
const CONTEXT_TTL_MS = 10 * 60 * 1000;
const processedVideoNotes = new Set();
const MAX_PROCESSED_VIDEO_NOTES = 1000;
const runtimeTelemetry = new RuntimeTelemetry({ file: path.join(PROJECT_DIR, '.run', 'telemetry.json') });
const messageQueue = createKeyedTaskQueue();
const updateTasks = new WeakMap();

console.log('Jarvis Telegram Bot ishga tushmoqda (v8)...');
// node-telegram-bot-api@1.2.0 ning fetch asosidagi getUpdates transporti shu
// hostda muntazam EFATAL bilan uziladi. Handler va media metodlarini libraryda
// qoldiramiz, incoming update'larni esa barqaror native HTTPS poller olib keladi.
const bot = new TelegramBot(TOKEN, { polling: false });
const { createOwnerUpdateHandler, createOwnerTaskCommands } = require('./core/telegram-owner');
const { createGmailTaskNotifier } = require('./core/gmail-task-notifier');
const { parseOwnerIds } = require('./core/telegram-owner');
let ownerIds = parseOwnerIds(getEnv('TELEGRAM_CHAT_ID'), getEnv('TELEGRAM_OWNER_IDS'));
let ownerId = ownerIds[0] || '';
const { createPairing } = require('./core/telegram-pairing');
const pairing = createPairing({ file: path.join(__dirname, '.run', 'telegram-pair-code.json'), envFile: path.join(__dirname, '.env') });
const buildOwnerHandler = ids => createOwnerUpdateHandler({
  ownerIds: ids.join(','),
  dispatch: update => {
    bot.processUpdate(update);
    return updateTasks.get(update?.message) || Promise.resolve();
  }
});
const isPaired = () => ownerIds.length > 0;
let ownerHandler = buildOwnerHandler(ownerIds);
if (!isPaired()) {
  const state = pairing.ensureCode();
  console.error('Telegram locked: no owner yet. Pair from your private Telegram chat with the bot: /pair ' + state.code +
    ' (code valid ~15 min, stored in .run/telegram-pair-code.json).');
}
const telegramPoller = createTelegramPoller({
  token: TOKEN,
  onUpdate: update => {
    if (!isPaired()) {
      const msg = update?.message;
      if (msg && msg.chat?.type === 'private' && !msg.from?.is_bot) {
        const result = pairing.attempt(msg);
        if (result.ok) {
          ownerIds = parseOwnerIds(result.ownerId);
          ownerId = ownerIds[0];
          ownerHandler = buildOwnerHandler(ownerIds);
          console.log('Telegram owner paired:', ownerId);
          bot.sendMessage(ownerId, '✅ Ulash muvaffaqiyatli bajarildi! Ushbu Telegram chat endi JARVIS bilan to\'liq bog\'landi. Barcha xizmatlar yangilanmoqda...').catch(() => {});
          setTimeout(() => {
            if (process.platform !== 'darwin') { process.exit(0); return; }
            try { require('child_process').spawn('bash', [path.join(__dirname, 'scripts', 'restart-daemon.sh')], { detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
            try { require('child_process').spawn('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.jarvis.mission-runner`], { detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
          }, 2500);
        } else if (result.reason === 'bad-code') {
          bot.sendMessage(msg.chat.id, '❌ Noto\'g\'ri kod kiritildi. Qaytadan tekshirib yuboring: /pair <KOD>').catch(() => {});
        } else if (result.reason === 'locked') {
          bot.sendMessage(msg.chat.id, '⏳ Ko\'p xato urinishlar tufayli ulanish vaqtincha bloklandi. Biroz kuting.').catch(() => {});
        } else {
          bot.sendMessage(msg.chat.id, '🔒 JARVIS ulanish kutmoqda.\n\nEgalikni tasdiqlash uchun terminaldagi 6 xonali kodni yuboring:\n/pair <KOD>').catch(() => {});
        }
      }
      return false;
    }
    const accepted = ownerHandler(update);
    return accepted ? (updateTasks.get(update?.message) || Promise.resolve()) : false;
  }
});

// ── Helpers ──────────────────────────────────────────────────

async function ttsToFile(text, timing = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const tmpIn = '/tmp/_tts_in_' + Date.now() + '.json';
    fs.writeFileSync(tmpIn, JSON.stringify({ text }), 'utf8');
    const proc = spawn('node', ['skills/azure-tts/index.js'], {
      cwd: PROJECT_DIR,
      env: { ...process.env, AZURE_SPEECH_KEY, AZURE_SPEECH_REGION, AZURE_SPEECH_VOICE }
    });
    let out = '';
    proc.stdout.on('data', d => (out += d.toString()));
    proc.stderr.on('data', d => console.error('TTS stderr:', d.toString().substring(0, 200)));
    proc.on('close', () => {
      try { fs.unlinkSync(tmpIn); } catch (e) {}
      let audioFile = null;
      try { audioFile = JSON.parse(out.trim()).audioFile || null; } catch (e) {}
      runtimeTelemetry.latency({ requestId: timing.requestId, source: timing.source || 'telegram', provider: 'azure-tts', tts_ms: Date.now() - startedAt, error: audioFile ? undefined : 'TTS did not produce an audio file' });
      resolve(audioFile);
    });
    fs.createReadStream(tmpIn).pipe(proc.stdin);
  });
}

async function sttFromFile(wavPath, timing = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const adjustedPath = wavPath.replace(/\/$/, '');
    if (!adjustedPath || adjustedPath === '-') return resolve({ status: 'error', text: '' });
    const tmpIn = '/tmp/_stt_in_' + Date.now() + '.json';
    fs.writeFileSync(tmpIn, JSON.stringify({ audioFile: adjustedPath }), 'utf8');
    const proc = spawn('node', ['skills/azure-stt/index.js'], {
      cwd: PROJECT_DIR,
      env: { ...process.env, AZURE_SPEECH_KEY, AZURE_SPEECH_REGION }
    });
    let out = '';
    proc.stdout.on('data', d => (out += d.toString()));
    proc.stderr.on('data', d => console.error('STT stderr:', d.toString().substring(0, 200)));
    proc.on('close', () => {
      try { fs.unlinkSync(tmpIn); } catch (e) {}
      let result;
      try { result = JSON.parse(out.trim()); } catch (e) { result = { status: 'error', text: '' }; }
      runtimeTelemetry.latency({ requestId: timing.requestId, source: timing.source || 'telegram-voice', provider: 'azure-stt', stt_ms: Date.now() - startedAt, error: result.status === 'ok' ? undefined : 'STT failed' });
      resolve(result);
    });
    fs.createReadStream(tmpIn).pipe(proc.stdin);
  });
}

const telegramAgentBridge = createAgentBridge({
  chatId: null, token: TOKEN, projectDir: PROJECT_DIR, env: getEnv,
  azureOpenAiKey: AZURE_OPENAI_KEY, openClawEnvironment: resolveOpenClawEnvironment({ projectDir: PROJECT_DIR }),
  skillPlatform: createSkillPlatform({ projectDir: PROJECT_DIR, env: getEnv }), runtime: {}, telemetry: runtimeTelemetry
});
const ownerTaskCommands = createOwnerTaskCommands({
  bridge: telegramAgentBridge, notifier: createGmailTaskNotifier({ env: getEnv }),
  send: (chatId, text) => bot.sendMessage(chatId, text)
});

function askAgent(message, chatId, routeText) {
  return telegramAgentBridge.askAgent(message, 'agent:main:telegram', {
    source: 'telegram', routeText,
    // Har bosqich uchun "⏳" xabari yuborilmaydi — faqat natija. Uzoq ish bo'lsa bir marta qisqa eslatma.
    onProgress: () => {},
    onLongRunning: (() => { let told = false; return () => { if (!told) { told = true; bot.sendMessage(chatId, '⏳ Still working on it.').catch(() => {}); } }; })()
  });
}

function findFiles(searchTerm, searchDir) {
  if (!searchTerm || searchTerm.length < 1) return [];
  const results = [];
  const dir = searchDir || os.homedir();
  // 1. find
  try {
    const cmd = 'find "' + dir + '" -maxdepth 5 -iname "*' + searchTerm + '*" -type f 2>/dev/null | head -n 10';
    const r = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    const f = r.trim().split('\n').filter(x => x);
    if (f.length > 0) return f;
  } catch (e) {}
  // 2. mdfind (Spotlight)
  try {
    const r = execSync('mdfind -name "' + searchTerm + '" 2>/dev/null | head -n 10', { encoding: 'utf8', timeout: 15000 });
    const f = r.trim().split('\n').filter(x => x);
    if (f.length > 0) return f;
  } catch (e) {}
  // 3. fs rekursiv
  try {
    function walk(d, depth) {
      if (depth > 3 || results.length >= 10) return;
      const items = fs.readdirSync(d, { withFileTypes: true });
      for (const item of items) {
        const fp = path.join(d, item.name);
        if (item.isDirectory()) walk(fp, depth + 1);
        else if (item.name.toLowerCase().includes(searchTerm.toLowerCase())) {
          results.push(fp);
          if (results.length >= 10) return;
        }
      }
    }
    walk(dir, 0);
  } catch (e) {}
  return results;
}

async function sendDocument(chatId, filePath, caption) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const sizeMB = fs.statSync(filePath).size / (1024 * 1024);
    if (sizeMB > 50) {
      await bot.sendMessage(chatId, 'The file is too large (' + sizeMB.toFixed(1) + ' MB). The limit is 50 MB.');
      return false;
    }
    await bot.sendDocument(chatId, filePath, { caption: caption || path.basename(filePath) });
    return true;
  } catch (e) {
    console.error('Send error:', e.message);
    return false;
  }
}

async function sendVoiceReply(chatId, text) {
  let audioPath;
  let ogg;
  try {
    const safe = text.substring(0, 400);
    audioPath = await ttsToFile(safe, { source: 'telegram-voice-reply' });
    if (!audioPath || !fs.existsSync(audioPath)) {
      console.error('Voice reply skipped: TTS did not produce an audio file for chat ' + chatId + '.');
      return;
    }
    ogg = await transcodeVoiceReply(audioPath);
    if (fs.existsSync(ogg)) {
      await bot.sendVoice(chatId, ogg);
    }
  } catch (e) {
    console.error('Voice error:', e.message);
  } finally {
    if (ogg) await fs.promises.rm(ogg, { force: true }).catch(() => {});
    if (audioPath) await fs.promises.rm(audioPath, { force: true }).catch(() => {});
  }
}

async function handleVideoNote(msg) {
  const chatId = msg.chat.id;
  const note = msg.video_note;
  const permitted = validateVideoNote(note, {
    maxFileBytes: TELEGRAM_VIDEO_NOTE_MAX_BYTES,
    maxDurationSeconds: TELEGRAM_VIDEO_NOTE_MAX_SECONDS
  });
  if (!permitted.ok) {
    const reason = permitted.reason === 'file-too-large'
      ? 'This video note is too large. Please send one smaller than ' + Math.floor(TELEGRAM_VIDEO_NOTE_MAX_BYTES / 1024 / 1024) + ' MB.'
      : 'This video note is too long. Please send one shorter than ' + TELEGRAM_VIDEO_NOTE_MAX_SECONDS + ' seconds.';
    await bot.sendMessage(chatId, reason);
    return;
  }

  await bot.sendChatAction(chatId, 'typing');
  await bot.sendMessage(chatId, '🎥 Video received. I am listening and analyzing it...');
  try {
    const fileUrl = await bot.getFileLink(note.file_id);
    const result = await analyzeVideoNote({
      note, fileUrl, caption: msg.caption || '',
      endpoint: AZURE_OPENAI_ENDPOINT, key: AZURE_OPENAI_KEY, deployment: AZURE_OPENAI_VISION_DEPLOYMENT,
      maxFileBytes: TELEGRAM_VIDEO_NOTE_MAX_BYTES, maxDurationSeconds: TELEGRAM_VIDEO_NOTE_MAX_SECONDS,
      transcribe: sttFromFile, log: console
    });
    const answer = result.answer.slice(0, 4096);
    await bot.sendMessage(chatId, answer);
    try {
      writeMemory('Telegram video tahlili',
        'Caption: ' + (msg.caption || '(yo\'q)') + '\nTranskript: ' + (result.transcript || '(aniq eshitilmadi)') + '\nJarvis: ' + answer,
        ['telegram', 'video', 'vision']);
    } catch (error) {}
    if (!chatHistory[chatId]) chatHistory[chatId] = [];
    const userText = [msg.caption, result.transcript].filter(Boolean).join('\n') || '[Video note]';
    chatHistory[chatId].push({ user: userText, agent: answer, time: Date.now() });
    if (chatHistory[chatId].length > MAX_HISTORY) chatHistory[chatId].shift();
  } catch (error) {
    console.error('Video-note processing error:', error.message || error);
    await bot.sendMessage(chatId, 'I could not analyze that video note. Please try a shorter, clearer video and send it again.');
  }
}

function enqueueVideoNote(msg) {
  const chatId = msg.chat.id;
  const updateKey = String(chatId) + ':' + String(msg.message_id || msg.video_note?.file_unique_id || msg.video_note?.file_id);
  if (processedVideoNotes.has(updateKey)) {
    console.log('[' + chatId + '] Duplicate video-note ignored: ' + updateKey);
    return Promise.resolve();
  }
  processedVideoNotes.add(updateKey);
  if (processedVideoNotes.size > MAX_PROCESSED_VIDEO_NOTES) {
    processedVideoNotes.delete(processedVideoNotes.values().next().value);
  }
  return handleVideoNote(msg);
}

const { isPlainScreenshotRequest } = require('./core/telegram-routing');

async function takeScreenshot(chatId, analyzePrompt = null) {
  const p = path.join('/tmp', 'jarvis_screenshot_' + Date.now() + '.jpg');
  try {
    execSync('screencapture -x -t jpg "' + p + '"', { timeout: 10000 });
    if (fs.existsSync(p)) {
      await bot.sendPhoto(chatId, p, { caption: '🖥 Mac ekrani holati' });
      if (analyzePrompt) {
        await bot.sendChatAction(chatId, 'typing');
        const gemini = require('./core/gemini');
        const analysis = await gemini.completeVision({ imagePath: p, prompt: analyzePrompt });
        await bot.sendMessage(chatId, `🔍 *Ekran tahlili:*\n\n${analysis}`, { parse_mode: 'Markdown' });
      }
      try { fs.unlinkSync(p); } catch (_) {}
      return 'Screenshot captured and sent.';
    }
  } catch (e) {
    return 'I could not capture the screenshot: ' + e.message;
  }
}

function extractSearchTerm(text) {
  // 1. Aniq nom qo'shtirnoqda
  const q = text.match(/"([^"]+)"/);
  if (q) return q[1].trim();
  // 2. Fayl nomi formatida
  const ext = text.match(/([\w\s\-_.]+)\.(pdf|doc|docx|txt|jpg|jpeg|png|mp4|zip|rar|xls|xlsx|pptx)/i);
  if (ext) return ext[1].trim();
  // 3. Stemming + stop words
  const words = text.toLowerCase()
    .replace(/[.,!?;/\-'"]/g, ' ')
    .split(/\s+/)
    .map(w => w.replace(/(larni|larini|lari|lar|ni|ga|dan|ning|si|da|gi|di)$/i, ''))
    .filter(w => w.length > 1 && !{
      va:1,men:1,sen:1,siz:1,meni:1,menga:1,sizga:1,uchun:1,bilan:1,yubor:1,
      junat:1,jonat:1,qil:1,qildi:1,qildim:1,bolding:1,boldi:1,boldim:1,qanday:1,
      qaysi:1,qayerda:1,bor:1,yoq:1,ha:1,ok:1,xa:1,oke:1,top:1,topib:1,qidir:1,
      find:1,im:1,in:1,at:1,of:1,to:1,for:1,on:1,qi:1,ga:1,dan:1,chi:1,lik:1,
      agi:1,ani:1,da:1,desktop:1,desktopda:1,files:1,file:1,fayl:1,fayllar:1,
      hujjat:1,hujjatlar:1,document:1,documents:1,computer:1,kompyuter:1,men:1
    }[w]);
  const result = words.slice(0, 3).join(' ');
  // 4. Hech narsa topilmasa, eng uzun so'zni qaytarish
  if (!result) {
    const longest = text.toLowerCase().replace(/[.,!?;\-'"]/g, ' ').split(/\s+/)
      .filter(w => w.length > 2 && !['va','men','sen','siz','uchun','bilan','desktop'].includes(w))
      .sort((a,b) => b.length - a.length)[0];
    return longest || '';
  }
  return result;
}

// Agent javobigacha fayl yo'llarini chiqarish
function extractFilePaths(text) {
  if (!text) return [];
  const paths = [];
  // To'liq yo'llar: /Users/.../
  const patternA = /\/Users\/[^\s]+[^\n*,;]+\.[a-zA-Z0-9]+/g;
  let m;
  while ((m = patternA.exec(text)) !== null) paths.push(m[0].trim());
  // Relative yo'llar: Desktop/...
  const patternB = /(?:Desktop|Downloads|Documents)[\/\\][^\s\n*,;]+\.[a-zA-Z0-9]+/gi;
  while ((m = patternB.exec(text)) !== null) {
    const full = os.homedir() + '/' + m[0];
    if (!paths.includes(full)) paths.push(full);
  }
  return paths.filter((v, i, a) => a.indexOf(v) === i).slice(0, 5);
}

// ── Universal handler ────────────────────────────────────────

async function handleMessage(chatId, userText, isVoice) {
  console.log('[' + chatId + '] ' + (isVoice ? 'VOICE→' : '') + 'TEXT: "' + userText.substring(0, 60) + '"');
  await bot.sendChatAction(chatId, 'typing');

  // 1. Faqat "skrinshot yubor" kabi sof so'rov — darhol. Boshqa amal bilan birga bo'lsa ("Claude'ni och, keyin
  //    skrinshot yubor") agentga boradi: avval u holda Claude ochilmasdan darhol skrinshot olinar edi.
  if (isPlainScreenshotRequest(userText)) {
    const r = await takeScreenshot(chatId);
    if (!/sent/i.test(r)) await bot.sendMessage(chatId, r);   // rasmning o'zi javob; muvaffaqiyatda qo'shimcha matn yo'q
    return;
  }

  // 2. Brauzer ochish
  if (/brauzer|browser|sayt/i.test(userText) && /(?:\.com|\.uz|\.org|\.net)/.test(userText)) {
    const url = userText.match(/(?:https?:\/\/)?(\S+\.(?:com|uz|org|net))/i);
    if (url) {
      try {
        execSync('open "https://' + url[1] + '"');
        await bot.sendMessage(chatId, url[1] + ' opened.');
      } catch (e) {
        await bot.sendMessage(chatId, 'I could not open that website.');
      }
      return;
    }
  }

  // 3a. XOTIRA: "eslab qol" buyruqi
  if (/eslab qol|esda tut|xotira|memory/i.test(userText) && userText.length > 20) {
    const clean = userText.replace(/eslab qol|esda tut|xotira|memory/gi, '').trim();
    const wr = writeMemory('Telegram eslatma', clean, ['telegram']);
    await bot.sendMessage(chatId, '✅ Remembered: ' + clean.substring(0, 100));
    return;
  }

  // 3b. PROFIL: profil so'rov
  if (/profilim|men haqimda|o'zim haqimda/i.test(userText)) {
    const pr = readProfile();
    if (pr.status === 'ok' && pr.content) {
      await bot.sendMessage(chatId, '📋 Your profile:\n\n' + pr.content.substring(0, 2000));
    } else {
      await bot.sendMessage(chatId, 'Your profile is empty. Say, “Jarvis, remember ...”');
    }
    return;
  }

  // 3c. MEMORY QIDIRUV: har qanday oddiy savoldan oldin
  let memoryContext = '';
  const searchQuery = userText.split(/\s+/).filter(w => w.length > 3 && !['qanday','nima','kim','qaerga','nega','nechun','uchun'].includes(w.toLowerCase())).slice(0, 3).join(' ');
  if (searchQuery.length > 2) {
    try {
      const found = searchMemory(searchQuery, 3);
      if (found.status === 'ok' && found.results.length > 0) {
        const lines = found.results.map(r => '【' + r.date + '】 ' + r.matches.map(m => m.text).join(' | ')).join('\n');
        memoryContext = '\n[Obsidian Xotira]:\n' + lines + '\n[Endi javob bering]:\n';
      }
    } catch (e) {}
  }

  // 3d. UNIVERSAL: AI agentga yuborish
  const isCodeOrComplex = isComplexTask(userText) || /\b(yoz|kod|dastur|skript|tushuntir|misol|qanday|loyiham|tuzat|tekshir|how|write|code|script|create|implement|fix|explain)\b/i.test(userText);
  const modeInstruction = isCodeOrComplex
    ? '[Mode: Full expert assistance. Provide clear, accurate, complete code and explanation in the same language as the user\'s request. Format cleanly with markdown.]'
    : '[Mode: Quick conversational assistance. Reply naturally in 1-3 clear sentences in the language of the request.]';
  let enrichedMessage = modeInstruction + '\n' + memoryContext + userText;
  
  // Agar avvalgi suhbat bosa — kontekst bilan
  const history = chatHistory[chatId];
  if (history && history.length > 0) {
    // Faqat kontekst uchun: eski javoblar qisqartiriladi (to'liq javoblar so'rovni o'nlab ming belgiga cho'zardi).
    const lastMsgs = history.slice(-3).map(h => 'F: ' + String(h.user).slice(0, 300) + '\nJ: ' + String(h.agent).slice(0, 300)).join('\n---\n');
    enrichedMessage = 'Oldingi suhbat:\n' + lastMsgs + '\n---\n' + enrichedMessage;
  }

  const reply = await askAgent(enrichedMessage, chatId, userText);

  if (!reply) {
    await bot.sendMessage(chatId, 'I cannot respond right now. Please try again shortly.');
    return;
  }

  // 3e. Har bir suhbatni xotiraga yozish — xatolardan o'rganish va
  // kunlik sintez uchun xom material sifatida (faqat "eslab qol" emas,
  // BARCHA suhbat).
  try { writeMemory('Telegram suhbat', 'Foydalanuvchi: ' + userText + '\nJarvis: ' + reply.substring(0, 500), ['telegram', 'suhbat']); } catch (e) {}

  // 4. Agent javobidan fayl yo'llarini chiqarish
  const filePaths = extractFilePaths(reply);
  const hasPaths = filePaths.length > 0;
  const realFiles = filePaths.filter(fp => fs.existsSync(fp));

  // 5. Matnli javob (fayl yo'llarini tozalab qisqa yuborish)
  let displayReply = reply;
  if (realFiles.length > 2) {
    displayReply = reply.split('\n').filter(l => !l.includes('/Users/') && !l.startsWith('Desktop/')).join('\n').trim();
  }
  if (displayReply.length > 4096) displayReply = displayReply.substring(0, 4093) + '...';
  if (displayReply) {
    const sent = await bot.sendMessage(chatId, displayReply);
    console.log('[' + chatId + '] Text reply sent: message_id=' + (sent?.message_id || 'unknown'));
  }

  // 6. Topilgan fayllarni yuborish
  if (realFiles.length > 0) {
    await bot.sendChatAction(chatId, 'upload_document');
    let sentCount = 0;
    for (const fp of realFiles.slice(0, 5)) {
      if (await sendDocument(chatId, fp, path.basename(fp))) sentCount++;
    }
    if (sentCount === 0 && realFiles.length > 0) {
      await bot.sendMessage(chatId, 'I found the files but could not send them. You can retrieve them here:\n' +
        realFiles.slice(0, 3).map(f => '• ' + f).join('\n'));
    }
  }

  // 7. Ovozli nusxa: har matnli javobni yana ovozli xabar qilib yuborish ortiqcha edi — faqat so'ralsa (TELEGRAM_VOICE_REPLIES=true).
  if (getEnv('TELEGRAM_VOICE_REPLIES') === 'true' && reply.length < 300 && !hasPaths) {
    await sendVoiceReply(chatId, reply);
  }

  // 8. Kontekst saqlash
  if (!chatHistory[chatId]) chatHistory[chatId] = [];
  chatHistory[chatId].push({ user: userText, agent: reply, time: Date.now() });
  if (chatHistory[chatId].length > MAX_HISTORY) chatHistory[chatId].shift();
  
  // Eskirgan tarixni tozalash
  const now = Date.now();
  chatHistory[chatId] = chatHistory[chatId].filter(h => now - h.time < CONTEXT_TTL_MS);
}

// ── Remote Control & Keyboards ─────────────────────────────

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '📸 Skrinshot' }, { text: '📊 Holat' }],
    [{ text: '📁 Fayllar' }, { text: '🔊 Ovoz' }],
    [{ text: '❓ Yordam' }]
  ],
  resize_keyboard: true
};

async function handlePhoto(chatId, msg) {
  const highestPhoto = msg.photo[msg.photo.length - 1];
  await bot.sendChatAction(chatId, 'typing');
  let tmpPhoto = null;
  try {
    const fileLink = await bot.getFileLink(highestPhoto.file_id);
    tmpPhoto = path.join('/tmp', `tg_photo_${Date.now()}.jpg`);
    const axios = require('axios');
    const writer = fs.createWriteStream(tmpPhoto);
    const resp = await axios({ url: fileLink, method: 'GET', responseType: 'stream' });
    resp.data.pipe(writer);
    await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });

    const prompt = msg.caption || 'Describe this image in detail, extract any visible text, code or UI elements, and explain what you see concisely.';
    const gemini = require('./core/gemini');
    const visionReply = await gemini.completeVision({ imagePath: tmpPhoto, prompt });
    await bot.sendMessage(chatId, `👁 *Rasm tahlili:*\n\n${visionReply}`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Photo error:', err);
    await bot.sendMessage(chatId, `❌ Rasmni tahlil qilishda xatolik: ${err.message}`);
  } finally {
    if (tmpPhoto) { try { fs.unlinkSync(tmpPhoto); } catch (_) {} }
  }
}

async function handleDocument(chatId, msg) {
  await bot.sendChatAction(chatId, 'typing');
  try {
    const fileLink = await bot.getFileLink(msg.document.file_id);
    const fileName = msg.document.file_name || `tg_file_${Date.now()}`;
    const targetPath = path.join(os.homedir(), 'Downloads', fileName);
    const axios = require('axios');
    const writer = fs.createWriteStream(targetPath);
    const resp = await axios({ url: fileLink, method: 'GET', responseType: 'stream' });
    resp.data.pipe(writer);
    await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });

    await bot.sendMessage(chatId, `📥 *Fayl yuklandi:*\n\`${targetPath}\`\n(Hajmi: ${(msg.document.file_size / 1024).toFixed(1)} KB)`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Document error:', err);
    await bot.sendMessage(chatId, `❌ Faylni saqlashda xatolik: ${err.message}`);
  }
}

async function handleRemoteCommand(chatId, text, msg) {
  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@\w+$/, '');
  const args = trimmed.substring(parts[0].length).trim();

  // 1. /status yoki "📊 Holat"
  if (cmd === '/status' || cmd === '/info' || trimmed === '📊 Holat') {
    let batt = 'N/A';
    try { batt = execSync('pmset -g batt 2>/dev/null | grep -o "[0-9]*%" | head -1', { encoding: 'utf8' }).trim() || 'AC Power'; } catch (_) {}
    let ram = 'N/A';
    try { ram = execSync('top -l 1 -s 0 2>/dev/null | grep "PhysMem"', { encoding: 'utf8' }).trim(); } catch (_) {}
    let disk = 'N/A';
    try { disk = execSync("df -h / | tail -1 | awk '{print $4 \" free of \" $2}'", { encoding: 'utf8' }).trim(); } catch (_) {}
    let upt = 'N/A';
    try { upt = execSync('uptime', { encoding: 'utf8' }).trim(); } catch (_) {}
    let vol = 'N/A';
    try { vol = execSync("osascript -e 'output volume of (get volume settings)' 2>/dev/null", { encoding: 'utf8' }).trim() + '%'; } catch (_) {}

    const reply = `📊 *JARVIS Mac Holati*\n\n` +
      `⚡️ *Batareya:* ${batt}\n` +
      `🧠 *RAM:* ${ram.replace('PhysMem: ', '')}\n` +
      `💾 *Disk:* ${disk}\n` +
      `🔊 *Ovoz:* ${vol}\n` +
      `⏱ *Uptime:* ${upt}\n\n` +
      `🤖 *Xizmatlar:* Active (http://localhost:7890)\n` +
      `🎙 *Ovoz:* Ultron (American Rocko)`;
    await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD });
    return true;
  }

  // 2. /screen yoki /screenshot yoki "📸 Skrinshot"
  if (cmd === '/screen' || cmd === '/screenshot' || trimmed === '📸 Skrinshot') {
    await bot.sendChatAction(chatId, 'upload_photo');
    await takeScreenshot(chatId, args && args.toLowerCase() !== 'photo' ? args : null);
    return true;
  }

  // 3. /sh <command> yoki /cmd <command> (Terminal buyrug'i)
  if (cmd === '/sh' || cmd === '/cmd') {
    if (!args) {
      await bot.sendMessage(chatId, '⚠️ Buyruq kiritilmadi.\nMasalan: `/sh ls -la` yoki `/sh git status`', { parse_mode: 'Markdown' });
      return true;
    }
    await bot.sendChatAction(chatId, 'typing');
    try {
      const out = execSync(args, { encoding: 'utf8', timeout: 30000, cwd: os.homedir(), env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` } });
      const resText = (out || '(bo\'sh chiqish)').trim();
      if (resText.length > 3500) {
        const outPath = path.join('/tmp', `sh_out_${Date.now()}.txt`);
        fs.writeFileSync(outPath, resText, 'utf8');
        await bot.sendDocument(chatId, outPath, { caption: `💻 Buyruq natijasi: ${args}` });
        try { fs.unlinkSync(outPath); } catch (_) {}
      } else {
        await bot.sendMessage(chatId, `💻 *Natija:*\n\`\`\`\n${resText}\n\`\`\``, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      const errOut = (err.stdout || '') + (err.stderr || '') + (err.message || '');
      await bot.sendMessage(chatId, `❌ *Xatolik:*\n\`\`\`\n${errOut.slice(0, 3000)}\n\`\`\``, { parse_mode: 'Markdown' });
    }
    return true;
  }

  // 4. /open <app> (Dastur ochish)
  if (cmd === '/open') {
    if (!args) {
      await bot.sendMessage(chatId, '⚠️ Dastur nomini yozing.\nMasalan: `/open Telegram`, `/open Safari`, `/open Cursor`', { parse_mode: 'Markdown' });
      return true;
    }
    try {
      execSync(`open -a "${args}"`, { timeout: 5000 });
      await bot.sendMessage(chatId, `🚀 *${args}* ochildi.`, { parse_mode: 'Markdown' });
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Dasturni ochib bo'lmadi: ${args}`);
    }
    return true;
  }

  // 5. /close <app> (Dastur yopish)
  if (cmd === '/close' || cmd === '/quit') {
    if (!args) {
      await bot.sendMessage(chatId, '⚠️ Dastur nomini yozing.\nMasalan: `/close Safari`', { parse_mode: 'Markdown' });
      return true;
    }
    try {
      execSync(`osascript -e 'quit app "${args}"'`, { timeout: 5000 });
      await bot.sendMessage(chatId, `🛑 *${args}* yopildi.`, { parse_mode: 'Markdown' });
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Dasturni yopib bo'lmadi: ${args}`);
    }
    return true;
  }

  // 6. /volume <0-100> yoki /mute / /unmute
  if (cmd === '/volume' || trimmed === '🔊 Ovoz') {
    if (!args) {
      let cur = 'N/A';
      try { cur = execSync("osascript -e 'output volume of (get volume settings)'", { encoding: 'utf8' }).trim(); } catch(_) {}
      await bot.sendMessage(chatId, `🔊 Joriy ovoz balandligi: *${cur}%*\nO'zgartirish uchun: \`/volume 50\``, { parse_mode: 'Markdown' });
      return true;
    }
    const val = parseInt(args, 10);
    if (!isNaN(val) && val >= 0 && val <= 100) {
      execSync(`osascript -e 'set volume output volume ${val}'`);
      await bot.sendMessage(chatId, `🔊 Ovoz balandligi: *${val}%* ga sozlandi.`, { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, `⚠️ 0 dan 100 gacha raqam kiriting. Masalan: \`/volume 70\``, { parse_mode: 'Markdown' });
    }
    return true;
  }

  if (cmd === '/mute') {
    execSync("osascript -e 'set volume output muted true'");
    await bot.sendMessage(chatId, '🔇 Mac ovozi o\'chirildi (Muted).');
    return true;
  }
  if (cmd === '/unmute') {
    execSync("osascript -e 'set volume output muted false'");
    await bot.sendMessage(chatId, '🔊 Mac ovozi yoqildi (Unmuted).');
    return true;
  }

  // 7. /say <text> (Ultron ovozida gapirtirish)
  if (cmd === '/say') {
    if (!args) {
      await bot.sendMessage(chatId, '⚠️ Gapirish kerak bo\'lgan matnni yozing.\nMasalan: `/say Hello master, I am online.`', { parse_mode: 'Markdown' });
      return true;
    }
    try {
      const audio = await ttsToFile(args, { source: 'telegram-remote-say' });
      if (audio && fs.existsSync(audio)) {
        await new Promise((res, rej) => {
          execFile('afplay', [audio], (err) => {
            try { fs.unlinkSync(audio); } catch (_) {}
            if (err) rej(err); else res();
          });
        });
        await bot.sendMessage(chatId, `🗣 Ultron ovozida aytildi: "${args}"`);
      }
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Gapirishda xatolik: ${e.message}`);
    }
    return true;
  }

  // 8. /find <name> yoki /search <name>
  if (cmd === '/find' || cmd === '/search' || trimmed === '📁 Fayllar') {
    if (!args) {
      await bot.sendMessage(chatId, '🔍 Fayl nomini kiriting.\nMasalan: `/find report.pdf` yoki `/find script.js`', { parse_mode: 'Markdown' });
      return true;
    }
    await bot.sendChatAction(chatId, 'typing');
    const files = findFiles(args);
    if (!files || files.length === 0) {
      await bot.sendMessage(chatId, `🔍 "${args}" bo'yicha hech qanday fayl topilmadi.`);
      return true;
    }
    const list = `📁 *Topilgan fayllar:*\n\n` + files.map((f, i) => `${i + 1}. \`${f}\``).join('\n') + `\n\nYuklab olish uchun: \`/get <fayl_yo'li>\``;
    await bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
    return true;
  }

  // 9. /get <filepath> (Faylni Telegramga yuklab olish)
  if (cmd === '/get') {
    if (!args) {
      await bot.sendMessage(chatId, '📥 Fayl yo\'lini kiriting.\nMasalan: `/get /Users/username/Desktop/doc.pdf`', { parse_mode: 'Markdown' });
      return true;
    }
    const cleanPath = args.replace(/^["']|["']$/g, '').trim();
    if (fs.existsSync(cleanPath)) {
      await bot.sendChatAction(chatId, 'upload_document');
      await sendDocument(chatId, cleanPath, path.basename(cleanPath));
    } else {
      await bot.sendMessage(chatId, `❌ Fayl topilmadi: \`${cleanPath}\``, { parse_mode: 'Markdown' });
    }
    return true;
  }

  // 10. /help yoki "❓ Yordam"
  if (cmd === '/help' || trimmed === '❓ Yordam' || cmd === '/menu') {
    const helpText = `🎛 *JARVIS Masofadan Boshqarish Menyusi*\n\n` +
      `📊 */status* — Batareya, RAM, Disk, CPU va tizim holati\n` +
      `📸 */screen* — Mac ekranidan oniy skrinshot olish\n` +
      `🔍 */screen analyze* — Ekranda nima bo'layotganini AI tahlil qilishi\n` +
      `💻 */sh <buyruq>* — Mac terminalida buyruq bajarish\n` +
      `🚀 */open <dastur>* — Mac'da dasturni ochish (masalan: \`/open Chrome\`)\n` +
      `🛑 */close <dastur>* — Dasturni yopish (masalan: \`/close Safari\`)\n` +
      `🗣 */say <matn>* — Kompyuteringizda Ultron ovozida gapirish\n` +
      `🔊 */volume <0-100>* — Ovoz balandligini sozlash\n` +
      `🔇 */mute* / */unmute* — Ovozni o'chirish/yoqish\n` +
      `🔍 */find <nom>* — Mac'dan fayl qidirish\n` +
      `📥 */get <yo'l>* — Mac'dagi faylni Telegramga yuklab olish\n` +
      `⚙️ */tasks* — Fondagi checkpointed vazifalar\n\n` +
      `💡 *Qo'shimcha imkoniyatlar:*\n` +
      `• *Rasm yuborsangiz:* Gemini Vision orqali darhol tahlil qilib beradi.\n` +
      `• *Hujjat yuborsangiz:* Mac'ning ~/Downloads jildiga saqlaydi.\n` +
      `• *Ovozli xabar yuborsangiz:* Gemini STT orqali tushunib, bajaradi.\n` +
      `• *Har qanday vazifa yozsangiz:* Antigravity Pro orqali bajaradi.`;
    await bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD });
    return true;
  }

  return false;
}

// ── Bot Events ──────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  chatHistory[msg.chat.id] = [];
  const welcome = '👋 *Assalomu alaykum, Xo\'jayin!*\n\n' +
    'Men — *JARVIS*, sizning Mac kompyuteringizni masofadan to\'liq boshqaruvchi shaxsiy yordamchingizman.\n\n' +
    '📱 *Quyidagi tugmalar orqali yoki to\'g\'ridan-to\'g\'ri buyruq bering:*\n' +
    '• *📸 Skrinshot* — Mac ekranini rasm qilib ko\'rish\n' +
    '• *📊 Holat* — Batareya, RAM, Disk, Uptime holati\n' +
    '• */sh <buyruq>* — Mac terminalida buyruq bajarish\n' +
    '• */open <dastur>* — Kompyuterda istalgan ilovani ochish\n' +
    '• */say <matn>* — Mac dinamikidan Ultron ovozida gapirish\n' +
    '• */find <nom>* — Fayllarni qidirish va yuklab olish\n' +
    '• *Rasm / Ovoz:* Istalgan rasm yoki audio yuboring — darhol tahlil qilaman.\n' +
    '• *Barcha buyruqlar uchun:* /help bosing.';
  bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD });
});

bot.onText(/\/cancel/, (msg) => {
  chatHistory[msg.chat.id] = [];
  bot.sendMessage(msg.chat.id, 'Conversation history cleared. What shall I do next?', { reply_markup: MAIN_KEYBOARD });
});

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const task = messageQueue.enqueue(String(chatId), async () => {
    if (await ownerTaskCommands(msg)) return;
    console.log('Telegram message received: chat=' + chatId + ', from=' + (msg.from?.id || 'unknown') + ', type=' + (msg.video_note ? 'video_note' : msg.voice ? 'voice' : msg.photo ? 'photo' : msg.document ? 'document' : msg.text ? 'text' : 'other'));

    // 1. Masofadan boshqarish buyruqlari
    if (msg.text) {
      const handled = await handleRemoteCommand(chatId, msg.text.trim(), msg);
      if (handled) return;
    }

    // 2. Oddiy matnli xabar (AI agentga)
    if (msg.text && !msg.text.startsWith('/')) {
      await handleMessage(chatId, msg.text.trim(), false);
      return;
    }

    // 3. Rasm tahlili (Gemini Vision)
    if (msg.photo && msg.photo.length > 0) {
      await handlePhoto(chatId, msg);
      return;
    }

    // 4. Hujjat / Fayl (Mac ~/Downloads ga saqlash)
    if (msg.document) {
      await handleDocument(chatId, msg);
      return;
    }

    // 5. Telegram dumaloq video (video_note): audio nutq + video kadrlari birga tahlil qilinadi.
    if (msg.video_note) {
      await enqueueVideoNote(msg);
      return;
    }

    // 6. Ovozli xabar
    if (msg.voice) {
      console.log('[' + chatId + '] VOICE received');
      await bot.sendChatAction(chatId, 'typing');
      let media;
      try {
        const fileLink = await bot.getFileLink(msg.voice.file_id);
        media = await prepareVoiceMessage(fileLink);
        const stt = await sttFromFile(media.wavPath, { source: 'telegram-voice' });
        if (stt && stt.status === 'ok' && stt.text) {
          const transcript = stt.text;
          await bot.sendMessage(chatId, '🎙 Eshitdim: “' + transcript.substring(0, 200) + '”');
          const handled = await handleRemoteCommand(chatId, transcript, msg);
          if (!handled) {
            await handleMessage(chatId, transcript, true);
          }
        } else {
          await bot.sendMessage(chatId, 'I could not understand the voice message. Please speak clearly and try again.');
        }
      } catch (e) {
        console.error('Voice processing error:', e.message);
        await bot.sendMessage(chatId, 'An error occurred while processing the voice message.');
      } finally {
        if (media) await media.cleanup().catch(() => {});
      }
      return;
    }
  });
  updateTasks.set(msg, task);
  task.catch(error => console.error('Telegram message processing failed:', error.message || error));
});

telegramPoller.start();
let shuttingDown = false;
function shutdown(exitCode, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error('Telegram bot fatal error:', reason.message || reason);
  telegramPoller.stop();
  process.exitCode = exitCode;
  setTimeout(() => process.exit(exitCode), 100).unref();
}
process.once('SIGTERM', () => shutdown(0));
process.once('SIGINT', () => shutdown(0));
process.once('uncaughtException', error => shutdown(1, error));
process.once('unhandledRejection', error => shutdown(1, error));

console.log('Bot tayyor! v8 (Universal AI + Kontekst)');
console.log('Ctrl+C bosib toxtatishingiz mumkin');
