'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const projectDir = path.join(__dirname, '..');
const skillPath = path.join(projectDir, 'skills', 'web-specialist', 'SKILL.md');

test('Web Specialist is browser-scoped, uses visual verification, and gates Control Center writes', () => {
  const skill = fs.readFileSync(skillPath, 'utf8');
  const soul = fs.readFileSync(path.join(projectDir, 'SOUL.md'), 'utf8');

  assert.match(skill, /Browser-use, built on Playwright/i);
  assert.match(skill, /built-in `browser` tool as the supported fallback/i);
  assert.match(skill, /rendered-page or visual verification rather than blind HTML scraping/i);
  assert.match(skill, /Use headless only for read-only\/background work/i);
  assert.match(skill, /After navigation, filtering, form entry, download, or submission, re-read the page state/i);
  assert.match(skill, /may write to PostgreSQL \*\*only\*\* when all of these are true/i);
  assert.match(skill, /the user explicitly asked for this collected data to be saved\/sent/i);
  assert.match(skill, /Never guess a database connection string, table, credentials, schema/i);
  assert.match(skill, /Ask for explicit confirmation immediately before irreversible or externally visible actions/i);
  assert.match(skill, /Do not bypass CAPTCHAs, paywalls, rate limits, access controls/i);
  assert.match(soul, /Web Specialist — Browser-use\/Playwright web worker/i);
  assert.match(soul, /skills\/web-specialist\/SKILL\.md/);
});