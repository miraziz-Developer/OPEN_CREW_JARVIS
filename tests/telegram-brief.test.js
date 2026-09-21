'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TelegramBrief, cleanText, deterministicBrief } = require('../core/telegram-brief');

function brief(options = {}) {
  let now = 1000000;
  const calls = [];
  const llm = options.llm === undefined ? { complete: async request => { calls.push(request); return '✅ Report written. Nothing needed from you.'; } } : options.llm;
  const instance = new TelegramBrief({ llm, now: () => now, ...options.config });
  return { instance, calls, tick: ms => { now += ms; } };
}

test('voice transcripts are not mirrored to Telegram unless explicitly enabled', async () => {
  const off = brief();
  assert.equal(await off.instance.prepare('🎙 what is the capital of france'), null);
  assert.equal(await off.instance.prepare('🤖 Paris.'), null);
  const on = brief({ config: { mirrorVoice: true } });
  assert.equal(await on.instance.prepare('🎙 hello'), '🎙 hello');
});

test('progress pings are rare and short, disconnect notices at most hourly, duplicates dropped', async () => {
  const { instance, tick } = brief();
  assert.ok(await instance.prepare('⏳ Working on step 1 of the long task, gathering files and checking them one by one for the report you asked for earlier today'));
  assert.equal(await instance.prepare('⏳ Working on step 2'), null);
  tick(16 * 60000);
  assert.ok(await instance.prepare('⏳ Working on step 3'));
  assert.ok(await instance.prepare('⚠️ The voice session disconnected unexpectedly.'));
  tick(5 * 60000);
  assert.equal(await instance.prepare('⚠️ The voice session disconnected unexpectedly.'), null);
  assert.ok(await instance.prepare('🚨 Disk almost full'));
  assert.equal(await instance.prepare('🚨 Disk almost full'), null);
  tick(31 * 60000);
  assert.ok(await instance.prepare('🚨 Disk almost full'));
});

test('short clear messages pass through unchanged (markdown stripped)', async () => {
  const { instance, calls } = brief();
  assert.equal(await instance.prepare('**Mission 2 is complete:** report saved.'), 'Mission 2 is complete: report saved.');
  assert.equal(calls.length, 0);
});

test('long messages are condensed by the LLM, keeping the leading emoji, and fall back to a clean cut when the LLM fails', async () => {
  const long = '📊 Today report:\n\n' + '## Details\n- Item one was processed with a lot of detail and internal identifiers agent:main:abc123. '.repeat(30);
  const withLlm = brief();
  const result = await withLlm.instance.prepare(long);
  assert.equal(result, '📊 ✅ Report written. Nothing needed from you.'.replace('📊 ✅', '✅'));
  assert.equal(withLlm.calls.length, 1);
  assert.equal(withLlm.calls[0].effort, 'minimal');

  const failing = brief({ llm: { complete: async () => { throw new Error('down'); } } });
  const fallback = await failing.instance.prepare(long);
  assert.ok(fallback.length <= 700, `got ${fallback.length}`);
  assert.doesNotMatch(fallback, /agent:main|##|^- /);
  const noLlm = brief({ llm: null });
  assert.ok((await noLlm.instance.prepare('🚨 ' + 'Something happened. '.repeat(80))).length <= 620);
});

test('cleanText removes code fences, raw JSON and IDs', () => {
  assert.match(cleanText('Result:\n```js\nconsole.log(1)\n```'), /\[code omitted\]/);
  assert.equal(cleanText('{"a":1,"b":[2,3]}'), 'Structured result received.');
  assert.doesNotMatch(cleanText('task 5f11b09ecd5822b94cd4d8ad4e2fb31 finished'), /5f11b09/);
  assert.ok(deterministicBrief('First sentence here. '.repeat(40), 100).length <= 101);
});
