#!/usr/bin/env node
/**
 * GOOGLE CALENDAR skill: view upcoming events and create new events or reminders.
 * Connect once first:
 *   node scripts/google-oauth-setup.js
 * Input (stdin JSON): { action: "list_events"|"create_event", ... }
 */

const fs = require('fs');
const path = require('path');

const { PROJECT_DIR } = require('../../core/paths');
let ENV = ''; try { ENV = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (_) {}
function env(k, def) { const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : def; }
const TIMEZONE = env('TIMEZONE') || Intl.DateTimeFormat().resolvedOptions().timeZone;

const { apiRequest, isConnected } = require(path.join(PROJECT_DIR, 'skills', 'google-auth'));

const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

// ── Upcoming events (default: the next 7 days) ─────────────────────────
async function listEvents(days = 7, maxResults = 20) {
  if (!isConnected()) return { status: 'error', message: 'Google is not connected; first run: node scripts/google-oauth-setup.js' };
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + days * 86400000).toISOString();
  const params = new URLSearchParams({
    timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: String(maxResults)
  });
  const resp = await apiRequest('GET', CAL_BASE + '?' + params.toString());
  const events = (resp.items || []).map(e => ({
    id: e.id,
    title: e.summary || '(nomsiz)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location || null,
    description: e.description || null
  }));
  return { status: 'ok', events };
}

// ── Create an event or reminder ─────────────────────────────────────────
// start/end: ISO time ("2026-08-15T10:00:00"), interpreted in the local timezone
// (TIMEZONE, or the Mac's timezone).
async function createEvent(title, start, end, description) {
  if (!isConnected()) return { status: 'error', message: 'Google is not connected; first run: node scripts/google-oauth-setup.js' };
  if (!title || !start) return { status: 'error', message: 'title and start are required' };
  const endTime = end || new Date(new Date(start).getTime() + 30 * 60000).toISOString().slice(0, 19);
  const body = {
    summary: title,
    description: description || undefined,
    start: { dateTime: start, timeZone: TIMEZONE },
    end: { dateTime: endTime, timeZone: TIMEZONE }
  };
  const resp = await apiRequest('POST', CAL_BASE, body);
  if (!resp.id) return { status: 'error', message: 'yaratilmadi: ' + JSON.stringify(resp) };
  return { status: 'ok', id: resp.id, link: resp.htmlLink };
}

// ── CLI ───────────────────────────────────────────────────────────────
async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (e) {}
  let result;
  try {
    switch (input.action) {
      case 'list_events': result = await listEvents(input.days, input.maxResults); break;
      case 'create_event': result = await createEvent(input.title, input.start, input.end, input.description); break;
      default: result = { status: 'error', message: "Noma'lum action: " + input.action + ' (list_events|create_event)' };
    }
  } catch (e) {
    result = { status: 'error', message: e.message || String(e) };
  }
  console.log(JSON.stringify(result));
}

if (require.main === module) main();

module.exports = { listEvents, createEvent };
