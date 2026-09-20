'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { recordHighRiskCompletion } = require('../core/autonomous-action-audit');

test('audit records successful high-risk action and reports it after completion', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-audit-'));
  const file = path.join(directory, 'autonomous-actions.log');
  const notices = [];
  const event = await recordHighRiskCompletion({
    alwaysConfirm: true, category: 'external-communication', kind: 'task', id: 'send-email',
    description: 'Send email token=super-secret-value'
  }, { source: 'voice', requestId: 'request-1' }, {
    file, notifyTelegram: async text => { notices.push(text); return true; }
  });
  assert.equal(event.category, 'external-communication');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.equal(saved.context.source, 'voice');
  assert.doesNotMatch(saved.action.description, /super-secret-value/);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^✅ Bajarildi:/);
});