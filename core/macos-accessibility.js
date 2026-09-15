'use strict';

const { execFileSync } = require('child_process');

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ELEMENTS = 600;
const PRIVATE_ROLES = new Set(['AXSecureTextField']);

const UI_TREE_SCRIPT = `
ObjC.import('Foundation');
function safe(fn, fallback) { try { var value = fn(); return value === undefined || value === null ? fallback : value; } catch (e) { return fallback; } }
function text(value) { try { return String(value === undefined || value === null ? '' : value); } catch (e) { return ''; } }
function envValue(name) { var value = $.NSProcessInfo.processInfo.environment.objectForKey(name); return value ? ObjC.unwrap(value) : ''; }
var input = JSON.parse(envValue('JARVIS_AX_INPUT') || '{}');
var maxDepth = Math.max(1, Math.min(20, Number(input.maxDepth || 8)));
var maxElements = Math.max(1, Math.min(2000, Number(input.maxElements || 600)));
var query = input.query && typeof input.query === 'object' ? input.query : null;
var se = Application('System Events');
var proc = null;
if (input.app) proc = safe(() => se.applicationProcesses.whose({name: input.app})()[0], null);
else proc = safe(() => se.applicationProcesses.whose({frontmost: true})()[0], null);
if (!proc) throw new Error('Application process not found: ' + (input.app || 'frontmost'));
var count = 0;
function boundsOf(el) {
  var p = safe(() => el.position(), null), s = safe(() => el.size(), null);
  return p && s ? {x:Number(p[0]), y:Number(p[1]), width:Number(s[0]), height:Number(s[1])} : null;
}
function walk(el, path, depth) {
  if (!el || count >= maxElements) return null;
  count++;
  var role = text(safe(() => el.role(), ''));
  var roleMatches = !query || !query.role || role.toLowerCase() === text(query.role).toLowerCase();
  var item = {
    path: path, role: role, subrole: text(safe(() => el.subrole(), '')),
    title: roleMatches ? text(safe(() => el.title(), '')) : '', description: roleMatches ? text(safe(() => el.description(), '')) : '',
    value: roleMatches && role !== 'AXSecureTextField' ? text(safe(() => el.value(), '')) : '',
    identifier: roleMatches ? text(safe(() => el.attributes.byName('AXIdentifier').value(), '')) : '',
    enabled: Boolean(safe(() => el.enabled(), true)), focused: Boolean(safe(() => el.focused(), false)),
    selected: Boolean(safe(() => el.selected(), false)), bounds: roleMatches ? boundsOf(el) : null,
    actions: roleMatches && (!query || query.action) ? safe(() => el.actions().map(a => text(a.name())), []) : []
  };
  if (depth < maxDepth && count < maxElements) {
    var children = safe(() => el.uiElements(), []);
    item.children = [];
    for (var i = 0; i < children.length && count < maxElements; i++) {
      var child = walk(children[i], path.concat(i), depth + 1);
      if (child) item.children.push(child);
    }
  }
  return item;
}
var roots = safe(() => proc.windows(), []);
var tree = [];
for (var i = 0; i < roots.length && count < maxElements; i++) {
  var node = walk(roots[i], [i], 0); if (node) tree.push(node);
}
JSON.stringify({app:text(safe(() => proc.name(), '')), pid:Number(safe(() => proc.unixId(), 0)), capturedAt:Date.now(), truncated:count >= maxElements, count:count, tree:tree});
`;

