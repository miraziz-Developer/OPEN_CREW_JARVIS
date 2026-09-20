'use strict';

const { boundedCall } = require('./bounded-call');
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const cleanEmail = value => String(value || '').trim().toLowerCase();

function createGmailTaskNotifier(options = {}) {
  const env = options.env || (() => '');
  const enabled = options.enabled ?? /^(true|1|yes|on)$/i.test(String(env('GMAIL_TASK_NOTIFICATIONS_ENABLED') || 'false'));
  const ownerRecipient = cleanEmail(options.ownerRecipient ?? env('GMAIL_OWNER_RECIPIENT'));
  const cadenceMs = Math.max(60000, Number(options.cadenceMs ?? env('GMAIL_TASK_PROGRESS_MS')) || 21600000);
  const gmail = options.gmail || require('../skills/gmail');
  const timeoutMs = options.timeoutMs || 15000;

  function configured() { return enabled && EMAIL.test(ownerRecipient); }
  function taskLabel(task) { return String(task?.request || task?.id || 'Persistent task').replace(/\s+/g, ' ').slice(0, 300); }

  async function notify(kind, task, detail = '') {
    if (!configured()) return { sent: false, reason: 'disabled_or_owner_unconfigured' };
    const subject = `[Jarvis] Task ${kind}: ${String(task?.id || 'unknown')}`;
    const body = [
      `Task: ${taskLabel(task)}`,
      `Status: ${task?.status || kind}`,
      detail ? `Details: ${String(detail).slice(0, 4000)}` : '',
      task?.updatedAt ? `Updated: ${task.updatedAt}` : ''
    ].filter(Boolean).join('\n');
    const result = await boundedCall(() => gmail.sendMessage(ownerRecipient, subject, body), timeoutMs);
    if (result?.status !== 'ok') throw new Error(result?.message || 'Gmail task notification was not sent');
    return { sent: true, recipient: ownerRecipient, id: result.id };
  }

  async function notifyProgress(task, detail, now = Date.now()) {
    const previous = Date.parse(task?.lastEmailProgressAt || '');
    if (Number.isFinite(previous) && now - previous < cadenceMs) return { sent: false, reason: 'cadence' };
    const result = await notify('progress', task, detail);
    if (result.sent) task.lastEmailProgressAt = new Date(now).toISOString();
    return result;
  }

  async function summarizeInbox(options = {}) {
    if (!configured()) return { status: 'disabled', messages: [] };
    const limit = Math.max(1, Math.min(20, Math.floor(Number(options.maxResults)) || 10));
    const response = await boundedCall(() => gmail.listMessages(options.query || 'in:inbox is:unread (label:important OR category:primary)', limit), timeoutMs);
    if (response.status !== 'ok') return response;
    return { status: 'ok', messages: response.messages.map(message => ({
      from: message.from, subject: message.subject, date: message.date,
      summary: String(message.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 280), unread: Boolean(message.unread)
    })) };
  }

  return { configured, ownerRecipient, cadenceMs, notify, notifyProgress, summarizeInbox };
}

module.exports = { createGmailTaskNotifier, EMAIL };