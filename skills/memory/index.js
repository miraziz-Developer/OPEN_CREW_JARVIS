#!/usr/bin/env node
/**
 * MEMORY Skill — Obsidian Vault'ga xotira yozish va qidirish
 * Vault: ~/Documents/Obsidian Vault
 * Structure: Jarvis/Memory/YYYY-MM-DD.md  va  Jarvis/Profile/User.md
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const VAULT = process.env.OBSIDIAN_VAULT
  || (require('os').homedir() + '/Documents/Obsidian Vault');

const MEMORY_DIR = path.join(VAULT, 'Jarvis', 'Memory');
const PROFILE_FILE = path.join(VAULT, 'Jarvis', 'Profile', 'User.md');
const CONTEXT_FILE = path.join(VAULT, 'Jarvis', 'Profile', 'SessionContext.md');
const PRONUNCIATION_FILE = path.join(VAULT, 'Jarvis', 'Profile', 'Pronunciations.md');
const PRONUNCIATION_MAX = 100;

const PROJECT_DIR = '/Users/mirazizerkinaliyev_dev/projects/OPEN_CREW_JARVIS';
const EMBED_INDEX_FILE = path.join(PROJECT_DIR, '.memory-embeddings.json');
const EMBED_DEPLOYMENT = 'text-embedding-3-small';
let _azureEnv = null;
function azureEnv(k, def) {
  if (!_azureEnv) { try { _azureEnv = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (e) { _azureEnv = ''; } }
  const m = _azureEnv.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : def;
}

function ensureDirs() {
  [MEMORY_DIR, path.dirname(PROFILE_FILE), path.dirname(CONTEXT_FILE)].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// Mahalliy (timezone) sanani beradi — toISOString() har doim UTC qaytaradi,
// shuning uchun UTC+8 kabi zonalarda kun 08:00gacha "kechagi kun" bo'lib
// yozilib qolardi (Obsidian faylida sana kechikib almashadi degan xato).
function localDateStr(d) {
  d = d || new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// ── 1. Xotira yozish ─────────────────────────────────────────────────
function writeMemory(topic, content, tags = []) {
  ensureDirs();
  const date = localDateStr();
  const time = new Date().toTimeString().slice(0, 5);
  const filePath = path.join(MEMORY_DIR, date + '.md');

  const tagLine = tags.length ? '\n**Teglar:** ' + tags.map(t => `#${t}`).join(' ') + '\n' : '';
  const block = `
---
## ${time} — ${topic}
${content}
${tagLine}
`;

  let existing = '';
  if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf8');
  else existing = `# ${date} — Jarvis Xotirasi\n\nBog'liq: [[User]] · [[DailyTasks]]\n\n`;

  fs.writeFileSync(filePath, existing + block, 'utf8');
  return { status: 'ok', file: filePath };
}

// ── 2. Xotira qidirish (grep) ────────────────────────────────────────
function searchMemory(query, limit = 5) {
  ensureDirs();
  if (!fs.existsSync(MEMORY_DIR)) return { status: 'empty', results: [] };

  // Birinchi to'g'ri matn qidiruvi
  const results = [];
  const files = fs.readdirSync(MEMORY_DIR)
    .filter(f => f.endsWith('.md'))
    .sort().reverse();

  for (const file of files) {
    if (results.length >= limit) break;
    const fp = path.join(MEMORY_DIR, file);
    const content = fs.readFileSync(fp, 'utf8');
    const lines = content.split('\n');
    const matches = [];
    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes(query.toLowerCase())) {
        matches.push({ line: idx + 1, text: line.trim() });
      }
    });
    if (matches.length) {
      results.push({
        file: file,
        date: file.replace('.md', ''),
        matches: matches.slice(0, 3)
      });
    }
  }

  // Agar hech narsa topilmasa — profilni ham qidirib ko'r
  if (results.length === 0 && fs.existsSync(PROFILE_FILE)) {
    const prof = fs.readFileSync(PROFILE_FILE, 'utf8');
    const lines = prof.split('\n');
    const pmatches = [];
    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes(query.toLowerCase())) {
        pmatches.push({ line: idx + 1, text: line.trim() });
      }
    });
    if (pmatches.length) {
      results.push({ file: 'User.md (Profile)', matches: pmatches.slice(0, 3) });
    }
  }

  return { status: 'ok', query, results };
}

// ── 2b. Semantik (ma'no bo'yicha) qidiruv — RAG ─────────────────────────
// Oddiy grep faqat bir xil so'zni topadi ("topdim.uz" desa faqat shu so'z
// bor joylarni). Semantik qidiruv ma'noga qaraydi — "loyihamda qanday
// xato bor edi" kabi savol bilan "topdim.uz'da bug topildi" degan
// yozuvni ham topa oladi, so'zlar mos kelmasa ham.
function embedText(text) {
  return new Promise((resolve, reject) => {
    const KEY = azureEnv('AZURE_OPENAI_KEY');
    const RAW_ENDPOINT = (azureEnv('AZURE_OPENAI_ENDPOINT') || '').replace(/\/$/, '').replace(/\/openai\/v1$/, '');
    if (!KEY || !RAW_ENDPOINT) return reject(new Error('AZURE_OPENAI_KEY/ENDPOINT yo\'q'));
    const payload = JSON.stringify({ input: String(text).slice(0, 8000) });
    const url = new URL(RAW_ENDPOINT + '/openai/deployments/' + EMBED_DEPLOYMENT + '/embeddings?api-version=2024-06-01');
    const req = https.request(url, { method: 'POST', headers: { 'api-key': KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.data && parsed.data[0] && parsed.data[0].embedding) resolve(parsed.data[0].embedding);
          else reject(new Error(parsed.error?.message || 'embedding topilmadi'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('embedding timeout')); });
    req.write(payload); req.end();
  });
}

// Embedding'lar (har biri 1536 ta kasr son) JSON massiv sifatida son
// boshiga ~20 baytgacha sarflardi (matn ko'rinishida). Float32 ikkilik +
// base64 sifatida saqlash hajmni ~4 baravar kamaytiradi (552 yozuvda
// 16.5MB -> ~4MB atrofida).
function encodeEmbedding(arr) {
  return Buffer.from(Float32Array.from(arr).buffer).toString('base64');
}
function decodeEmbedding(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

function loadEmbedIndex() {
  let idx;
  try { idx = JSON.parse(fs.readFileSync(EMBED_INDEX_FILE, 'utf8')); } catch (e) { return { entries: [] }; }
  // Eski (JSON-massiv) formatdagi yozuvlarni yangi ixcham formatga
  // bir martalik ko'chirish — qayta embedding hisoblash shart emas,
  // faqat qayta kodlanadi.
  let migrated = false;
  for (const e of idx.entries) {
    if (Array.isArray(e.embedding)) { e.embedding = encodeEmbedding(e.embedding); migrated = true; }
  }
  if (migrated) saveEmbedIndex(idx);
  return idx;
}
function saveEmbedIndex(idx) {
  try { fs.writeFileSync(EMBED_INDEX_FILE, JSON.stringify(idx)); } catch (e) {}
}

function blockId(file, block) {
  return require('crypto').createHash('sha1').update(file + '|' + block).digest('hex');
}

// Barcha Memory/*.md fayllarini ko'rib, hali indekslanmagan (yangi)
// bloklarni topib, ular uchun embedding hisoblab, indeksga qo'shadi.
async function updateEmbedIndex() {
  ensureDirs();
  if (!fs.existsSync(MEMORY_DIR)) return { status: 'ok', added: 0 };
  const idx = loadEmbedIndex();
  const known = new Set(idx.entries.map(e => e.id));
  const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'));
  let added = 0;
  for (const file of files) {
    const date = file.replace('.md', '');
    const content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf8');
    const blocks = content.split(/^---$/m).map(b => b.trim()).filter(Boolean);
    for (const block of blocks) {
      const m = block.match(/^## (\d{2}:\d{2}) — (.+)$/m);
      if (!m) continue;
      const id = blockId(file, block);
      if (known.has(id)) continue;
      try {
        const embedding = await embedText(block.slice(0, 2000));
        idx.entries.push({ id, file, date, time: m[1], topic: m[2].trim(), snippet: block.slice(0, 500), embedding: encodeEmbedding(embedding) });
        known.add(id);
        added++;
      } catch (e) { /* bitta bloqda xato bo'lsa, qolganlarini davom ettiramiz */ }
    }
  }
  if (added > 0) saveEmbedIndex(idx);
  return { status: 'ok', added, total: idx.entries.length };
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function semanticSearch(query, limit = 5) {
  await updateEmbedIndex();
  const idx = loadEmbedIndex();
  if (!idx.entries.length) return { status: 'empty', results: [] };
  let qEmbedding;
  try { qEmbedding = await embedText(query); } catch (e) { return { status: 'error', message: e.message }; }
  const scored = idx.entries.map(e => ({ ...e, score: cosineSim(qEmbedding, decodeEmbedding(e.embedding)) }));
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, limit).map(({ embedding, ...rest }) => rest);
  return { status: 'ok', query, results };
}