const UI_ACTION_SCRIPT = `
ObjC.import('Foundation');
function safe(fn, fallback) { try { var value = fn(); return value === undefined || value === null ? fallback : value; } catch (e) { return fallback; } }
function envValue(name) { var value = $.NSProcessInfo.processInfo.environment.objectForKey(name); return value ? ObjC.unwrap(value) : ''; }
var input = JSON.parse(envValue('JARVIS_AX_INPUT') || '{}');
var se = Application('System Events');
var proc = input.app ? safe(() => se.applicationProcesses.whose({name: input.app})()[0], null) : safe(() => se.applicationProcesses.whose({frontmost: true})()[0], null);
if (!proc) throw new Error('Application process not found: ' + (input.app || 'frontmost'));
safe(() => { proc.frontmost = true; }, null);
var path = input.path || [];
if (!path.length) throw new Error('Element path required');
var roots = proc.windows();
var el = roots[path[0]];
if (!el) throw new Error('Window path not found');
for (var i = 1; i < path.length; i++) {
  var children = el.uiElements(); el = children[path[i]];
  if (!el) throw new Error('Element path not found at index ' + i);
}
var action = input.action;
if (action === 'press') {
  var actions = safe(() => el.actions(), []), pressed = false;
  for (var j = 0; j < actions.length; j++) if (String(actions[j].name()) === 'AXPress') { actions[j].perform(); pressed = true; break; }
  if (!pressed) { try { el.click(); pressed = true; } catch (e) {} }
  if (!pressed) throw new Error('Element is not pressable');
} else if (action === 'focus') {
  el.attributes.byName('AXFocused').value = true;
} else if (action === 'set_value') {
  el.attributes.byName('AXFocused').value = true; el.value = String(input.value === undefined ? '' : input.value);
} else if (action === 'increment' || action === 'decrement' || action === 'show_menu' || action === 'scroll_up' || action === 'scroll_down') {
  var wanted = action === 'increment' ? 'AXIncrement' : action === 'decrement' ? 'AXDecrement' : action === 'show_menu' ? 'AXShowMenu' : action === 'scroll_up' ? 'AXScrollUp' : 'AXScrollDown';
  var list = safe(() => el.actions(), []), done = false;
  for (var k = 0; k < list.length; k++) if (String(list[k].name()) === wanted) { list[k].perform(); done = true; break; }
  if (!done) throw new Error(wanted + ' action unavailable');
} else if (action === 'confirm') {
  el.attributes.byName('AXConfirm').perform();
} else throw new Error('Unknown accessibility action: ' + action);
JSON.stringify({ok:true, app:String(safe(() => proc.name(), '')), action:action, path:path});
`;

function parseJson(output) {
  try {
    const value = JSON.parse(String(output || '').trim());
    return value && typeof value === 'object' ? value : null;
  } catch (_) { return null; }
}

function accessibilityError(error) {
  const message = String(error?.stderr || error?.message || error || '').trim();
  if (/assistive|not authorized|not allowed|-1743|osascript is not allowed/i.test(message)) {
    return new Error('Accessibility ruxsati kerak: System Settings → Privacy & Security → Accessibility');
  }
  return new Error('macOS Accessibility xatosi: ' + message.slice(0, 500));
}

function runJxa(script, input = {}, options = {}) {
  const exec = options.execFileSync || execFileSync;
  try {
    const output = exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
      encoding: 'utf8', timeout: options.timeout || 8000,
      env: { ...process.env, JARVIS_AX_INPUT: JSON.stringify(input) }
    });
    const parsed = parseJson(output);
    if (!parsed) throw new Error('JXA noto‘g‘ri JSON qaytardi');
    return parsed;
  } catch (error) { throw accessibilityError(error); }
}

function clean(value, max = 500) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }

function normalizeElement(element = {}) {
  const role = clean(element.role, 80);
  const secure = PRIVATE_ROLES.has(role);
  return {
    path: Array.isArray(element.path) ? element.path.filter(Number.isInteger) : [],
    role, subrole: clean(element.subrole, 80), title: clean(element.title, 300),
    description: clean(element.description, 300), value: secure ? '' : clean(element.value, 500),
    identifier: clean(element.identifier, 200), enabled: element.enabled !== false,
    focused: element.focused === true, selected: element.selected === true,
    bounds: normalizeBounds(element.bounds), actions: Array.isArray(element.actions) ? element.actions.map(a => clean(a, 80)).filter(Boolean) : []
  };
}

function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const value = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const number = Number(bounds[key]);
    if (!Number.isFinite(number)) return null;
    value[key] = number;
  }
  return value;
}

