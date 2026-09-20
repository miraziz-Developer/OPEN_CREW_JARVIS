#!/usr/bin/env node
/**
 * JARVIS Telegram Bot — v8 Final
 * OpenClaw + Azure Speech TTS/STT.
 * User-facing output is always natural English.
 */

const TelegramBotModule = require('node-telegram-bot-api');
const TelegramBot = TelegramBotModule.default || TelegramBotModule;
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeMemory, searchMemory, readProfile } = require('./skills/memory');
const { createTelegramPoller } = require('./core/telegram-poller');
const { analyzeVideoNote, validateVideoNote } = require('./core/video-note-analysis');
const { createAgentBridge } = require('./core/agent-bridge');
const { resolveOpenClawEnvironment } = require('./core/openclaw-credentials');
const { createSkillPlatform } = require('./skills/platform');
const { RuntimeTelemetry } = require('./core/runtime-telemetry');

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
const videoNoteQueues = new Map();
const processedVideoNotes = new Set();
const MAX_PROCESSED_VIDEO_NOTES = 1000;
const runtimeTelemetry = new RuntimeTelemetry({ file: path.join(PROJECT_DIR, '.run', 'telemetry.json') });

// MUHIM: tarmoq vaqtincha uzilib qolsa (DNS/WiFi), node-telegram-bot-api'ning
// ichki polling xatoligi ILGARI butun jarayonni yiqitib yuborardi (uncaught
// promise rejection) — shu daqiqada kelgan har qanday buyruq (masalan
// "davom et") "o'lik" jarayonga tushib, hech qachon javob bermas edi, va
// jarayon qayta ishga tushganda oldingi suhbat konteksti butunlay yo'qolardi.
// Global handler bilan bunday hodisalar endi jarayonni o'ldirmaydi.
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT (jarayon TIRIK qoladi):', err.message || err);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION (jarayon TIRIK qoladi):', (err && err.message) || err);
});

