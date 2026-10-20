'use strict';

/**
 * Resolves a spoken project name ("forex AI analyst", "tradegenius") to a local
 * project directory, so a mission works inside the right repository instead of
 * JARVIS's own folder.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_MARKERS = [
  '.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod',
  'Cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'pubspec.yaml', 'manage.py'
];

function defaultRoots(home = os.homedir()) {
  return [path.join(home, 'projects'), home, path.join(home, 'Desktop'), path.join(home, 'Documents')];
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isProjectDir(dir) {
  return PROJECT_MARKERS.some(marker => fs.existsSync(path.join(dir, marker)));
}

/** Project directories directly under each root, deduplicated by real path. */
function listProjects(options = {}) {
  const roots = options.roots || defaultRoots(options.home);
  const seen = new Set();
  const projects = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(root, entry.name);
      let real;
      try { real = fs.realpathSync(dir); } catch (_) { continue; }
      if (seen.has(real) || !isProjectDir(dir)) continue;
      seen.add(real);
      projects.push({ name: entry.name, path: dir });
    }
  }
  return projects;
}

// Same-named copies (~/x and ~/projects/x) are shown by path so the user can choose.
function labels(projects, home) {
  return projects.map(p => projects.filter(other => other.name === p.name).length > 1
    ? p.path.replace(home, '~')
    : p.name).slice(0, 6);
}

/**
 * Returns { ok: true, name, path } for one clear match, otherwise
 * { ok: false, reason, candidates } so the caller can ask the user.
 */
function resolveProject(query, options = {}) {
  const raw = String(query || '').trim();
  if (!raw) return { ok: false, reason: 'no project name given', candidates: [] };
  const home = options.home || os.homedir();

  const expanded = raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
  if (path.isAbsolute(expanded)) {
    const resolved = path.resolve(expanded);
    const inHome = resolved === home || resolved.startsWith(home + path.sep);
    if (inHome && fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return { ok: true, name: path.basename(resolved), path: resolved };
    }
    return { ok: false, reason: `${raw} is not a folder in your home directory`, candidates: [] };
  }

  const wanted = normalizeName(raw);
  if (wanted.length < 3) return { ok: false, reason: `"${raw}" is too short to identify a project`, candidates: [] };
  const projects = listProjects({ ...options, home });

  const exact = projects.filter(p => normalizeName(p.name) === wanted);
  if (exact.length === 1) return { ok: true, ...exact[0] };

  const partial = projects.filter(p => {
    const name = normalizeName(p.name);
    return name.length >= 3 && (name.includes(wanted) || wanted.includes(name));
  });
  if (partial.length === 1) return { ok: true, ...partial[0] };
  if (partial.length > 1) {
    return { ok: false, reason: `"${raw}" matches several projects`, candidates: labels(partial, home) };
  }

  const words = raw.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 3);
  const scored = projects
    .map(p => ({ project: p, score: words.filter(word => normalizeName(p.name).includes(word)).length }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score)) return { ok: true, ...scored[0].project };
  return {
    ok: false,
    reason: `no project matches "${raw}"`,
    candidates: labels(scored.length ? scored.map(item => item.project) : projects, home)
  };
}

module.exports = { resolveProject, listProjects, isProjectDir, normalizeName };