function flattenTree(tree, output = []) {
  for (const raw of Array.isArray(tree) ? tree : []) {
    const item = normalizeElement(raw);
    output.push(item);
    flattenTree(raw.children, output);
  }
  return output;
}

function normalizeQuery(value) {
  return clean(value, 500).toLocaleLowerCase('uz-UZ').normalize('NFKD').replace(/[’‘`ʻ]/g, "'");
}

function fieldScore(actual, wanted, weight) {
  const left = normalizeQuery(actual), right = normalizeQuery(wanted);
  if (!right) return 0;
  if (!left) return -weight;
  if (left === right) return weight;
  if (left.includes(right)) return weight * 0.78;
  if (right.includes(left) && left.length >= 3) return weight * 0.45;
  const tokens = right.split(/\s+/).filter(Boolean);
  const matched = tokens.filter(token => left.includes(token)).length;
  return tokens.length ? weight * 0.4 * (matched / tokens.length) : 0;
}

function scoreElement(element, query = {}) {
  let score = 0;
  score += fieldScore(element.title, query.title || query.name, 50);
  score += fieldScore(element.description, query.description || query.name, 30);
  score += fieldScore(element.value, query.value, 24);
  score += fieldScore(element.identifier, query.identifier, 45);
  if (query.role) score += normalizeQuery(element.role) === normalizeQuery(query.role) ? 35 : -35;
  if (query.subrole) score += normalizeQuery(element.subrole) === normalizeQuery(query.subrole) ? 20 : -20;
  if (query.action) score += element.actions.includes(query.action) ? 15 : -15;
  if (query.enabled !== undefined) score += element.enabled === Boolean(query.enabled) ? 8 : -20;
  if (query.focused !== undefined) score += element.focused === Boolean(query.focused) ? 8 : -8;
  if (query.selected !== undefined) score += element.selected === Boolean(query.selected) ? 8 : -8;
  if (element.enabled) score += 2;
  if (element.bounds && element.bounds.width > 0 && element.bounds.height > 0) score += 2;
  return score;
}

function hasMeaningfulQuery(query = {}) {
  return ['name', 'title', 'description', 'value', 'identifier', 'role', 'subrole', 'action']
    .some(key => query[key] !== undefined && clean(query[key]) !== '');
}

function findElements(elements, query = {}, options = {}) {
  if (!hasMeaningfulQuery(query)) throw new Error('Element qidirish uchun name/title/role/identifier kerak');
  const limit = Math.max(1, Math.min(50, Number(options.limit || query.limit || 10)));
  const minScore = Number(options.minScore ?? query.minScore ?? 20);
  return (Array.isArray(elements) ? elements : []).map(element => ({ element, score: scoreElement(element, query) }))
    .filter(match => match.score >= minScore)
    .sort((a, b) => b.score - a.score || a.element.path.length - b.element.path.length)
    .slice(0, limit)
    .map((match, index) => ({ ...match.element, score: Math.round(match.score * 100) / 100, rank: index + 1 }));
}

function inspectAccessibility(input = {}, options = {}) {
  const payload = runJxa(UI_TREE_SCRIPT, {
    app: clean(input.app, 120), maxDepth: input.maxDepth || DEFAULT_MAX_DEPTH,
    maxElements: input.maxElements || DEFAULT_MAX_ELEMENTS,
    query: input.query && typeof input.query === 'object' ? input.query : null
  }, options);
  const elements = flattenTree(payload.tree);
  return { app: clean(payload.app, 120), pid: Number(payload.pid) || null, capturedAt: Number(payload.capturedAt) || Date.now(), truncated: Boolean(payload.truncated), count: elements.length, elements };
}

function performAccessibilityAction(input = {}, options = {}) {
  if (!Array.isArray(input.path) || !input.path.length) throw new Error('Element path required');
  return runJxa(UI_ACTION_SCRIPT, { app: clean(input.app, 120), path: input.path, action: input.action, value: input.value }, options);
}

module.exports = {
  inspectAccessibility, performAccessibilityAction, flattenTree, normalizeElement,
  findElements, scoreElement, parseJson, UI_TREE_SCRIPT, UI_ACTION_SCRIPT
};