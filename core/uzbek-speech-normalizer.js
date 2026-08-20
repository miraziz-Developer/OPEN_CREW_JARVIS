'use strict';

/**
 * Matnni o'zgartirib yozish uchun emas, ovozda tabiiy o'qish uchun tayyorlaydi.
 * Realtime ovoz uz-UZ native voice bo'lmagani sabab raqam va qisqartmalarni
 * modelning taxminiga tashlab qo'ymaslik muhim.
 */

const ONES = ['', 'bir', 'ikki', 'uch', 'to‘rt', 'besh', 'olti', 'yetti', 'sakkiz', 'to‘qqiz'];
const TENS = ['', 'o‘n', 'yigirma', 'o‘ttiz', 'qirq', 'ellik', 'oltmish', 'yetmish', 'sakson', 'to‘qson'];
const SCALES = ['', 'ming', 'million', 'milliard', 'trillion'];
const DIGITS = ['nol', 'bir', 'ikki', 'uch', 'to‘rt', 'besh', 'olti', 'yetti', 'sakkiz', 'to‘qqiz'];
const MONTHS = [
  '', 'yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun',
  'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'
];

const ABBREVIATIONS = Object.freeze({
  AI: 'ey ay',
  API: 'ey pi ay',
  CPU: 'si pi yu',
  CSS: 'si es es',
  DNS: 'di en es',
  GPT: 'ji pi ti',
  GPU: 'ji pi yu',
  HTML: 'eych ti em el',
  HTTP: 'eych ti ti pi',
  HTTPS: 'eych ti ti pi es',
  IP: 'ay pi',
  JSON: 'jeyson',
  RAM: 'rem',
  SMS: 'es em es',
  SQL: 'es kyu el',
  TTS: 'ti ti es',
  URL: 'yu ar el',
  USB: 'yu es bi',
  VPN: 'vi pi en',
  WiFi: 'vay fay'
});

function underThousand(value) {
  const n = Math.trunc(value);
  const parts = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) parts.push(ONES[hundreds], 'yuz');
  if (rest >= 10) parts.push(TENS[Math.floor(rest / 10)]);
  if (rest % 10) parts.push(ONES[rest % 10]);
  return parts.join(' ');
}

function integerToUzbek(value) {
  let n = typeof value === 'bigint' ? value : BigInt(String(value));
  if (n === 0n) return 'nol';
  const negative = n < 0n;
  if (negative) n = -n;
  const chunks = [];
  let scale = 0;
  while (n > 0n) {
    const chunk = Number(n % 1000n);
    if (chunk) {
      if (scale >= SCALES.length) return String(value).split('').map(char => DIGITS[Number(char)] || char).join(' ');
      chunks.unshift([underThousand(chunk), SCALES[scale]].filter(Boolean).join(' '));
    }
    n /= 1000n;
    scale += 1;
  }
  return (negative ? 'minus ' : '') + chunks.join(' ');
}

function ordinalToUzbek(value) {
  const cardinal = integerToUzbek(value);
  const suffixes = {
    bir: 'birinchi', ikki: 'ikkinchi', uch: 'uchinchi', 'to‘rt': 'to‘rtinchi',
    besh: 'beshinchi', olti: 'oltinchi', yetti: 'yettinchi', sakkiz: 'sakkizinchi',
    'to‘qqiz': 'to‘qqizinchi', 'o‘n': 'o‘ninchi', yigirma: 'yigirmanchi',
    'o‘ttiz': 'o‘ttizinchi', qirq: 'qirqinchi', ellik: 'elliginchi'
  };
  const words = cardinal.split(' ');
  words[words.length - 1] = suffixes[words.at(-1)] || (words.at(-1) + 'inchi');
  return words.join(' ');
}

function digitsToUzbek(value) {
  return String(value).split('').map(char => DIGITS[Number(char)] || char).join(' ');
}