console.log('Jarvis Telegram Bot ishga tushmoqda (v8)...');
// node-telegram-bot-api@1.2.0 ning fetch asosidagi getUpdates transporti shu
// hostda muntazam EFATAL bilan uziladi. Handler va media metodlarini libraryda
// qoldiramiz, incoming update'larni esa barqaror native HTTPS poller olib keladi.
const bot = new TelegramBot(TOKEN, { polling: false });
const { createOwnerUpdateHandler, createOwnerTaskCommands } = require('./core/telegram-owner');
const { createGmailTaskNotifier } = require('./core/gmail-task-notifier');
const ownerId = getEnv('TELEGRAM_CHAT_ID');
if (!/^[1-9]\d*$/.test(ownerId)) console.error('Telegram locked: configure TELEGRAM_CHAT_ID with the owner private user ID.');
const telegramPoller = createTelegramPoller({
  token: TOKEN,
  onUpdate: createOwnerUpdateHandler({ ownerId, dispatch: update => bot.processUpdate(update) })
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

function askAgent(message, chatId) {
  return telegramAgentBridge.askAgent(message, 'agent:main:telegram', {
    source: 'telegram',
    onProgress: text => bot.sendMessage(chatId, '⏳ ' + text),
    onLongRunning: text => bot.sendMessage(chatId, '⏳ ' + text)
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
  try {
    const safe = text.substring(0, 400);
    const audioPath = await ttsToFile(safe, { source: 'telegram-voice-reply' });
    if (!audioPath || !fs.existsSync(audioPath)) {
      console.error('Voice reply skipped: TTS did not produce an audio file for chat ' + chatId + '.');
      return;
    }
    const ogg = audioPath.replace('.mp3', '.ogg');
    execSync('ffmpeg -y -i "' + audioPath + '" -c:a libopus "' + ogg + '" 2>/dev/null');
    if (fs.existsSync(ogg)) {
      await bot.sendVoice(chatId, ogg);
      fs.unlinkSync(ogg);
    }
  } catch (e) {
    console.error('Voice error:', e.message);
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
  const previous = videoNoteQueues.get(chatId) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => handleVideoNote(msg));
  videoNoteQueues.set(chatId, current);
  return current.finally(() => {
    if (videoNoteQueues.get(chatId) === current) videoNoteQueues.delete(chatId);
  });
}

async function takeScreenshot(chatId) {
  const p = os.homedir() + '/Desktop/jarvis_screenshot_' + Date.now() + '.png';
  try {
    execSync('screencapture -x "' + p + '"');
    if (fs.existsSync(p)) {
      await bot.sendDocument(chatId, p, { caption: 'JARVIS screenshot' });
      return 'Screenshot captured and sent.';
    }
  } catch (e) {
    return 'I could not capture the screenshot.';
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

  // 1. Skrinshot so'rovi
  if (/skrinshot|screenshot|ekran|rasmi?/i.test(userText)) {
    const r = await takeScreenshot(chatId);
    await bot.sendMessage(chatId, r);
    await sendVoiceReply(chatId, r);
    return;
  }

  // 2. Brauzer ochish
  if (/brauzer|browser|sayt/i.test(userText) && /(?:\.com|\.uz|\.org|\.net)/.test(userText)) {
    const url = userText.match(/(?:https?:\/\/)?(\S+\.(?:com|uz|org|net))/i);
    if (url) {
      try {
        execSync('open "https://' + url[1] + '"');
        await bot.sendMessage(chatId, url[1] + ' opened in the browser.');
        await sendVoiceReply(chatId, 'Opening ' + url[1] + '.');
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
  let enrichedMessage = '[Reply only in natural English.]\n' + memoryContext + userText;
  
  // Agar avvalgi suhbat bosa — kontekst bilan
  const history = chatHistory[chatId];
  if (history && history.length > 0) {
    const lastMsgs = history.slice(-3).map(h => 'F: ' + h.user + '\nJ: ' + h.agent).join('\n---\n');
    enrichedMessage = 'Oldingi suhbat:\n' + lastMsgs + '\n---\n' + enrichedMessage;
  }

  const reply = await askAgent(enrichedMessage, chatId);

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
    } else if (sentCount > 0) {
      await bot.sendMessage(chatId, sentCount + (sentCount === 1 ? ' file sent.' : ' files sent.'));
    }
  }

  // 7. Ovozli javob (agar qisqa bo'lsa)
  if (reply.length < 300 && !hasPaths && !isVoice) {
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

// ── Bot Events ──────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  chatHistory[msg.chat.id] = [];
  bot.sendMessage(msg.chat.id,
    'Hello. I am JARVIS, your English-speaking AI assistant.\n\n' +
    'I can answer questions, find and send files, capture screenshots, control the browser, and process voice messages.\n\n' +
    'Send a request whenever you are ready.'
  );
});

bot.onText(/\/cancel/, (msg) => {
  chatHistory[msg.chat.id] = [];
  bot.sendMessage(msg.chat.id, 'Conversation history cleared. What shall I do next?');
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (await ownerTaskCommands(msg)) return;
  console.log('Telegram message received: chat=' + chatId + ', from=' + (msg.from?.id || 'unknown') + ', type=' + (msg.video_note ? 'video_note' : msg.voice ? 'voice' : msg.text ? 'text' : 'other'));

  // Matnli xabar
  if (msg.text && !msg.text.startsWith('/')) {
    await handleMessage(chatId, msg.text.trim(), false);
    return;
  }

  // Telegram dumaloq video (video_note): audio nutq + video kadrlari birga tahlil qilinadi.
  if (msg.video_note) {
    await enqueueVideoNote(msg);
    return;
  }

  // Ovozli xabar
  if (msg.voice) {
    console.log('[' + chatId + '] VOICE received');
    await bot.sendChatAction(chatId, 'typing');
    try {
      const fileLink = await bot.getFileLink(msg.voice.file_id);
      const ogaPath = '/tmp/tg_voice_' + Date.now() + '.oga';
      const wavPath = ogaPath.replace('.oga', '.wav');
      
      execSync('curl -sL "' + fileLink + '" -o "' + ogaPath + '"');
      execSync('ffmpeg -y -i "' + ogaPath + '" -ar 16000 -ac 1 -sample_fmt s16 "' + wavPath + '" 2>/dev/null');
      
      const stt = await sttFromFile(wavPath, { source: 'telegram-voice' });
      if (stt && stt.status === 'ok' && stt.text) {
        const transcript = stt.text;
        await bot.sendMessage(chatId, 'I heard: “' + transcript.substring(0, 200) + '”');
        await handleMessage(chatId, transcript, true);
      } else {
        await bot.sendMessage(chatId, 'I could not understand the voice message. Please speak clearly in English and try again.');
      }
      
      try { fs.unlinkSync(ogaPath); } catch (e) {}
      try { fs.unlinkSync(wavPath); } catch (e) {}
    } catch (e) {
      console.error('Voice processing error:', e.message);
      await bot.sendMessage(chatId, 'An error occurred while processing the voice message.');
    }
    return;
  }
});

telegramPoller.start();
process.once('SIGTERM', () => telegramPoller.stop());
process.once('SIGINT', () => telegramPoller.stop());

console.log('Bot tayyor! v8 (Universal AI + Kontekst)');
console.log('Ctrl+C bosib toxtatishingiz mumkin');
