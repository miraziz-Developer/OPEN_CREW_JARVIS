'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseScreenAnalysis } = require('../skills/screen-monitor/index.js');

test('screen monitor: "nothing" answers are not recorded as screen changes', () => {
  for (const reply of ['NOTHING', 'Nothing.', 'hech narsa', '  ']) {
    assert.deepEqual(parseScreenAnalysis(reply), { skip: true, urgent: false, text: '' }, reply);
  }
});

test('screen monitor: the urgent prefix is stripped and flagged (English and legacy Uzbek)', () => {
  assert.deepEqual(parseScreenAnalysis('URGENT: Xcode build failed'), { skip: false, urgent: true, text: 'Xcode build failed' });
  assert.deepEqual(parseScreenAnalysis('SHOSHILINCH: quota exceeded'), { skip: false, urgent: true, text: 'quota exceeded' });
  assert.deepEqual(parseScreenAnalysis('Editing README.md in VS Code'), { skip: false, urgent: false, text: 'Editing README.md in VS Code' });
});
