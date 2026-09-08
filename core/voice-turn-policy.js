'use strict';

function normalize(text) {
  return String(text || '').toLocaleLowerCase('uz-UZ')
    .replace(/[ʻ’`´]/g, "'").replace(/[^a-z0-9à-ž' ]/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

const ACKS = new Set(['ha', "xo'p", 'xop', 'hop', "bo'ldi", 'boldi', "to'g'ri", 'togri', 'tushunarli', 'ok', 'okay', 'mm', 'hmm', 'a']);

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
  'explain', 'compare', 'translate', 'turn', 'set', 'give', 'take', 'look'
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
  return ENGLISH_QUESTION_STARTERS.has(tokens[0]) ||
    tokens.some(token => ENGLISH_INTENT_MARKERS.has(token));
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
  if (ACKS.has(value)) return { accept: false, reason: 'acknowledgement' };
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

module.exports = {
  normalize, similarity, looksLikeUzbekTurn, looksLikeEnglishIntent,
  looksLikeAddressedTurn, classifyUserTurn, isRepeatedResponse
};