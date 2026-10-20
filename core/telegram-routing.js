'use strict';

// Detects Telegram requests that run immediately without the agent. It must stay narrow: a request combined
// with another action ("open Claude, then send a screenshot") must go to the agent.
function isPlainScreenshotRequest(text) {
  const value = String(text || '').trim();
  if (!/\b(?:skrinshot|screenshot|screen ?shot)\b/i.test(value)) return false;
  if (value.split(/\s+/).length > 6) return false;
  return !/\b(?:after|then|open|och|keyin|so'ng|va|and|of|from|in)\b/i.test(value);
}

module.exports = { isPlainScreenshotRequest };