// ── 3. Sessiya konteksti ─────────────────────────────────────────────
function readSessionContext() {
  if (!fs.existsSync(CONTEXT_FILE)) return '';
  return fs.readFileSync(CONTEXT_FILE, 'utf8');
}
function writeSessionContext(text) {
  ensureDirs();
  fs.writeFileSync(CONTEXT_FILE, text, 'utf8');
}
function appendSessionContext(text) {
  ensureDirs();
  const existing = fs.existsSync(CONTEXT_FILE) ? fs.readFileSync(CONTEXT_FILE, 'utf8') : '';
  fs.writeFileSync(CONTEXT_FILE, existing + '\n' + text, 'utf8');
}

// ── 4. Profil ────────────────────────────────────────────────────────
function readProfile() {
  if (!fs.existsSync(PROFILE_FILE)) {
    return { status: 'empty', content: '' };
  }
  return { status: 'ok', content: fs.readFileSync(PROFILE_FILE, 'utf8') };
}
function updateProfile(section, value, source = 'user') {
  ensureDirs();
  let content = '';
  if (fs.existsSync(PROFILE_FILE)) content = fs.readFileSync(PROFILE_FILE, 'utf8');
  else content = '# Foydalanuvchi Profili\n\nAvtoyaratilgan. Bu yerda foydalanuvchi haqida muhim ma\'lumotlar saqlanadi.\n\nBog\'liq: [[DailyTasks]] · kunlik yozuvlar `Jarvis/Memory/`\n\n';

  const today = localDateStr();
  const marker = `## ${section}`;
  const suffix = ` *(manba: ${source})* — [[${today}]]`;
  const newBlock = `${marker}\n- ${value}${suffix}\n\n`;

  if (content.includes(marker)) {
    // Mavjud bo'limni yangilash
    const regex = new RegExp(`## ${section}\\s*\\n([^#]*)(?=\\n## |$)`, 's');
    content = content.replace(regex, `## ${section}\n- ${value}${suffix}\n\n`);
  } else {
    content += newBlock;
  }

  fs.writeFileSync(PROFILE_FILE, content, 'utf8');
  return { status: 'ok' };
}

