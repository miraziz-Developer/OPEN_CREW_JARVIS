#!/usr/bin/env node
/**
 * TASKS Skill — foydalanuvchi tanlagan kunlik vazifalar ro'yxati
 * Fayl: Obsidian Vault/Jarvis/Tasks/DailyTasks.md (checklist formatida)
 * Har vazifa: "- [ ] tavsif" — bajarilganda "- [x]" bo'ladi (kunlik holat alohida faylda)
 */

const fs = require('fs');
const path = require('path');

const VAULT = process.env.OBSIDIAN_VAULT
  || (require('os').homedir() + '/Documents/Obsidian Vault');

const TASKS_DIR = path.join(VAULT, 'Jarvis', 'Tasks');
const TASKS_FILE = path.join(TASKS_DIR, 'DailyTasks.md');

function ensureDir() {
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
}

function readRaw() {
  ensureDir();
  if (!fs.existsSync(TASKS_FILE)) {
    fs.writeFileSync(TASKS_FILE, '# Kunlik vazifalar\n\nJarvis kun davomida shu ro\'yxatdagi vazifalarni navbat bilan avtomatik bajaradi.\n\nBog\'liq: [[User]]\n\n', 'utf8');
  }
  return fs.readFileSync(TASKS_FILE, 'utf8');
}

// ── Ro'yxatni o'qish ──────────────────────────────────────────────────
// Ikkala formatni ham qo'llab-quvvatlaydi: checkbox ("- [ ] matn" / "- [x] matn")
// VA oddiy bullet ("- matn", foydalanuvchi Obsidian'da qo'lda yozganda —
// bunday satr avval umuman o'qilmay, vazifa "yo'q" deb ko'rsatilardi).
function listTasks() {
  const raw = readRaw();
  const tasks = [];
  raw.split('\n').forEach((line, idx) => {
    const cb = line.match(/^- \[( |x)\] (.+)$/);
    if (cb) { tasks.push({ line: idx, done: cb[1] === 'x', text: cb[2].trim() }); return; }
    const plain = line.match(/^- (?!\[)(.+)$/);
    if (plain) tasks.push({ line: idx, done: false, text: plain[1].trim() });
  });
  return { status: 'ok', tasks };
}

// So'z to'plami bo'yicha o'xshashlik — ikkita vazifa matni bir xil narsani
// nazarda tutayotganini taxminiy aniqlash uchun. Uzbek tili qo'shimchali
// (agglyutinativ) bo'lgani uchun aniq so'z moslashuvi ishonchsiz ("zal" va
// "zalga" boshqa-boshqa token bo'lib chiqadi) — shuning uchun har bir so'z
// ildizga yaqinlashtirish uchun qisqartiriladi (birinchi 5 harf), va
// natija OVERLAP koeffitsienti bilan o'lchanadi (Jaccard emas) — chunki
// qisqa eslatma va uzun batafsil vazifa solishtirilganda, uzun matnning
// umumiy hajmi ular bir xil narsa haqida ekanini "yashirib" yubormasin.
function wordStems(text) {
  const words = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 3);
  return new Set(words.map(w => w.slice(0, 5)));
}
function timeMarkers(text) {
  return new Set((String(text).match(/\b([01]?\d|2[0-3])[:.][0-5]\d\b/g) || []));
}
function overlapCoefficient(a, b) {
  const wa = wordStems(a), wb = wordStems(b);
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.min(wa.size, wb.size);
}
function looksLikeDuplicate(a, b) {
  const overlap = overlapCoefficient(a, b);
  if (overlap >= 0.6) return true; // matnning katta qismi mos keladi
  // Bir xil aniq vaqt (masalan "19:30") + kamida bir nechta umumiy so'z —
  // ikkalasi ham "shu vaqtdagi eslatma" ekanini kuchli ko'rsatadi.
  const ta = timeMarkers(a), tb = timeMarkers(b);
  let sharedTime = false;
  for (const t of ta) if (tb.has(t)) sharedTime = true;
  return sharedTime && overlap >= 0.25;
}

// ── Vazifa qo'shish ───────────────────────────────────────────────────
// Juda o'xshash vazifa allaqachon ro'yxatda bo'lsa, qayta qo'shmaydi
// (real holatda kuzatildi: bir xil "zalga chiqish" eslatmasi 2-3 marta
// alohida-alohida qo'shilib, bitta kunda bir necha marta ishga tushgan).
function addTask(text, force) {
  if (!text || !text.trim()) return { status: 'error', message: 'text kerak' };
  const trimmed = text.trim();
  if (!force) {
    const existing = listTasks().tasks;
    const dup = existing.find(t => looksLikeDuplicate(t.text, trimmed));
    if (dup) return { status: 'duplicate', message: 'Juda o\'xshash vazifa allaqachon bor', existing: dup.text };
  }
  const raw = readRaw();
  const updated = raw.replace(/\n*$/, '') + '\n- [ ] ' + trimmed + '\n';
  fs.writeFileSync(TASKS_FILE, updated, 'utf8');
  return { status: 'ok', added: trimmed };
}

// ── Vazifani o'chirish (matn bo'yicha, taxminiy moslik) ────────────────
function removeTask(text) {
  const raw = readRaw();
  const lines = raw.split('\n');
  const idx = lines.findIndex(l => /^- (\[( |x)\] )?(?!\[)/.test(l) && l.toLowerCase().includes(String(text).toLowerCase()));
  if (idx === -1) return { status: 'error', message: 'Topilmadi: ' + text };
  const removed = lines[idx];
  lines.splice(idx, 1);
  fs.writeFileSync(TASKS_FILE, lines.join('\n'), 'utf8');
  return { status: 'ok', removed };
}

// ── Faqat aktiv (bajarilmagan) vazifalar ────────────────────────────────
function activeTasks() {
  return listTasks().tasks.filter(t => !t.done).map(t => t.text);
}

// ── CLI ───────────────────────────────────────────────────────────────
function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').trim() || '{}'); } catch (e) {}

  let result;
  switch (input.action) {
    case 'add': result = addTask(input.text, input.force); break;
    case 'remove': result = removeTask(input.text); break;
    case 'list': result = listTasks(); break;
    default: result = { status: 'error', message: 'Noma\'lum action: ' + input.action + ' (add|remove|list)' };
  }
  console.log(JSON.stringify(result));
}

if (require.main === module) main();

module.exports = { listTasks, addTask, removeTask, activeTasks, TASKS_FILE };
