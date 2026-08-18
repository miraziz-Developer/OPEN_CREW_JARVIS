#!/usr/bin/env node
/**
 * JARVIS Telegram Bot — v8 Final
 * OpenClaw + Kimi K2.6 (Azure) + Azure Speech TTS/STT
 * 100% o'zbek tilida. Universal AI agentga yuboradi,
 * javobdan fayl yo'llarini chiqarib yuboradi.
 */

const TelegramBot = require('node-telegram-bot-api').default;
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeMemory, searchMemory, readProfile } = require('./skills/memory');

const PROJECT_DIR = '/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS';
process.chdir(PROJECT_DIR);

const ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8');
function getEnv(key) {
  const m = ENV.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim() : '';
}

const TOKEN = getEnv('TELEGRAM_BOT_TOKEN');
if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN topilmadi'); process.exit(1); }

const AZURE_SPEECH_KEY = getEnv('AZURE_SPEECH_KEY');
const AZURE_SPEECH_REGION = getEnv('AZURE_SPEECH_REGION');
const AZURE_SPEECH_VOICE = getEnv('AZURE_SPEECH_VOICE') || 'uz-UZ-SardorNeural';
const AZURE_OPENAI_KEY = getEnv('AZURE_OPENAI_KEY');

const chatHistory = {};
const MAX_HISTORY = 10;
const CONTEXT_TTL_MS = 10 * 60 * 1000;

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
console.log('Token:', TOKEN.substring(0, 10) + '...');
const bot = new TelegramBot(TOKEN, { polling: true });

// ── Helpers ──────────────────────────────────────────────────

async function ttsToFile(text) {
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
      try { resolve(JSON.parse(out.trim()).audioFile || null); } catch (e) { resolve(null); }
    });
    fs.createReadStream(tmpIn).pipe(proc.stdin);
  });
}

async function sttFromFile(wavPath) {
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
      try { resolve(JSON.parse(out.trim())); } catch (e) { resolve({ status: 'error', text: '' }); }
    });
    fs.createReadStream(tmpIn).pipe(proc.stdin);
  });
}

