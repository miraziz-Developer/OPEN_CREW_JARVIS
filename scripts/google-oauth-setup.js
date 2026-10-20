#!/usr/bin/env node
/**
 * GOOGLE OAUTH SETUP: one-time interactive connection script that grants
 * Google Calendar + Gmail access (read, write, send). The user signs in to their
 * Google account in the browser once and approves; JARVIS stores the refresh
 * token and from then on works in the background without asking again.
 *
 * Usage: node scripts/google-oauth-setup.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const { PROJECT_DIR } = require('../core/paths');
const ENV_PATH = path.join(PROJECT_DIR, '.env');

// Imports the client_secret*.json downloaded from Google Console into .env (no manual copying):
//   node scripts/google-oauth-setup.js --client-file ~/Downloads/client_secret_XXXX.json
// Without a file argument and with no key in .env, the newest client_secret*.json in ~/Downloads is used.
function importClientFile() {
  const os = require('os');
  const argIndex = process.argv.indexOf('--client-file');
  let file = argIndex > 0 ? process.argv[argIndex + 1] : null;
  const current = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const hasKeys = /^GOOGLE_OAUTH_CLIENT_ID=.+/m.test(current) && /^GOOGLE_OAUTH_CLIENT_SECRET=.+/m.test(current);
  if (!file && hasKeys) return;
  if (!file) {
    const dir = path.join(os.homedir(), 'Downloads');
    try {
      file = fs.readdirSync(dir).filter(n => /^client_secret.*\.json$/i.test(n))
        .map(n => path.join(dir, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    } catch (_) {}
  }
  if (!file) return;
  const parsed = JSON.parse(fs.readFileSync(file.replace(/^~/, os.homedir()), 'utf8'));
  const client = parsed.installed || parsed.web;
  if (!client?.client_id || !client?.client_secret) throw new Error('client_id/client_secret not found in the client_secret JSON');
  let env = current;
  for (const [key, value] of [['GOOGLE_OAUTH_CLIENT_ID', client.client_id], ['GOOGLE_OAUTH_CLIENT_SECRET', client.client_secret]]) {
    env = new RegExp('^' + key + '=', 'm').test(env) ? env.replace(new RegExp('^' + key + '=.*$', 'm'), key + '=' + value) : env.replace(/\n?$/, '\n') + key + '=' + value + '\n';
  }
  fs.writeFileSync(ENV_PATH, env, { mode: 0o600 });
  console.log('✅ OAuth keys imported into .env (' + path.basename(file) + ')');
}
try { importClientFile(); } catch (error) { console.error('❌ Import error:', error.message); process.exit(1); }

const ENV = fs.readFileSync(ENV_PATH, 'utf8');
function env(k, def) { const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : def; }

const CLIENT_ID = env('GOOGLE_OAUTH_CLIENT_ID');
const CLIENT_SECRET = env('GOOGLE_OAUTH_CLIENT_SECRET');
const TOKENS_FILE = path.join(PROJECT_DIR, '.google-tokens.json');
const PORT = 8721;
const REDIRECT_URI = 'http://127.0.0.1:' + PORT + '/oauth/callback';

// Full access: calendar (read+write) and Gmail (read+write+send, but no permanent
// deletion: gmail.modify enforces that).
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET topilmadi.\n   Google Cloud Console > APIs & Services > Credentials > Create credentials > OAuth client ID (Desktop app),\n   JSON ni yuklab oling, so\'ng: node scripts/google-oauth-setup.js --client-file ~/Downloads/client_secret_XXXX.json');
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
      res.end('<h2>Cancelled: ' + errParam + '</h2>You can close this window.');
      console.error('❌ The user declined or an error occurred:', errParam);
      server.close(); process.exit(1);
      return;
    }
    if (!code) { res.writeHead(400); res.end('code not found'); return; }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>✅ Done! JARVIS is now connected.</h2>You can close this window and return to the terminal.');

    try {
      const tokenResp = await postJson('https://oauth2.googleapis.com/token', {
        code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI, grant_type: 'authorization_code'
      });
      if (tokenResp.error) throw new Error(tokenResp.error_description || tokenResp.error);
      if (!tokenResp.refresh_token) {
        console.error('⚠️  No refresh_token returned; access was probably granted before. Remove "Jarvis Desktop" under Google Account > Security > Third-party access and try again.');
        server.close(); process.exit(1);
        return;
      }
      fs.writeFileSync(TOKENS_FILE, JSON.stringify({
        refresh_token: tokenResp.refresh_token,
        access_token: tokenResp.access_token,
        expiry_date: Date.now() + (tokenResp.expires_in || 3600) * 1000,
        scope: tokenResp.scope
      }, null, 2), { mode: 0o600 });
      console.log('✅ Connected! Token saved: ' + TOKENS_FILE);
      console.log('   Scopes:', tokenResp.scope);
    } catch (e) {
      console.error('❌ Token exchange error:', e.message);
    }
    server.close();
    setTimeout(() => process.exit(0), 500);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log('🌐 Opening the link below in your browser (automatically)...');
    console.log(authUrl);
    console.log('\nIf it does not open automatically, paste the link above into your browser.');
    try { execSync('open "' + authUrl + '"'); } catch (e) {}
  });

  setTimeout(() => {
    console.error('⏱️  No response within 5 minutes; cancelled.');
    try { server.close(); } catch (e) {}
    process.exit(1);
  }, 5 * 60 * 1000);
}

main();
