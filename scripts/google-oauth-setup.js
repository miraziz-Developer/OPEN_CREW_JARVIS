#!/usr/bin/env node
/**
 * GOOGLE OAUTH SETUP — bir martalik interaktiv ulanish skripti.
 * Google Calendar + Gmail'ga (o'qish+yozish+yuborish) ruxsat olish uchun.
 * Foydalanuvchi brauzerda bir marta Google akkountiga kirib "ruxsat
 * beraman" deydi, keyin Jarvis olgan "refresh token"ni saqlab qoladi —
 * shundan keyin har safar qayta so'ramasdan, fon rejimida ishlayveradi.
 *
 * Ishlatish: node scripts/google-oauth-setup.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const PROJECT_DIR = '/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS';
const ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8');
function env(k, def) { const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : def; }

const CLIENT_ID = env('GOOGLE_OAUTH_CLIENT_ID');
const CLIENT_SECRET = env('GOOGLE_OAUTH_CLIENT_SECRET');
const TOKENS_FILE = path.join(PROJECT_DIR, '.google-tokens.json');
const PORT = 8721;
const REDIRECT_URI = 'http://127.0.0.1:' + PORT + '/oauth/callback';

// To'liq ruxsat: kalendar (o'qish+yozish) va gmail (o'qish+yozish+yuborish,
// lekin butunlay o'chirish emas — gmail.modify shuni chegaralaydi).
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET .env faylida topilmadi');
  process.exit(1);
}

function postJson(url, formBody) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(formBody).toString();
    const u = new URL(url);
    const req = https.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent'
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

async function main() {
  const authUrl = buildAuthUrl();

  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/oauth/callback')) { res.writeHead(404); res.end(); return; }
    const u = new URL(req.url, 'http://127.0.0.1:' + PORT);
    const code = u.searchParams.get('code');
    const errParam = u.searchParams.get('error');

    if (errParam) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Bekor qilindi: ' + errParam + '</h2>Bu oynani yopishingiz mumkin.');
      console.error('❌ Foydalanuvchi rad etdi yoki xatolik:', errParam);
      server.close(); process.exit(1);
      return;
    }
    if (!code) { res.writeHead(400); res.end('kod topilmadi'); return; }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>✅ Tayyor! Jarvis endi ulandi.</h2>Bu oynani yopishingiz mumkin, terminalga qayting.');

    try {
      const tokenResp = await postJson('https://oauth2.googleapis.com/token', {
        code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI, grant_type: 'authorization_code'
      });
      if (tokenResp.error) throw new Error(tokenResp.error_description || tokenResp.error);
      if (!tokenResp.refresh_token) {
        console.error('⚠️  refresh_token kelmadi — ehtimol avval ruxsat berilgan. Google Account > Security > Third-party access\'dan "Jarvis Desktop"ni olib tashlab, qayta urinib ko\'ring.');
        server.close(); process.exit(1);
        return;
      }
      fs.writeFileSync(TOKENS_FILE, JSON.stringify({
        refresh_token: tokenResp.refresh_token,
        access_token: tokenResp.access_token,
        expiry_date: Date.now() + (tokenResp.expires_in || 3600) * 1000,
        scope: tokenResp.scope
      }, null, 2), { mode: 0o600 });
      console.log('✅ Muvaffaqiyatli ulandi! Token saqlandi: ' + TOKENS_FILE);
      console.log('   Ruxsatlar:', tokenResp.scope);
    } catch (e) {
      console.error('❌ Token almashtirishda xatolik:', e.message);
    }
    server.close();
    setTimeout(() => process.exit(0), 500);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log('🌐 Brauzerda quyidagi havola ochilmoqda (avtomatik)...');
    console.log(authUrl);
    console.log('\nAgar avtomatik ochilmasa, yuqoridagi havolani qo\'lda brauzerga qo\'ying.');
    try { execSync('open "' + authUrl + '"'); } catch (e) {}
  });

  setTimeout(() => {
    console.error('⏱️  5 daqiqa ichida javob kelmadi — bekor qilindi.');
    try { server.close(); } catch (e) {}
    process.exit(1);
  }, 5 * 60 * 1000);
}

main();
