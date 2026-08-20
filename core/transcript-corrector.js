'use strict';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function preserveCase(source, replacement) {
  if (!source) return replacement;
  if (source === source.toUpperCase()) return replacement.toUpperCase();
  // `replacement` is the user's canonical spelling (Jarvis, OpenClaw,
  // GitHub...). Do not let an STT model's incidental lowercase destroy it.
  return replacement;
}

// Realtime STT tez aytilgan o'zbekcha qo'shimcha va unlilarni tez-tez tushirib
// qoldiradi. Bu ro'yxat faqat ma'nosi bir xil, xavfsiz og'zaki variantlarni
// adabiyroq shaklga keltiradi; ism yoki erkin matnni "taxminan" o'zgartirmaydi.
const UZBEK_SPOKEN_FORMS = [
  ['qivor', 'qilib yubor'], ['qvor', 'qilib yubor'],
  ['qiber', 'qilib ber'], ['qb ber', 'qilib ber'],
  ['ochvor', 'ochib yubor'], ['yopvor', 'yopib yubor'],
  ['bo‘pti', "bo'ldi"], ["bo'pti", "bo'ldi"], ['bopti', "bo'ldi"],
  ['ishlamayabdi', 'ishlamayapti'], ['ishlamayapdi', 'ishlamayapti'],
  ['eshitmayabdi', 'eshitmayapti'], ['eshtmayabdi', 'eshitmayapti'],
  ['tushunmayabdi', 'tushunmayapti'], ['tushunmayapdi', 'tushunmayapti'],
  ['gapiryabdi', 'gapiryapti'], ['gapiryapdi', 'gapiryapti'],
  ['bo‘lyabdi', "bo'lyapti"], ["bo'lyabdi", "bo'lyapti"], ['bolyabdi', "bo'lyapti"],
  ['to‘g‘ri', "to'g'ri"], ['togri', "to'g'ri"],
  ['yo‘q', "yo'q"], ['yoq', "yo'q"],
  ['hozirki', 'hozirgi']
];

function applyPhraseCorrections(text, entries) {
  let corrected = text;
  for (const entry of entries) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escapeRegex(entry.misheard)})(?=$|[^\\p{L}\\p{N}_])`, 'giu');
    corrected = corrected.replace(pattern, (_match, prefix, found) => prefix + preserveCase(found, entry.actual));
  }
  return corrected;
}

/**
 * Applies user-confirmed pronunciation corrections to an STT transcript.
 * Longest phrases win so a specific multi-word correction is not partially
 * consumed by a shorter entry. Word-like boundaries avoid changing text in
 * the middle of another token while still supporting punctuation and spaces.
 */
function correctTranscript(transcript, entries = []) {
  let corrected = String(transcript || '');
  const learned = entries
    .filter(entry => entry?.misheard && entry?.actual)
    .map(entry => ({ misheard: String(entry.misheard).trim(), actual: String(entry.actual).trim() }))
    .filter(entry => entry.misheard && entry.actual && entry.misheard.toLocaleLowerCase() !== entry.actual.toLocaleLowerCase())
    .sort((a, b) => b.misheard.length - a.misheard.length);

  corrected = applyPhraseCorrections(corrected, learned);
  const spoken = UZBEK_SPOKEN_FORMS
    .map(([misheard, actual]) => ({ misheard, actual }))
    .sort((a, b) => b.misheard.length - a.misheard.length);
  corrected = applyPhraseCorrections(corrected, spoken);
  return corrected;
}

module.exports = { correctTranscript };