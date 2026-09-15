'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const projectDir = path.join(__dirname, '..');

test('memory lookup instructions use the supported local JSON fallback', () => {
  const skill = fs.readFileSync(path.join(projectDir, 'skills', 'memory', 'SKILL.md'), 'utf8');
  const soul = fs.readFileSync(path.join(projectDir, 'SOUL.md'), 'utf8');

  for (const instructions of [skill, soul]) {
    assert.match(instructions, /\{"action":"search","query":"(?:favorite music|\.\.\.)"/);
    assert.match(instructions, /node skills\/memory\/index\.js/);
    assert.match(instructions, /Do \*\*not\*\* use the generic project `search` tool|umumiy loyiha `search` vositasidan foydalanmang/);
    assert.match(instructions, /in !\*\.sqlite\*/);
    assert.match(instructions, /memory (?:is )?unavailable/i);
  }
});