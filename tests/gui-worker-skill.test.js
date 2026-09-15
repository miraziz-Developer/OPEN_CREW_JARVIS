'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const projectDir = path.join(__dirname, '..');
const skillPath = path.join(projectDir, 'skills', 'gui-worker', 'SKILL.md');

test('GUI Worker is a visual fallback with guarded coordinate actions', () => {
  const skill = fs.readFileSync(skillPath, 'utf8');
  const soul = fs.readFileSync(path.join(projectDir, 'SOUL.md'), 'utf8');

  assert.match(skill, /UI-TARS or OmniParser-compatible visual grounding runtime/i);
  assert.match(skill, /screen-vision.*locate_elements/i);
  assert.match(skill, /Start with `desktop-control\.inspect_ui` or `find_element`/i);
  assert.match(skill, /Only if semantic discovery fails/i);
  assert.match(skill, /never manually rescale/i);
  assert.match(skill, /Verify every material transition/i);
  assert.match(skill, /Never reuse stale coordinates/i);
  assert.match(skill, /At most three safe attempts/i);
  assert.match(skill, /Ask for explicit confirmation immediately before irreversible or externally visible operations/i);
  assert.match(soul, /GUI Worker — visual UI-TARS\/OmniParser worker/i);
  assert.match(soul, /skills\/gui-worker\/SKILL\.md/);
});