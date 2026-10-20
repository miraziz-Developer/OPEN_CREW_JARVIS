const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const YTDLP_BIN = [
  path.join(__dirname, '..', '.venv-openwakeword', 'bin', 'yt-dlp'),
  '/opt/homebrew/bin/yt-dlp',
  'yt-dlp'
].find(p => { try { return fs.existsSync(p); } catch(_) { return false; } }) || 'yt-dlp';

const q = s => encodeURIComponent(String(s || '').trim());
const run = (file, args, timeout) => new Promise((resolve, reject) =>
  execFile(file, args, { timeout, encoding: 'utf8', env: { ...process.env, SSL_CERT_FILE: process.env.SSL_CERT_FILE || '/etc/ssl/cert.pem' } }, (err, stdout) => err ? reject(err) : resolve(String(stdout || ''))));

// One-step web actions: done in seconds instead of starting the full agent.
// kind: youtube_play | youtube_search | google | maps | globe | url
async function resolveWebTarget({ kind, query, url }, { exec = run } = {}) {
  const text = String(query || '').trim();
  let k = String(kind || '').toLowerCase().trim();
  if (k.startsWith('web:')) k = k.slice(4);
  if (['gmaps', 'map', 'maps', 'location'].includes(k)) k = 'maps';
  if (['gsearch', 'search', 'google'].includes(k)) k = 'google';
  if (['yt', 'youtube', 'play', 'music'].includes(k)) k = 'youtube_play';
  if (['earth', 'globe', '3d_globe', 'gods_eye'].includes(k)) k = 'globe';

  switch (k) {
    case 'youtube_play': {
      if (!text) throw new Error('query is required');
      try {
        const id = (await exec(YTDLP_BIN, ['--no-warnings', '--flat-playlist', '--get-id', `ytsearch1:${text}`], 9000)).trim().split('\n')[0];
        if (/^[\w-]{11}$/.test(id)) return { url: `https://www.youtube.com/watch?v=${id}&autoplay=1`, said: `Playing ${text} on YouTube.`, media: true };
      } catch (_) { /* qidiruv sahifasiga tushamiz */ }
      return { url: `https://www.youtube.com/results?search_query=${q(text)}`, said: `Opened YouTube results for ${text}.`, media: true };
    }
    case 'youtube_search': return { url: `https://www.youtube.com/results?search_query=${q(text)}`, said: `Opened YouTube results for ${text}.` };
    case 'google': return { url: `https://www.google.com/search?q=${q(text)}`, said: `Searching Google for ${text}.` };
    case 'maps': return { url: `https://www.google.com/maps/search/${q(text)}`, said: `Opened Maps for ${text}.` };
    case 'globe': return { url: `https://earth.google.com/web/search/${q(text)}`, said: `Opened 3D satellite view for ${text}.` };
    case 'url': {
      let u;
      try { u = new URL(/^[a-z]+:\/\//i.test(url) ? url : 'https://' + url); } catch (_) { throw new Error('invalid URL'); }
      if (!/^https?:$/.test(u.protocol)) throw new Error('only http/https');
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
