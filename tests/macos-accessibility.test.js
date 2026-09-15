'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  flattenTree, findElements, normalizeElement, inspectAccessibility, performAccessibilityAction, UI_TREE_SCRIPT
} = require('../core/macos-accessibility');

const tree = [{
  path: [0], role: 'AXWindow', title: 'Compose', enabled: true,
  children: [
    { path: [0, 0], role: 'AXTextField', title: 'Recipient', description: 'To', value: '', enabled: true, focused: false, actions: ['AXConfirm'] },
    { path: [0, 1], role: 'AXButton', title: 'Send', description: 'Send message', enabled: true, actions: ['AXPress'], bounds: { x: 10, y: 20, width: 80, height: 30 } },
    { path: [0, 2], role: 'AXButton', title: 'Send later', enabled: false, actions: ['AXPress'] },
    { path: [0, 3], role: 'AXSecureTextField', title: 'Password', value: 'must-not-leak', enabled: true }
  ]
}];

test('accessibility tree is flattened and secure values are redacted', () => {
  const elements = flattenTree(tree);
  assert.equal(elements.length, 5);
  assert.equal(elements.find(item => item.role === 'AXSecureTextField').value, '');
  assert.deepEqual(elements.find(item => item.title === 'Send').bounds, { x: 10, y: 20, width: 80, height: 30 });
});

test('semantic finder ranks exact enabled role match first', () => {
  const found = findElements(flattenTree(tree), { name: 'Send', role: 'AXButton', action: 'AXPress' });
  assert.equal(found[0].title, 'Send');
  assert.equal(found[0].enabled, true);
  assert.ok(found[0].score > found[1].score);
});

test('semantic finder rejects an empty query instead of choosing arbitrary UI', () => {
  assert.throws(() => findElements(flattenTree(tree), {}), /name\/title\/role\/identifier/);
});

test('normalization drops malformed paths and bounds safely', () => {
  assert.deepEqual(normalizeElement({ path: [0, 'bad', 2], bounds: { x: 1 } }).path, [0, 2]);
  assert.equal(normalizeElement({ bounds: { x: 1 } }).bounds, null);
});

test('inspection and action use injected JXA executor contracts', () => {
  const calls = [];
  const execFileSync = (bin, args, options) => {
    calls.push({ bin, args, options });
    const input = JSON.parse(options.env.JARVIS_AX_INPUT);
    if (input.action) return JSON.stringify({ ok: true, action: input.action, path: input.path });
    return JSON.stringify({ app: 'TextEdit', pid: 42, capturedAt: 100, tree });
  };
  const inspected = inspectAccessibility({ app: 'TextEdit', query: { role: 'AXTextArea' } }, { execFileSync });
  assert.equal(inspected.app, 'TextEdit');
  assert.equal(inspected.count, 5);
  assert.deepEqual(JSON.parse(calls[0].options.env.JARVIS_AX_INPUT).query, { role: 'AXTextArea' });
  const result = performAccessibilityAction({ app: 'TextEdit', path: [0, 1], action: 'press' }, { execFileSync });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
});

test('JXA reads injected input through Foundation on macOS', () => {
  assert.match(UI_TREE_SCRIPT, /NSProcessInfo\.processInfo\.environment/);
  assert.doesNotMatch(UI_TREE_SCRIPT, /\$\.getenv/);
});

test('explicit app lookup never silently falls back to the frontmost app', () => {
  assert.match(UI_TREE_SCRIPT, /whose\(\{name: input\.app\}\)/);
  assert.match(UI_TREE_SCRIPT, /if \(input\.app\)[^\n]+\nelse proc = [^\n]+frontmost/);
  assert.doesNotMatch(UI_TREE_SCRIPT, /if \(!proc \|\|[^\n]*frontmost/);
});