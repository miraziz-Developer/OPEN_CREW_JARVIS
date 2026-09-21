'use strict';

function normalize(text) {
  return String(text || '').toLocaleLowerCase('uz-UZ')
    .replace(/[ʻ’`´]/g, "'").replace(/[^a-z0-9à-ž' ]/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

const ACKS = new Set([
  'ha', "xo'p", 'xop', 'hop', "bo'ldi", 'boldi', "to'g'ri", 'togri', 'tushunarli',
  'ok', 'okay', 'yes', 'yeah', 'yep', 'sure', 'alright', 'all right', 'mm', 'hmm', 'a'
]);

const NOISE_UTTERANCES = new Set([
  'uh', 'um', 'erm', 'hm', 'mmm', 'ah', 'oh', 'ee', 'eee',
  'thanks', 'thank you', 'thanks for watching', 'subscribe',
  'you', 'the', 'and', 'so', 'bye', 'goodbye'
]);

const SINGLE_WORD_INTENTS = new Set([
  'jarvis', 'salom', 'toxta', "to'xta", 'toxtat', "to'xtat", 'davom',
  'och', 'yop', 'qidir', 'top', 'yoz', 'ayt', 'kor', "ko'r", 'eslat',
  'jim', 'bekor', 'cancel', 'stop', 'pause', 'resume', 'continue', 'help'
]);

// Karnaydan video/musiqa ovozi chiqayotgan paytda lotin yozuvidagi ingliz,
// turk va boshqa tillar ham oddiy normalize()dan o'tadi. Bunday rejimda
// javob yaratish uchun turn ichida kamida bitta o'zbekcha intent belgisi
// bo'lishini talab qilamiz. Ro'yxat ataylab kundalik so'zlar + buyruqlarni
// qamraydi; "Chrome och" kabi qisqa real buyruqlar ham o'tadi.
const UZBEK_TURN_MARKERS = new Set([
  'jarvis', 'salom', 'men', 'sen', 'siz', 'bu', 'shu', 'o‘sha', "o'sha",
  'nima', 'qanday', 'qayer', 'qachon', 'nega', 'necha', 'nechchi', 'kim',
  'kerak', 'iltimos', 'ha', "yo'q", 'yoq', "xo'p", 'xop', 'bo‘ldi', "bo'ldi",
  'qil', 'qiling', 'och', 'yop', 'yoz', 'ayt', 'ber', 'ko‘r', "ko'r", 'top',
  'qidir', 'davom', 'to‘xtat', "to'xtat", 'eslat', 'qo‘y', "qo'y", 'o‘chir', "o'chir",
  'soat', 'vaqt', 'bugun', 'ertaga', 'kecha', 'hozir', 'yana', 'emas', 'bilan'
].map(normalize));

// Inglizcha gap ham to'liq qo'llab-quvvatlanadi, ammo javob tili o'zbekcha.
// Media rejimida oddiy film/dialog jumlasini emas, yordamchiga qaratilgan
// savol yoki buyruqni o'tkazish uchun asosan interrogative/imperative
// markerlar ishlatiladi. Masalan "what time is it" va "open Chrome" o'tadi,
// "happiness will come to you" kabi fon dialogi o'tmaydi.
const ENGLISH_INTENT_MARKERS = new Set([
  'jarvis', 'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
  'please', 'tell', 'show', 'find', 'open', 'close', 'start', 'stop', 'pause',
  'play', 'continue', 'resume', 'write',
  'read', 'search', 'remember', 'remind', 'create', 'make', 'send', 'check', 'help',
  'explain', 'analyze', 'compare', 'translate', 'turn', 'set', 'give', 'take', 'look'
]);
const ENGLISH_QUESTION_STARTERS = new Set([
  'am', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could',
  'will', 'would', 'should', 'have', 'has', 'may'
]);

function looksLikeUzbekTurn(text) {
  const tokens = normalize(text).split(' ').filter(Boolean);
  return tokens.some(token => UZBEK_TURN_MARKERS.has(token));
}

function looksLikeEnglishIntent(text) {
  const tokens = normalize(text).split(' ').filter(Boolean);
  if (!tokens.length) return false;
  // Media dialogue frequently contains an intent-looking word later in a long
  // sentence ("Agent B is first. Let's look for him"). Requiring the marker at
  // the beginning preserves actual questions/imperatives without treating a
  // movie subtitle as an addressed command. "Please" may precede the verb.
  return ENGLISH_QUESTION_STARTERS.has(tokens[0]) ||
    ENGLISH_INTENT_MARKERS.has(tokens[0]) ||
    (tokens[0] === 'please' && ENGLISH_INTENT_MARKERS.has(tokens[1]));
}

function looksLikeAddressedTurn(text) {
  return looksLikeUzbekTurn(text) || looksLikeEnglishIntent(text);
}

function similarity(a, b) {
  const aa = new Set(normalize(a).split(' ').filter(Boolean));
  const bb = new Set(normalize(b).split(' ').filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const token of aa) if (bb.has(token)) common++;
  return common / Math.max(aa.size, bb.size);
}

function classifyUserTurn(text, context = {}) {
  const value = normalize(text);
  if (!value) return { accept: false, reason: 'empty' };
  // A short acknowledgement is usually microphone/crosstalk noise when there
  // is no active exchange. Once Jarvis has just spoken, however, it is a real
  // conversational turn (for example "ha", "yes", or "xo'p, davom") and
  // must reach the Realtime model so the dialogue can naturally continue.
  if (ACKS.has(value)) {
    return context.conversationActive
      ? { accept: true, reason: 'contextual-acknowledgement' }
      : { accept: false, reason: 'acknowledgement' };
  }
  if (NOISE_UTTERANCES.has(value)) return { accept: false, reason: 'low-information' };
  const tokens = value.split(' ').filter(Boolean);
  // Bir bo'g'inli shovqin yoki STTning tasodifiy bitta so'zli taxmini Jarvisni
  // o'zidan-o'zi gapirtirmasin. Haqiqiy bir-so'zli buyruqlar whitelistda.
  if (tokens.length === 1 && !SINGLE_WORD_INTENTS.has(tokens[0]) && tokens[0].length < 5) {
    return { accept: false, reason: 'low-information' };
  }
  if (context.mediaMode && !context.explicitUserTrigger && !looksLikeAddressedTurn(value)) {
    return { accept: false, reason: 'media-background' };
  }
  const lastAssistant = normalize(context.lastAssistant);
  if (lastAssistant && (lastAssistant.includes(value) || similarity(value, lastAssistant) >= (context.echoSimilarity || 0.72))) {
    return { accept: false, reason: 'assistant-echo' };
  }
  return { accept: true, reason: 'speech' };
}

function isRepeatedResponse(candidate, previous, threshold = 0.82) {
  const a = normalize(candidate), b = normalize(previous);
  if (a.length < 18 || b.length < 18) return false;
  // Streaming transcript boshida ikki mutlaqo boshqa javob ham bir xil
  // ibora bilan boshlanishi mumkin. Eski javobning kamida 70% qismi
  // kelmaguncha prefix bo'yicha bekor qilmaymiz.
  const enoughForPrefixDecision = a.length >= Math.floor(b.length * 0.7);
  return (enoughForPrefixDecision && (b.startsWith(a) || a.startsWith(b))) || similarity(a, b) >= threshold;
}

// JARVIS gapirayotganda "boldi", "kerak emas", "aha okay okay", "stop" kabi qisqa to'xtatish/tasdiq gaplari:
// javob yaratmaydi, faqat gapni to'xtatib yana tinglashga o'tadi (uz/en/ru).
const STOP_CORE = new Set([
  'stop', 'enough', 'quiet', 'hush', 'silence', 'pause', 'wait', 'hold', 'shut', 'all', 'do', 'cancel', 'nevermind',
  'okay', 'ok', 'okey', 'aha', 'yeah', 'yes', 'yep', 'yup', 'right', 'alright', 'sure', 'fine', 'got', 'understood',
  'thanks', 'thank',
  'boldi', 'boldy', 'bolde', 'bolti', 'buldi', 'bodi', 'vd', 'yetadi', 'yetarli', 'bas', 'toxta', 'toxtang', 'toxtat', 'jim', 'tushundim', 'tushunarli', 'yaxshi',
  'xop', 'hop', 'mayli', 'rahmat', 'bekor', 'emas', 'keremas', 'ha',
  'хватит', 'стоп', 'ладно', 'понял', 'ясно', 'хорошо', 'спасибо', 'тихо', 'всё', 'все', 'ага', 'ок'
]);
const STOP_FILLER = new Set([
  'it', 'i', 'get', 'that', 'thats', 'will', 'is', 'no', 'need', 'not', 'needed', 'talking', 'up', 'be', 'please',
  'now', 'just', 'me', 'you', 'on', 'a', 'bit', 'uh', 'um', 'hm', 'hmm', 'mm', 'mmm', 'ah', 'oh', 'the', 'kerak',
  'endi', 'jarvis'
]);

function stopTokens(text) {
  return String(text || '').toLocaleLowerCase('en-US')
    // Til aniqlash noto'g'ri bo'lganda "aha" ba'zan CJK belgilar ('啊哈') bo'lib keladi — ular shovqin.
    .replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g, ' ')
    .replace(/[ʻ’‘`´ʼ']/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/).filter(Boolean);
}

// Server "Stop" ni "Top", "Boldi" ni "Boldy" deb eshitishi mumkin: bitta so'zli gapda 1 harf farqqacha qabul qilamiz.
const FUZZY_STOP_WORDS = ['stop', 'boldi'];

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

function isStopIntent(text) {
  const tokens = stopTokens(text);
  if (!tokens.length || tokens.length > 6) return false;
  if (tokens.length === 1 && tokens[0].length >= 3 && FUZZY_STOP_WORDS.some(word => editDistance(tokens[0], word) <= 1)) return true;
  return tokens.every(word => STOP_CORE.has(word) || STOP_FILLER.has(word)) && tokens.some(word => STOP_CORE.has(word));
}

function conversationIdleDelay(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const idleMs = Math.max(0, Number(options.idleMs) || 0);
  const followupMs = Math.max(0, Number(options.followupMs) || idleMs);
  const playbackUntil = Number.isFinite(options.playbackUntil) ? options.playbackUntil : now;
  const waitAfterPlayback = options.awaitingFollowup ? followupMs : idleMs;
  return Math.max(0, playbackUntil - now) + waitAfterPlayback;
}

module.exports = {
  normalize, similarity, looksLikeUzbekTurn, looksLikeEnglishIntent,
  looksLikeAddressedTurn, classifyUserTurn, isRepeatedResponse,
  conversationIdleDelay, isStopIntent
};