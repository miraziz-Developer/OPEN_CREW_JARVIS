'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../scripts/render-launchd');

test('launchd renderer escapes paths and resolves every placeholder', () => {
  const output = render('<string>__PROJECT_DIR__</string><string>__NODE_BIN__</string>', {
    PROJECT_DIR: '/tmp/a&b', NODE_BIN: '/opt/homebrew/bin/node'
  });
  assert.equal(output, '<string>/tmp/a&amp;b</string><string>/opt/homebrew/bin/node</string>');
});

test('launchd renderer rejects unresolved placeholders', () => {
  assert.throws(() => render('__PROJECT_DIR__ __MISSING__', { PROJECT_DIR: '/tmp' }), /MISSING/);
});