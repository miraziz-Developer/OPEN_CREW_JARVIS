'use strict';

/**
 * Telegram xabarlarini qisqa va tushunarli qiladi: tozalash, takrorlarni tashlash, progressni siyraklash,
 * uzun matnni "nima bo'ldi / natija / sizdan nima kerak" ko'rinishiga keltirish. Faqat tizim boshlagan xabarlarga qo'llanadi.
 */
const EMOJI_LEAD = /^\s*((?:\p{Extended_Pictographic}️?)+)\s*/u;

const CONDENSE_SYSTEM =
  'You rewrite a long automated notification for a phone lock screen. Rules: at most 3 short lines and under 300 characters in total; plain everyday words; ' +
  'first line = the outcome or the point; then only what needs the user\'s attention or decision; if nothing needs the user, say "Nothing needed from you."; ' +
  'no markdown, no code, no IDs, no jargon, no filler; never invent facts; keep numbers and names that matter.';

function cleanText(text) {
  let value = String(text ?? '');
  value = value.replace(/```[\s\S]*?```/g, ' [code omitted] ');
  value = value.replace(/^\s*[{[][\s\S]*[}\]]\s*$/, match => { try { JSON.parse(match); return 'Structured result received.'; } catch (_) { return match; } });
  value = value.replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/(^|\s)#{1,6}\s+/g, '$1');
  value = value.replace(/^\s*[-*•]\s+/gm, '• ').replace(/^\s*\d+[.)]\s+/gm, '• ');
  value = value.replace(/\bagent:main:[\w:.-]+/g, '').replace(/\b[a-f0-9]{16,}\b/g, '');
  value = value.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return value;
}

function deterministicBrief(text, max = 320) {
  const value = cleanText(text).replace(/\n+/g, ' ');
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '') + '…').trim();
}

class TelegramBrief {
  constructor(options = {}) {
    this.llm = options.llm || null;
    this.now = options.now || Date.now;
    this.mirrorVoice = Boolean(options.mirrorVoice);
    this.longThreshold = options.longThreshold || 520;
    this.dedupeMs = options.dedupeMs || 30 * 60000;
    this.progressGapMs = options.progressGapMs || 15 * 60000;
    this.disconnectGapMs = options.disconnectGapMs || 60 * 60000;
    this.recent = new Map();
    this.lastProgressAt = null;
    this.lastDisconnectAt = null;
  }

  _maxFor(text) {
    if (/^\s*(?:📊|🧠|📁)/u.test(text)) return 560;      // hisobotlar biroz kengroq
    if (/^\s*⏳/u.test(text)) return 140;
    return 340;
  }

  async prepare(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const at = this.now();

    // Ovozli suhbatning har bir gapini Telegramga nusxalash — yolg'on shovqin (TELEGRAM_MIRROR_VOICE=true bilan yoqiladi).
    if (/^\s*(?:🎙|🤖)/u.test(raw) && !this.mirrorVoice) return null;
    if (/^\s*⏳/u.test(raw)) {
      if (this.lastProgressAt !== null && at - this.lastProgressAt < this.progressGapMs) return null;
      this.lastProgressAt = at;
    }
    if (/voice session disconnected/i.test(raw)) {
      if (this.lastDisconnectAt !== null && at - this.lastDisconnectAt < this.disconnectGapMs) return null;
      this.lastDisconnectAt = at;
    }

    const body = cleanText(raw);
    const key = body.toLowerCase().replace(/\W+/g, ' ').slice(0, 200);
    for (const [k, when] of this.recent) if (at - when > this.dedupeMs) this.recent.delete(k);
    if (this.recent.has(key)) return null;
    this.recent.set(key, at);

    const max = this._maxFor(raw);
    if (body.length <= this.longThreshold && body.length <= max * 1.6) return body.length > max ? deterministicBrief(body, max) : body;

    const lead = EMOJI_LEAD.exec(raw)?.[1] || '';
    let brief = '';
    if (this.llm) {
      try {
        brief = cleanText(await this.llm.complete({
          system: CONDENSE_SYSTEM, user: body.slice(0, 6000), effort: 'minimal', maxOutputTokens: 500, timeoutMs: 12000, retries: 0
        }));
      } catch (_) { brief = ''; }
    }
    if (!brief) brief = deterministicBrief(body, max);
    if (brief.length > max * 1.6) brief = deterministicBrief(brief, max);
    return (lead && !EMOJI_LEAD.test(brief) ? `${lead} ` : '') + brief;
  }
}

module.exports = { TelegramBrief, cleanText, deterministicBrief };