// ── 4b. Talaffuz eslatmalari ─────────────────────────────────────────
// Foydalanuvchi realtime suhbatda noto'g'ri eshitilgan so'zni tuzatsa,
// juftlik keyingi sessiyalar instructions'iga qo'shilishi uchun saqlanadi.
function readPronunciationEntries() {
  if (!fs.existsSync(PRONUNCIATION_FILE)) return [];
  const content = fs.readFileSync(PRONUNCIATION_FILE, 'utf8');
  const entries = [];
  content.split('\n').forEach(line => {
    const m = line.match(/^- "(.+?)" emas, "(.+?)" \(/);
    if (m) entries.push({ misheard: m[1], actual: m[2] });
  });
  return entries;
}

function addPronunciationNote(misheard, actual) {
  if (!misheard || !actual) return { status: 'error', message: 'misheard va actual kerak' };
  ensureDirs();
  const normalizedMisheard = String(misheard).trim();
  const normalizedActual = String(actual).trim();
  const entries = readPronunciationEntries();
  if (entries.some(e =>
    e.misheard.toLowerCase() === normalizedMisheard.toLowerCase()
    && e.actual.toLowerCase() === normalizedActual.toLowerCase()
  )) return { status: 'duplicate' };

  entries.push({ misheard: normalizedMisheard, actual: normalizedActual, date: localDateStr() });
  const retained = entries.slice(-PRONUNCIATION_MAX);
  const header = '# Talaffuz eslatmalari\n\nJarvis foydalanuvchini noto\'g\'ri tushunib, u to\'g\'rilaganda shu yerga avtomatik yozadi.\n\nBog\'liq: [[User]]\n\n';
  const body = retained.map(e => `- "${e.misheard}" emas, "${e.actual}" (${e.date || localDateStr()})`).join('\n') + '\n';
  fs.writeFileSync(PRONUNCIATION_FILE, header + body, 'utf8');
  return { status: 'ok' };
}

function getPronunciationNotes(limit = 40) {
  return readPronunciationEntries().slice(-limit);
}

// ── 5. CLI interfeysi ────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const input = fs.readFileSync(0, 'utf8').trim();
  let payload;
  try { payload = JSON.parse(input); } catch (e) { payload = { action: 'search', query: input }; }

  ensureDirs();

  switch (payload.action) {
    case 'pronunciation_add':
      console.log(JSON.stringify(addPronunciationNote(payload.misheard, payload.actual)));
      return;

    case 'pronunciation_list':
      console.log(JSON.stringify({ status: 'ok', entries: getPronunciationNotes(payload.limit || 40) }));
      return;

    case 'semantic_search': {
      if (!payload.query) { console.log(JSON.stringify({ status: 'error', message: 'query kerak' })); return; }
      const ssr = await semanticSearch(payload.query, payload.limit || 5);
      console.log(JSON.stringify(ssr));
      return;
    }
    case 'write':
      if (!payload.topic || !payload.content) {
        console.log(JSON.stringify({ status: 'error', message: 'topic va content kerak' }));
        return;
      }
      const wr = writeMemory(payload.topic, payload.content, payload.tags || []);
      console.log(JSON.stringify(wr));
      break;

    case 'search':
      const sr = searchMemory(payload.query || payload.topic || '', payload.limit || 5);
      console.log(JSON.stringify(sr));
      break;

    case 'context_read':
      console.log(JSON.stringify({ status: 'ok', context: readSessionContext() }));
      break;

    case 'context_write':
      writeSessionContext(payload.text || '');
      console.log(JSON.stringify({ status: 'ok' }));
      break;

    case 'profile_read':
      console.log(JSON.stringify(readProfile()));
      break;

    case 'profile_update':
      if (!payload.section || !payload.value) {
        console.log(JSON.stringify({ status: 'error', message: 'section va value kerak' }));
        return;
      }
      const pr = updateProfile(payload.section, payload.value, payload.source || 'user');
      console.log(JSON.stringify(pr));
      break;

    default:
      console.log(JSON.stringify({ status: 'error', message: 'Noma\'lum action: ' + payload.action }));
  }
}

if (require.main === module) main();

module.exports = {
  writeMemory, searchMemory, semanticSearch, updateEmbedIndex,
  readSessionContext, writeSessionContext, appendSessionContext,
  readProfile, updateProfile,
  addPronunciationNote, getPronunciationNotes,
  MEMORY_DIR, PROFILE_FILE, CONTEXT_FILE, PRONUNCIATION_FILE
};
