#!/usr/bin/env node
/**
 * GOOGLE AUTH: a shared module (not a skill; used inside other skills). Always gets a
 * fresh access_token from the refresh_token obtained via `scripts/google-oauth-setup.js`
 * (refreshing automatically when needed; the user never has to sign in again).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const { PROJECT_DIR } = require('../../core/paths');
let ENV = ''; try { ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (_) {}
function env(k, def) { const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : def; }

const CLIENT_ID = env('GOOGLE_OAUTH_CLIENT_ID');
const CLIENT_SECRET = env('GOOGLE_OAUTH_CLIENT_SECRET');
const TOKENS_FILE = path.join(PROJECT_DIR, '.google-tokens.json');

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch (e) { return null; }
}
function saveTokens(t) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
}

function postForm(url, formBody) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(formBody).toString();
    const req = https.request(new URL(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// Always returns a WORKING access_token, refreshing it when needed (an access_token
// expires in ~1 hour; a refresh_token usually does not expire until the user revokes it).
async function getAccessToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error('Google is not connected; first run: node scripts/google-oauth-setup.js');
  }
  if (tokens.access_token && tokens.expiry_date && Date.now() < tokens.expiry_date - 60000) {
    return tokens.access_token;
  }
  const resp = await postForm('https://oauth2.googleapis.com/token', {
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    refresh_token: tokens.refresh_token, grant_type: 'refresh_token'
  });
  if (resp.error) throw new Error('Google token refresh error: ' + (resp.error_description || resp.error));
  tokens.access_token = resp.access_token;
  tokens.expiry_date = Date.now() + (resp.expires_in || 3600) * 1000;
  saveTokens(tokens);
  return tokens.access_token;
}

function isConnected() {
  const t = loadTokens();
  return !!(t && t.refresh_token);
}

// A Google REST API request with a ready Authorization header.
function apiRequest(method, url, body) {
  return getAccessToken().then(token => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Authorization': 'Bearer ' + token };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = https.request(new URL(url), { method, headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        let parsed;
        try { parsed = d ? JSON.parse(d) : {}; } catch (e) { parsed = { raw: d }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error('Google API error (' + res.statusCode + '): ' + (parsed.error?.message || d)));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  }));
}

module.exports = { getAccessToken, isConnected, apiRequest };
