'use strict';

/**
 * Qaysi "miya" ishlaydi:
 *  - audio            → Gemma 4 E2B (audioni faqat u tushunadi)
 *  - qiyin fikrlash   → Ternary Bonsai 2 27B (faqat matn; rasm → Qwen)
 *  - qolgan hammasi   → Qwen 3.5 9B (matn, asboblar va RASM — oddiy skrinshot uchun model almashtirilmaydi)
 */
const MODELS = {
  fast: { backend: 'ollama', model: process.env.BRAIN_FAST_MODEL || 'qwen3.5:9b' },
  audio: { backend: 'ollama', model: process.env.BRAIN_AUDIO_MODEL || 'gemma4:e2b' },
  hard: { backend: 'bonsai', model: 'bonsai2-27b' }
};

const HARD = /\b(architecture|architect|strategy|strategik|tradeoffs?|root cause|debug(?:ging)?|security review|implementation plan|system design|in[- ]depth|deep(?:ly)? (?:think|analy[sz]e)|think (?:hard|deeply|carefully)|step[- ]by[- ]step plan|multi[- ]?step plan|roadmap|research|analy[sz]e|analysis|tahlil|chuqur|rejalashtir|reja tuz|strategiya|prove|derive)\b/i;

function isHardTask(text = '') {
  const value = String(text);
  return value.length > 2500 || HARD.test(value);
}

function routeTask({ text = '', images = [], audio = [], hard } = {}) {
  if (audio && audio.length) return { ...MODELS.audio, reason: 'audio' };
  const wantsHard = hard === true || (hard !== false && isHardTask(text));
  if (wantsHard) return { ...MODELS.hard, reason: 'hard', fallback: MODELS.fast };
  return { ...MODELS.fast, reason: images && images.length ? 'image' : 'general' };
}

module.exports = { routeTask, isHardTask, MODELS };
