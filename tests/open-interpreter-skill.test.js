'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const projectDir = path.join(__dirname, '..');
const skillPath = path.join(projectDir, 'skills', 'open-interpreter', 'SKILL.md');

test('Open Interpreter worker skill is scoped, safe, and available to the main agent', () => {
  const skill = fs.readFileSync(skillPath, 'utf8');
  const soul = fs.readFileSync(path.join(projectDir, 'SOUL.md'), 'utf8');

  assert.match(skill, /Open Interpreter worker/i);
  assert.match(skill, /terminal access, shell scripts, Docker, local servers, code changes/i);
  assert.match(skill, /Finder, Notes, and Calendar/i);
  assert.match(skill, /--stdin --loop --safe_mode auto --auto_run --disable_telemetry/);
  assert.match(skill, /Do not use `--safe_mode off`/);
  assert.match(skill, /Ask for explicit confirmation before deleting files\/data/i);
  assert.match(skill, /Do not claim success until the requested local state has been observed or tested/i);
  assert.match(soul, /Open Interpreter — local Mac worker/i);
  assert.match(soul, /skills\/open-interpreter\/SKILL\.md/);
});