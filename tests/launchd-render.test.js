'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../scripts/render-launchd');
const fs = require('node:fs');
const path = require('node:path');

test('launchd renderer escapes paths and resolves every placeholder', () => {
  const output = render('<string>__PROJECT_DIR__</string><string>__NODE_BIN__</string>', {
    PROJECT_DIR: '/tmp/a&b', NODE_BIN: '/opt/homebrew/bin/node'
  });
  assert.equal(output, '<string>/tmp/a&amp;b</string><string>/opt/homebrew/bin/node</string>');
});

test('launchd renderer rejects unresolved placeholders', () => {
  assert.throws(() => render('__PROJECT_DIR__ __MISSING__', { PROJECT_DIR: '/tmp' }), /MISSING/);
});

test('persistent runner launchd template resolves project and Node placeholders', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'com.jarvis.persistent-agent-runner.plist'), 'utf8');
  const output = render(template, { PROJECT_DIR: '/tmp/jarvis', NODE_BIN: '/opt/homebrew/bin/node' });
  assert.match(output, /com\.jarvis\.persistent-agent-runner/);
  assert.match(output, /\/tmp\/jarvis\/core\/persistent-agent-runner\.js/);
  assert.doesNotMatch(output, /__[A-Z0-9_]+__/);
});