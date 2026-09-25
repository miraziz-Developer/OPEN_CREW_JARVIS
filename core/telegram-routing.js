'use strict';

// Telegram'da agentsiz darhol bajariladigan so'rovlarni aniqlash. Tor bo'lishi shart: boshqa amal bilan birga
// kelgan so'rov ("Claude'ni och, keyin skrinshot yubor") agentga borishi kerak.
function isPlainScreenshotRequest(text) {
  const value = String(text || '').trim();
  if (!/\b(?:skrinshot|screenshot|screen ?shot)\b/i.test(value)) return false;
  if (value.split(/\s+/).length > 6) return false;
  return !/\b(?:after|then|open|och|keyin|so'ng|va|and|of|from|in)\b/i.test(value);
}

module.exports = { isPlainScreenshotRequest };
