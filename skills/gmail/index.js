#!/usr/bin/env node
/**
 * GMAIL Skill — muhim/o'qilmagan xatlarni ko'rish, o'qilgan deb
 * belgilash, yangi xat yuborish. Ulanish uchun avval bir marta:
 *   node scripts/google-oauth-setup.js
 * Kirish (stdin JSON): { action: "list_messages"|"send_message"|"mark_read", ... }
 */

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = '/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS';
const { apiRequest, isConnected } = require(path.join(PROJECT_DIR, 'skills', 'google-auth'));

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

function headerVal(headers, name) {
  const h = (headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// ── Xatlarni ko'rish (default: o'qilmagan) ──────────────────────────────
async function listMessages(query, maxResults) {
  if (!isConnected()) return { status: 'error', message: "Google ulanmagan — avval: node scripts/google-oauth-setup.js" };
  const q = query || 'is:unread';
  const params = new URLSearchParams({ q, maxResults: String(maxResults || 10) });
  const listResp = await apiRequest('GET', GMAIL_BASE + '/messages?' + params.toString());
  const ids = (listResp.messages || []).map(m => m.id);
  const messages = [];
  for (const id of ids) {
    const m = await apiRequest('GET', GMAIL_BASE + '/messages/' + id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date');
    messages.push({
      id: m.id,
      from: headerVal(m.payload?.headers, 'From'),
      subject: headerVal(m.payload?.headers, 'Subject'),
      date: headerVal(m.payload?.headers, 'Date'),
      snippet: m.snippet || '',
      unread: (m.labelIds || []).includes('UNREAD')
    });
  }
  return { status: 'ok', messages };
}

// ── O'qilgan deb belgilash ────────────────────────────────────────────
async function markRead(id) {
  if (!id) return { status: 'error', message: 'id kerak' };
  await apiRequest('POST', GMAIL_BASE + '/messages/' + id + '/modify', { removeLabelIds: ['UNREAD'] });
  return { status: 'ok' };
}

function base64url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Xat yuborish ──────────────────────────────────────────────────────
async function sendMessage(to, subject, body) {
  if (!isConnected()) return { status: 'error', message: "Google ulanmagan — avval: node scripts/google-oauth-setup.js" };
  if (!to || !subject || !body) return { status: 'error', message: 'to, subject, body kerak' };
  const mime = [
    'To: ' + to,
    'Subject: =?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=',
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    body
  ].join('\r\n');
  const resp = await apiRequest('POST', GMAIL_BASE + '/messages/send', { raw: base64url(mime) });
  if (!resp.id) return { status: 'error', message: 'yuborilmadi: ' + JSON.stringify(resp) };
  return { status: 'ok', id: resp.id };
}

// ── CLI ───────────────────────────────────────────────────────────────
async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (e) {}
  let result;
  try {
    switch (input.action) {
      case 'list_messages': result = await listMessages(input.query, input.maxResults); break;
      case 'mark_read': result = await markRead(input.id); break;
      case 'send_message': result = await sendMessage(input.to, input.subject, input.body); break;
      default: result = { status: 'error', message: "Noma'lum action: " + input.action + ' (list_messages|mark_read|send_message)' };
    }
  } catch (e) {
    result = { status: 'error', message: e.message || String(e) };
  }
  console.log(JSON.stringify(result));
}

if (require.main === module) main();

module.exports = { listMessages, markRead, sendMessage };
