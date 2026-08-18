#!/usr/bin/env node
/**
 * PROJECTS Skill — ko'p bosqichli, kun davomida ketma-ket bajariladigan
 * avtonom loyihalar. Oddiy kunlik vazifalardan farqi: bir loyihaning
 * bosqichlari MA'LUM TARTIBDA, bitta umumiy kontekst/session bilan
 * bajariladi (har biri oldingisidan xabardor), va OXIRIDA yakuniy,
 * konsolidatsiyalangan hisobot beriladi — alohida-alohida emas.
 * Fayl: Obsidian Vault/Jarvis/Tasks/Projects.md
 */

const fs = require('fs');
const path = require('path');

const VAULT = process.env.OBSIDIAN_VAULT
  || (require('os').homedir() + '/Documents/Obsidian Vault');

const TASKS_DIR = path.join(VAULT, 'Jarvis', 'Tasks');
const PROJECTS_FILE = path.join(TASKS_DIR, 'Projects.md');

function ensureDir() {
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
}

function readRaw() {
  ensureDir();
  if (!fs.existsSync(PROJECTS_FILE)) {
    fs.writeFileSync(PROJECTS_FILE, "# Loyihalar\n\nKo'p bosqichli, kun davomida ketma-ket bajariladigan vazifalar. Bog'liq: [[DailyTasks]]\n\n", 'utf8');
  }
  return fs.readFileSync(PROJECTS_FILE, 'utf8');
}

function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9а-яёʻʼ]+/gi, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'loyiha';
}

// ── Faylni bo'lim (loyiha)larga ajratish ────────────────────────────────
function parseProjects(raw) {
  const projects = [];
  const lines = raw.split('\n');
  let current = null;
  for (const line of lines) {
    const h = line.match(/^## Loyiha: (.+?) `\[(.+?)\]`\s*$/);
    if (h) {
      if (current) projects.push(current);
      current = { name: h[1].trim(), slug: h[2].trim(), steps: [] };
      continue;
    }
    if (!current) continue;
    const step = line.match(/^- \[( |x)\] (.+)$/);
    if (step) current.steps.push({ done: step[1] === 'x', text: step[2].trim() });
  }
  if (current) projects.push(current);
  return projects;
}

function listProjects() {
  return { status: 'ok', projects: parseProjects(readRaw()) };
}

// ── Yangi loyiha yaratish ────────────────────────────────────────────────
function createProject(name, steps) {
  if (!name || !Array.isArray(steps) || !steps.length) {
    return { status: 'error', message: 'name va steps (kamida 1 ta) kerak' };
  }
  const raw = readRaw();
  const slug = slugify(name) + '-' + Date.now().toString(36);
  const block = '\n## Loyiha: ' + name.trim() + ' `[' + slug + ']`\n' +
    '(yaratilgan: ' + new Date().toISOString().slice(0, 10) + ')\n\n' +
    steps.map(s => '- [ ] ' + String(s).trim()).join('\n') + '\n';
  fs.writeFileSync(PROJECTS_FILE, raw.replace(/\n*$/, '') + '\n' + block, 'utf8');
  return { status: 'ok', slug, name: name.trim(), steps: steps.length };
}

// ── Fon jarayoni uchun: birinchi tugallanmagan loyihaning navbatdagi
// bosqichini qaytaradi (yo'q bo'lsa null) ─────────────────────────────────
function activeStep() {
  const projects = parseProjects(readRaw());
  for (const p of projects) {
    const next = p.steps.find(s => !s.done);
    if (next) return { project: p.name, slug: p.slug, step: next.text, totalSteps: p.steps.length, doneSteps: p.steps.filter(s => s.done).length };
  }
  return null;
}

// ── Bosqichni bajarilgan deb belgilash; agar shu bilan loyiha tugasa,
// hammasi bajarilgan (barcha qadamlar matni) qaytariladi ────────────────
function completeStep(slug, stepText) {
  const raw = readRaw();
  const lines = raw.split('\n');
  let inProject = false, changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('^## Loyiha: .+ `\\[' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]`\\s*$').test(lines[i])) { inProject = true; continue; }
    if (inProject && /^## Loyiha: /.test(lines[i])) break;
    if (inProject) {
      const m = lines[i].match(/^- \[ \] (.+)$/);
      if (m && m[1].trim() === String(stepText).trim()) { lines[i] = lines[i].replace('[ ]', '[x]'); changed = true; break; }
    }
  }
  if (!changed) return { status: 'error', message: 'bosqich topilmadi' };
  fs.writeFileSync(PROJECTS_FILE, lines.join('\n'), 'utf8');

  const projects = parseProjects(lines.join('\n'));
  const p = projects.find(pr => pr.slug === slug);
  const complete = p ? p.steps.every(s => s.done) : false;
  return { status: 'ok', complete, allSteps: p ? p.steps.map(s => s.text) : [] };
}

// ── CLI ───────────────────────────────────────────────────────────────
function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (e) {}
  let result;
  switch (input.action) {
    case 'create': result = createProject(input.name, input.steps); break;
    case 'list': result = listProjects(); break;
    case 'active_step': result = { status: 'ok', active: activeStep() }; break;
    case 'complete_step': result = completeStep(input.slug, input.step); break;
    default: result = { status: 'error', message: "Noma'lum action: " + input.action + ' (create|list|active_step|complete_step)' };
  }
  console.log(JSON.stringify(result));
}

if (require.main === module) main();

module.exports = { listProjects, createProject, activeStep, completeStep, PROJECTS_FILE };
