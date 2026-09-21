'use strict';

const { execFile } = require('child_process');

const q = s => encodeURIComponent(String(s || '').trim());
const run = (file, args, timeout) => new Promise((resolve, reject) =>
  execFile(file, args, { timeout, encoding: 'utf8' }, (err, stdout) => err ? reject(err) : resolve(String(stdout || ''))));

// Bir qadamlik veb-amallar: to'liq agent o'rniga soniyalarda bajariladi.
// kind: youtube_play | youtube_search | google | maps | url
async function resolveWebTarget({ kind, query, url }, { exec = run } = {}) {
  const text = String(query || '').trim();
  switch (kind) {
    case 'youtube_play': {
      if (!text) throw new Error('query kerak');
      try {
        const id = (await exec('yt-dlp', ['--no-warnings', '--flat-playlist', '--get-id', `ytsearch1:${text}`], 9000)).trim().split('\n')[0];
        if (/^[\w-]{11}$/.test(id)) return { url: `https://www.youtube.com/watch?v=${id}&autoplay=1`, said: `Playing ${text} on YouTube.`, media: true };
      } catch (_) { /* qidiruv sahifasiga tushamiz */ }
      return { url: `https://www.youtube.com/results?search_query=${q(text)}`, said: `Opened YouTube results for ${text}.`, media: true };
    }
    case 'youtube_search': return { url: `https://www.youtube.com/results?search_query=${q(text)}`, said: `Opened YouTube results for ${text}.` };
    case 'google': return { url: `https://www.google.com/search?q=${q(text)}`, said: `Searching Google for ${text}.` };
    case 'maps': return { url: `https://www.google.com/maps/search/${q(text)}`, said: `Opened Maps for ${text}.` };
    case 'url': {
      let u;
      try { u = new URL(/^[a-z]+:\/\//i.test(url) ? url : 'https://' + url); } catch (_) { throw new Error('URL noto‘g‘ri'); }
      if (!/^https?:$/.test(u.protocol)) throw new Error('faqat http/https');
      return { url: u.toString(), said: `Opened ${u.hostname}.` };
    }
    default: throw new Error('noma’lum kind');
  }
}

async function openWeb(args, { exec = run, opener = (u) => run('open', [u], 5000) } = {}) {
  const target = await resolveWebTarget(args, { exec });
  await opener(target.url);
  return target;
}

module.exports = { resolveWebTarget, openWeb };
