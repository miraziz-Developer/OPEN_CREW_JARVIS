'use strict';

/**
 * macOS communication and media primitives.
 *
 * This module deliberately uses fixed executables with argument arrays. It
 * never builds a shell command from a contact name, phone number, or message.
 * WhatsApp is draft-only: macOS has no stable official API for silently
 * sending a WhatsApp message, so the user retains the final Send control.
 */
const { execFile } = require('child_process');

const MAX_QUERY_LENGTH = 180;
const MAX_MESSAGE_LENGTH = 4000;
const CONTACT_LOOKUP_JXA = `
ObjC.import('Foundation');
function env(name) { var v = $.NSProcessInfo.processInfo.environment.objectForKey(name); return v ? ObjC.unwrap(v) : ''; }
function norm(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9à-ž]+/g, ' ').trim(); }
var query = norm(env('JARVIS_CONTACT_QUERY'));
var people = Application('Contacts').people();
var matches = [];
for (var i = 0; i < people.length && matches.length < 10; i++) {
  var person = people[i];
  var name = String(person.name());
  if (!query || norm(name).indexOf(query) === -1) continue;
  var phones = person.phones().map(function(phone) { return String(phone.value()); }).filter(Boolean);
  var emails = person.emails().map(function(email) { return String(email.value()); }).filter(Boolean);
  matches.push({ name: name, phones: phones, emails: emails });
}
JSON.stringify(matches);
`;

function cleanText(value, label, maxLength) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(`${label} kerak`);
  if (text.length > maxLength) throw new Error(`${label} juda uzun (maksimum ${maxLength})`);
  return text;
}

function normalizePhone(value, defaultCountryCode = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let number = raw.replace(/[\s().-]/g, '');
  if (number.startsWith('00')) number = '+' + number.slice(2);
  if (!number.startsWith('+') && defaultCountryCode) {
    const country = String(defaultCountryCode).replace(/\D/g, '');
    number = '+' + country + number.replace(/^0+/, '');
  }
  if (!/^\+[1-9]\d{7,14}$/.test(number)) return null;
  return number;
}

function buildYouTubeSearchUrl(query) {
  const clean = cleanText(query, 'YouTube qidiruv so‘rovi', MAX_QUERY_LENGTH);
  const url = new URL('https://www.youtube.com/results');
  url.searchParams.set('search_query', clean);
  return url.toString();
}

function buildWhatsAppDraftUrl(phone, message, options = {}) {
  const normalizedPhone = normalizePhone(phone, options.defaultCountryCode);
  if (!normalizedPhone) throw new Error('WhatsApp uchun E.164 telefon raqami kerak');
  const cleanMessage = cleanText(message, 'Xabar', MAX_MESSAGE_LENGTH);
  const url = new URL('https://wa.me/' + normalizedPhone.slice(1));
  url.searchParams.set('text', cleanMessage);
  return url.toString();
}

function buildFaceTimeUrl(phone, options = {}) {
  const normalizedPhone = normalizePhone(phone, options.defaultCountryCode);
  if (!normalizedPhone) throw new Error('FaceTime uchun E.164 telefon raqami kerak');
  return 'facetime://' + encodeURIComponent(normalizedPhone);
}

function openUrl(url, options = {}) {
  const exec = options.execFile || execFile;
  return new Promise((resolve, reject) => {
    exec('open', [url], error => error ? reject(error) : resolve());
  });
}

function searchYouTube(query, options = {}) {
  const url = buildYouTubeSearchUrl(query);
  return openUrl(url, options).then(() => ({ status: 'ok', kind: 'youtube-search', url, message: 'YouTube qidiruvi ochildi.' }));
}

function lookupContact(query, options = {}) {
  const cleanQuery = cleanText(query, 'Kontakt qidiruvi', 100);
  const exec = options.execFile || execFile;
  return new Promise((resolve, reject) => {
    exec('osascript', ['-l', 'JavaScript', '-e', CONTACT_LOOKUP_JXA], {
      env: { ...process.env, JARVIS_CONTACT_QUERY: cleanQuery },
      maxBuffer: 1024 * 1024
    }, (error, stdout) => {
      if (error) return reject(new Error('Contacts qidiruvi bajarilmadi: ' + String(error.message || error).slice(0, 180)));
      try {
        const contacts = JSON.parse(String(stdout || '[]'));
        resolve(Array.isArray(contacts) ? contacts.slice(0, 10) : []);
      } catch (parseError) {
        reject(new Error('Contacts javobi noto‘g‘ri formatda'));
      }
    });
  });
}

async function openWhatsAppDraft(input = {}, options = {}) {
  const url = buildWhatsAppDraftUrl(input.phone, input.message, options);
  await openUrl(url, options);
  return { status: 'ok', kind: 'whatsapp-draft', url, message: 'WhatsApp draft ochildi; yuborish tugmasini siz bosasiz.' };
}

async function startFaceTimeCall(input = {}, options = {}) {
  if (input.confirmed !== true) {
    return { status: 'confirmation_required', kind: 'facetime-call', message: 'Qo‘ng‘iroq boshlashdan oldin aynan shu kontakt uchun tasdiq kerak.' };
  }
  const url = buildFaceTimeUrl(input.phone, options);
  await openUrl(url, options);
  return { status: 'ok', kind: 'facetime-call', url, message: 'FaceTime qo‘ng‘irog‘i boshlandi.' };
}

function parseCommunicationIntent(text) {
  const value = String(text || '').trim().replace(/\s+/g, ' ');
  const youtube = value.match(/^(?:youtube|yutub)(?:\s+da)?\s+(.+?)(?:ni)?\s+(?:qidir|izla)(?:b(?:er|ering))?$/i) ||
    value.match(/^(?:search|find)\s+(?:youtube\s+for\s+)?(.+?)\s+on youtube$/i);
  if (youtube && youtube[1]) return { kind: 'youtube-search', query: youtube[1].trim() };
  return null;
}

module.exports = {
  MAX_QUERY_LENGTH, MAX_MESSAGE_LENGTH, CONTACT_LOOKUP_JXA,
  cleanText, normalizePhone, buildYouTubeSearchUrl, buildWhatsAppDraftUrl,
  buildFaceTimeUrl, openUrl, searchYouTube, lookupContact, openWhatsAppDraft,
  startFaceTimeCall, parseCommunicationIntent
};