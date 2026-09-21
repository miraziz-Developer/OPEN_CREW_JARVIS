'use strict';

const WAKE_ALIASES = Object.freeze([
  'jarvis', 'jarviz', 'jervis', 'djervis', 'yarvis', 'jorvis', 'djarvis',
  'charvis', 'jarv', 'hey jarvis', 'hey jervis',
  // Server transkripsiyasi "Jarvis" ni ba'zan shunday yozadi
  'jarves', 'jarvas', 'jarvish', 'gervis', 'jervas', 'jarvice', 'jarvi', 'hey jarves'
]);

function normalizeWakeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isWakePhrase(text) {
  const normalized = normalizeWakeText(text);
  if (!normalized) return false;
  const compact = normalized.replace(/\s+/g, '');
  return WAKE_ALIASES.some(alias => {
    const normalizedAlias = alias.replace(/\s+/g, ' ');
    return normalized.includes(normalizedAlias) || compact.includes(normalizedAlias.replace(/\s+/g, ''));
  });
}

function extractAddressedCommand(text) {
  const normalized = normalizeWakeText(text);
  if (!normalized) return null;
  const aliases = [...WAKE_ALIASES].sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const match = normalized.match(new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`));
    if (!match) continue;
    // Wake phrase boshida ham, oxirida ham kelishi mumkin. Avval faqat undan
    // keyingi matn olinardi; "What happened, Jarvis?" shu sabab wake-only deb
    // noto'g'ri bloklanardi. Aliasning ikki tomonidagi mazmunni saqlaymiz.
    const before = normalized.slice(0, match.index).trim();
    const after = normalized.slice(match.index + match[0].length).trim();
    return { addressed: true, wake: alias, command: [before, after].filter(Boolean).join(' ') };
  }
  return null;
}

function findWakeRecognition(results) {
  const recognized = (Array.isArray(results) ? results : []).filter(result =>
    result && result.status === 'ok' && result.text
  );
  const direct = recognized.find(result =>
    result && result.status === 'ok' && result.text && isWakePhrase(result.text)
  );
  if (direct) return direct;

  // Real Mac microphone evidence: the same accented "Hey Jarvis" segment was
  // decoded as en-US "Salome" and uz-UZ "Salom men tuman". Neither weak
  // hypothesis is safe alone (ordinary "salom" must not wake Jarvis), but the
  // two independent decoders producing this specific pair is a useful
  // cross-locale phonetic fingerprint.
  const texts = recognized.map(result => normalizeWakeText(result.text));
  const englishFingerprint = texts.some(text => /^(?:salome|salomi)$/.test(text));
  const uzbekFingerprint = texts.some(text => /^salom\s+men\s+\S+/.test(text));
  if (englishFingerprint && uzbekFingerprint) {
    return { ...recognized[0], text: 'Hey Jarvis', source: 'cross-locale-phonetic' };
  }
  return null;
}

module.exports = { normalizeWakeText, isWakePhrase, extractAddressedCommand, findWakeRecognition };