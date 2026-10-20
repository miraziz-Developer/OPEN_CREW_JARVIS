'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractRequestDescriptions } = require('../core/background-jobs/fast-action-learn-job');

test('fast-action learning reads the voice turns memory actually contains', () => {
  const markdown = [
    '# 2026-10-20 — Jarvis memory',
    '---',
    '## 09:12 — Voice turn',
    '<!-- turnId:t1 -->',
    '**Turn ID:** t1',
    '**Status:** completed',
    'User: open Figma',
    'Jarvis: Figma is open.',
    '',
    '**Tags:** #voice #turn-journal',
    '---',
    '## 09:20 — Ovozli turn',
    'Foydalanuvchi: Discord ni och',
    '---',
    '## 09:30 — Vazifa boshlandi',
    'Notion ochish',
    '---',
    '## 09:40 — Voice turn',
    'User: (awaiting reply)',
    '---',
    '## 10:00 — Screen change',
    'Editing README.md'
  ].join('\n');

  assert.deepEqual(extractRequestDescriptions(markdown), ['open Figma', 'Discord ni och', 'Notion ochish']);
});