function normalizeApostrophes(text) {
  // Faqat harflar orasidagi belgini almashtiramiz; qo'shtirnoq semantikasi saqlanadi.
  return String(text).replace(/([A-Za-zÀ-ž])[‘’ʻʼ`´']([A-Za-zÀ-ž])/g, '$1‘$2');
}

function spokenUrl(raw) {
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\.(com|uz|org|net|io|ai)\b/gi, (_, domain) => ` nuqta ${domain}`)
    .replace(/\//g, ' slesh ')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function expandAbbreviations(text) {
  let output = text.replace(/\bWi[ -]?Fi\b/gi, ABBREVIATIONS.WiFi);
  for (const [short, spoken] of Object.entries(ABBREVIATIONS)) {
    if (short === 'WiFi') continue;
    output = output.replace(new RegExp(`\\b${short}\\b`, 'g'), spoken);
  }
  return output;
}

function normalizeUzbekSpeech(input, options = {}) {
  const settings = {
    expandAbbreviations: options.expandAbbreviations !== false,
    expandUrls: options.expandUrls !== false
  };
  let text = normalizeApostrophes(String(input ?? '')).replace(/\s+/g, ' ').trim();
  if (!text) return '';

  // Murakkab formatlar oddiy sonlardan oldin qayta ishlanishi shart.
  text = text.replace(/\b(0?[1-9]|[12]\d|3[01])[.\/-](0?[1-9]|1[0-2])[.\/-](\d{4})\b/g,
    (_, day, month, year) => `${ordinalToUzbek(day)} ${MONTHS[Number(month)]}, ${ordinalToUzbek(year)} yil`);
  text = text.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g,
    (_, hour, minute) => Number(minute) === 0
      ? integerToUzbek(hour)
      : `${integerToUzbek(hour)}-u ${integerToUzbek(minute)}`);
  text = text.replace(/\$\s?(\d[\d ]*(?:[.,]\d+)?)/g, (_, amount) => `${normalizeNumberToken(amount)} AQSh dollari`);
  text = text.replace(/\b(\d[\d ]*(?:[.,]\d+)?)\s?(USD|EUR|UZS)\b/g, (_, amount, currency) => {
    const names = { USD: 'AQSh dollari', EUR: 'yevro', UZS: 'so‘m' };
    return `${normalizeNumberToken(amount)} ${names[currency]}`;
  });
  text = text.replace(/\b(\d+(?:[.,]\d+)?)\s?%/g, (_, amount) => `${normalizeNumberToken(amount)} foiz`);
  text = text.replace(/\bfoiz\s+(ga|dan|ni|ning|da)\b/gi, 'foiz$1');
  if (settings.expandUrls) text = text.replace(/\b(?:https?:\/\/|www\.)[^\s,;]+/gi, spokenUrl);
  text = text.replace(/\b\d+[.,]\d+\b/g, token => normalizeNumberToken(token));
  // Telefon/ID kabi uzun uzluksiz raqamni ulkan son emas, raqamlab o'qiymiz.
  text = text.replace(/\b\d{7,}\b/g, digitsToUzbek);
  text = text.replace(/\b\d{1,6}\b/g, integerToUzbek);
  if (settings.expandAbbreviations) text = expandAbbreviations(text);
  return text.replace(/\s+([,.;!?])/g, '$1').replace(/\s+/g, ' ').trim();
}

function normalizeNumberToken(token) {
  const compact = String(token).replace(/\s+/g, '').replace(',', '.');
  const [whole, fraction] = compact.split('.');
  if (fraction === undefined) return integerToUzbek(whole);
  return `${integerToUzbek(whole)} butun ${digitsToUzbek(fraction)}`;
}

function voiceStyleInstructions(profile = 'cinematic-uzbek') {
  if (profile === 'default') return '';
  return [
    'OVOZ PROFILI — CINEMATIC UZBEK:',
    '- Cedar tembrini vazmin, ishonchli va kino JARVISiga yaqin saqlang, lekin sun’iy dramatik pauza qilmang.',
    '- O‘zbekcha urg‘uni ishlating; inglizcha gap ohangi yoki cho‘zib aytishga o‘tib ketmang.',
    '- O‘ va g‘ ni bitta yaxlit o‘zbek tovushi sifatida, q ni chuqur, x ni qattiq, h ni yumshoq va aniq ayting.',
    '- So‘zlarni uzib-uzib emas, ma’no guruhlarida ravon bog‘lang; vergulda yengil, nuqtada qisqa pauza qiling.',
    '- Son, vaqt, sana, foiz va harflab yozilgan texnik qisqartmalarni o‘zbekcha ritmda ravshan o‘qing.',
    '- Ruscha yoki inglizcha atama qatnashsa ham butun jumlaning o‘zbekcha ohangini saqlang.',
    '- Javobni qayta yozmang va talaffuz qoidalarini ovoz chiqarib sharhlamang.'
  ].join('\n');
}

module.exports = {
  ABBREVIATIONS,
  integerToUzbek,
  normalizeApostrophes,
  normalizeUzbekSpeech,
  ordinalToUzbek,
  voiceStyleInstructions
};