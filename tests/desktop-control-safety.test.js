'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeDesktopInput } = require('../skills/desktop-control');

test('desktop safety allows observation and reversible semantic actions', () => {
  assert.equal(authorizeDesktopInput({ action: 'inspect_ui' }).allowed, true);
  assert.equal(authorizeDesktopInput({ action: 'click_element', query: { name: 'Next' } }).allowed, true);
});

test('desktop safety requires explicit scoped confirmation for external or destructive effects', () => {
  const command = { action: 'click_element', query: { name: 'Send message' } };
  assert.equal(authorizeDesktopInput(command).allowed, false);
  assert.equal(authorizeDesktopInput({ ...command, confirmed: true }).allowed, true);
  assert.equal(authorizeDesktopInput({ action: 'select_menu', menu: 'File', item: 'Delete' }).allowed, false);
});

test('desktop full autonomy does not bypass external or destructive confirmation', () => {
  const options = { fullAutonomyProvider: () => true };
  assert.equal(authorizeDesktopInput({ action: 'click_element', query: { name: 'Next' } }, options).allowed, true);
  assert.equal(authorizeDesktopInput({ action: 'click_element', query: { name: 'Send message' } }, options).allowed, false);
});