async function askAgent(message) {
  return new Promise((resolve) => {
    const env = { ...process.env, AZURE_OPENAI_KEY, AZURE_SPEECH_KEY, AZURE_SPEECH_REGION, AZURE_SPEECH_VOICE };
    const proc = spawn('openclaw', ['agent', '--session-key', 'agent:main:telegram', '--message', message, '--agent', 'main'], {
      cwd: PROJECT_DIR, env, timeout: 120000
    });
    let out = '';
    proc.stdout.on('data', d => (out += d.toString()));
    proc.stderr.on('data', d => {});
    proc.on('close', () => {
      const clean = out.split('\n')
        .filter(l => !l.includes('Waiting') && !l.includes('◒') && l.trim())
        .join('\n').trim();
      resolve(clean || null);
    });
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
      await bot.sendMessage(chatId, 'Fayl juda katta (' + sizeMB.toFixed(1) + ' MB). 50 MB limit.');
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
    const audioPath = await ttsToFile(safe);
    if (!audioPath || !fs.existsSync(audioPath)) return;
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

async function takeScreenshot(chatId) {
  const p = os.homedir() + '/Desktop/jarvis_screenshot_' + Date.now() + '.png';
  try {
    execSync('screencapture -x "' + p + '"');
    if (fs.existsSync(p)) {
      await bot.sendDocument(chatId, p, { caption: 'Jarvis skrinshoti' });
      return 'Ekran tasviri olindi va sizga yuborildi!';
    }
  } catch (e) {
    return 'Skrinshot olishda xatolik yuz berdi.';
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
        await bot.sendMessage(chatId, url[1] + ' brauzerda ochildi!');
        await sendVoiceReply(chatId, url[1] + ' sayti ochilmoqda.');
      } catch (e) {
        await bot.sendMessage(chatId, 'Sayt ochishda xatolik.');
      }
      return;
    }
  }

  // 3a. XOTIRA: "eslab qol" buyruqi
  if (/eslab qol|esda tut|xotira|memory/i.test(userText) && userText.length > 20) {
    const clean = userText.replace(/eslab qol|esda tut|xotira|memory/gi, '').trim();
    const wr = writeMemory('Telegram eslatma', clean, ['telegram']);
    await bot.sendMessage(chatId, '✅ Eslab qoldim: ' + clean.substring(0, 100));
    return;
  }

  // 3b. PROFIL: profil so'rov
  if (/profilim|men haqimda|o'zim haqimda/i.test(userText)) {
    const pr = readProfile();
    if (pr.status === 'ok' && pr.content) {
      await bot.sendMessage(chatId, '📋 Profilingiz:\n\n' + pr.content.substring(0, 2000));
    } else {
      await bot.sendMessage(chatId, 'Profilingiz hali bo\'sh. "Jarvis, ... eslab qol" deb ayting.');
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
  let enrichedMessage = memoryContext + userText;
  
  // Agar avvalgi suhbat bosa — kontekst bilan
  const history = chatHistory[chatId];
  if (history && history.length > 0) {
    const lastMsgs = history.slice(-3).map(h => 'F: ' + h.user + '\nJ: ' + h.agent).join('\n---\n');
    enrichedMessage = 'Oldingi suhbat:\n' + lastMsgs + '\n---\n' + enrichedMessage;
  }

  const reply = await askAgent(enrichedMessage);

  if (!reply) {
    await bot.sendMessage(chatId, 'Kechirasiz, hozir javob bera olmayman. Keyinroq urinib koring.');
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
  if (displayReply) await bot.sendMessage(chatId, displayReply);

  // 6. Topilgan fayllarni yuborish
  if (realFiles.length > 0) {
    await bot.sendChatAction(chatId, 'upload_document');
    let sentCount = 0;
    for (const fp of realFiles.slice(0, 5)) {
      if (await sendDocument(chatId, fp, path.basename(fp))) sentCount++;
    }
    if (sentCount === 0 && realFiles.length > 0) {
      await bot.sendMessage(chatId, 'Fayllar yo\'li topildi, lekin yuborishda muammo. Qo\'lda olish:\n' +
        realFiles.slice(0, 3).map(f => '• ' + f).join('\n'));
    } else if (sentCount > 0) {
      await bot.sendMessage(chatId, sentCount + ' ta fayl yuborildi!');
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
    'Salom! Men Jarvis, sizning o\'zbek tilidagi AI-yordamchingiz.\n\n' +
    'Nima qila olaman:\n' +
    '• Ma\'lumot: "Bugun ob-havo qanday?"\n' +
    '• Fayllar: "Desktopda offer letterlarni top va yubor"\n' +
    '• Skrinshot: "Skrinshot ol"\n' +
    '• Brauzer: "Google.com ni och"\n' +
    '• Ovoz bilan ham gapirishingiz mumkin!\n\n' +
    '"Salom" deb boshlang 😊'
  );
});

bot.onText(/\/cancel/, (msg) => {
  chatHistory[msg.chat.id] = [];
  bot.sendMessage(msg.chat.id, 'Xotira tozalandi. Endi nima qilishim mumkin?');
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Matnli xabar
  if (msg.text && !msg.text.startsWith('/')) {
    await handleMessage(chatId, msg.text.trim(), false);
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
      
      const stt = await sttFromFile(wavPath);
      if (stt && stt.status === 'ok' && stt.text) {
        const transcript = stt.text;
        await bot.sendMessage(chatId, 'Eshitdim: "' + transcript.substring(0, 200) + '"');
        await handleMessage(chatId, transcript, true);
      } else {
        await bot.sendMessage(chatId, 'Ovozni tushunmadim. Iltimos, aniqroq va sekin gapiring. Siz o\'zbek tilida gapirasizmi?');
      }
      
      try { fs.unlinkSync(ogaPath); } catch (e) {}
      try { fs.unlinkSync(wavPath); } catch (e) {}
    } catch (e) {
      console.error('Voice processing error:', e.message);
      await bot.sendMessage(chatId, 'Ovozni qayta ishlashda xatolik yuz berdi.');
    }
    return;
  }
});

// Tarmoq uzilganda (DNS/WiFi) polling xatosi bir necha soniyada bir marta
// takrorlanaveradi — avval har birini to'liq log qilib, faylni bir necha
// ming qatorga to'ldirib yuborardi. Endi: qisqacha, kamdan-kam log qilinadi
// va uzoq davom etsa (30s+, taxminan 15+ ketma-ket xato) polling'ni
// o'zi qayta ishga tushiradi — ba'zan library o'zi "qotib qolib" tiklana
// olmay qoladi, buni majburiy qayta ulash bilan tuzatamiz.
let _pollErrCount = 0;
let _pollErrFirstAt = 0;
let _pollRecovering = false;
bot.on('polling_error', (err) => {
  const now = Date.now();
  if (!_pollErrFirstAt || now - _pollErrFirstAt > 60000) { _pollErrFirstAt = now; _pollErrCount = 0; }
  _pollErrCount++;
  if (_pollErrCount === 1 || _pollErrCount % 20 === 0) {
    console.error('Polling error (' + _pollErrCount + '-marta): ' + (err.message || err));
  }
  if (_pollErrCount >= 15 && !_pollRecovering) {
    _pollRecovering = true;
    console.error('Polling 30s+ uzilib turibdi — majburiy qayta ulanmoqda...');
    bot.stopPolling().then(() => bot.startPolling()).then(() => {
      console.error('Polling qayta ulandi.');
      _pollErrCount = 0; _pollRecovering = false;
    }).catch((e) => {
      console.error('Qayta ulanishda xatolik: ' + (e.message || e));
      _pollRecovering = false;
    });
  }
});

console.log('Bot tayyor! v8 (Universal AI + Kontekst)');
console.log('Ctrl+C bosib toxtatishingiz mumkin');
