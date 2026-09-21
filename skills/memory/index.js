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
const { MemoryOS, redactSensitive } = require('../../core/memory-os');

const VAULT = process.env.OBSIDIAN_VAULT
  || (require('os').homedir() + '/Documents/Obsidian Vault');

const MEMORY_DIR = path.join(VAULT, 'Jarvis', 'Memory');
const PROFILE_FILE = path.join(VAULT, 'Jarvis', 'Profile', 'User.md');
const CONTEXT_FILE = path.join(VAULT, 'Jarvis', 'Profile', 'SessionContext.md');
// Diskdagi haqiqiy fayl nomi birlik ("Pronunciation.md") -- bu konstanta
// avval ko'plik ("Pronunciations.md") deb yozilgan bo'lib, mos kelmagani
// uchun getPronunciationNotes() doim bo'sh qaytargan va foydalanuvchi
// tuzatgan barcha talaffuz xatolari amalda hech qachon ishlatilmagan.
const PRONUNCIATION_FILE = path.join(VAULT, 'Jarvis', 'Profile', 'Pronunciation.md');
const PRONUNCIATION_MAX = 100;
const SESSION_CONTEXT_MAX_TURNS = 12;
const SESSION_CONTEXT_MAX_CHARS = 6000;

const { PROJECT_DIR } = require('../../core/paths');
const { readEnvFile } = require('../../core/config');
const MEMORY_OS_FILE = process.env.JARVIS_MEMORY_OS_FILE || path.join(PROJECT_DIR, '.jarvis-memory-os.json');
const memoryOS = new MemoryOS({ file: MEMORY_OS_FILE });
let _azureEnv = null;
let _pgPool = null;
function azureEnv(k, def) {
  if (process.env[k] !== undefined) return process.env[k];
  if (!_azureEnv) { try { _azureEnv = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8'); } catch (e) { _azureEnv = ''; } }
  const m = _azureEnv.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : def;
}

function postgresConfig() {
  let values = {};
  try { values = readEnvFile(path.join(PROJECT_DIR, '.env')); } catch (_) {}
  const config = {};
  for (const name of ['host', 'port', 'database', 'user', 'password']) {
    const envName = `PG${name.toUpperCase()}`;
    const value = process.env[envName] ?? values[envName];
    if (value !== undefined && value !== '') config[name] = value;
  }
  return config;
}

function getPgPool() {
  if (_pgPool) return _pgPool;
  const { Pool } = require('pg');
  _pgPool = new Pool({ ...postgresConfig(), max: 4, idleTimeoutMillis: 30_000 });
  return _pgPool;
}

function vectorLiteral(vector) {
  return `[${Array.from(vector, Number).join(',')}]`;
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
function inferLayer(topic, tags = []) {
  const haystack = `${topic} ${tags.join(' ')}`.toLocaleLowerCase();
  if (/profile|preference|foydalanuvchi|odat/.test(haystack)) return 'user_profile';
  if (/procedure|workflow|fast-action|qanday bajar/.test(haystack)) return 'procedural';
  if (/fact|knowledge|xulosa|naqsh/.test(haystack)) return 'semantic';
  if (/session|context|working|joriy/.test(haystack)) return 'working';
  return 'episodic';
}

function rememberStructured(input) {
  return memoryOS.remember(input);
}

function retrieveStructured(query, options = {}) {
  return memoryOS.retrieve(query, options);
}

function writeMemory(topic, content, tags = [], options = {}) {
  ensureDirs();
  const safeTopic = redactSensitive(topic).text;
  const safeContent = redactSensitive(content).text;
  const date = localDateStr();
  const time = new Date().toTimeString().slice(0, 5);
  const filePath = path.join(MEMORY_DIR, date + '.md');

  const tagLine = tags.length ? '\n**Teglar:** ' + tags.map(t => `#${t}`).join(' ') + '\n' : '';
  const block = `
---
## ${time} — ${safeTopic}
${safeContent}
${tagLine}
`;

  let existing = '';
  if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf8');
  else existing = `# ${date} — Jarvis Xotirasi\n\nBog'liq: [[User]] · [[DailyTasks]]\n\n`;

  fs.writeFileSync(filePath, existing + block, 'utf8');
  let structured = null;
  try {
    structured = rememberStructured({
      id: options.id,
      layer: options.layer || inferLayer(safeTopic, tags), title: safeTopic, content: safeContent,
      tags, source: options.source || 'legacy-writeMemory', confidence: options.confidence ?? 0.7,
      privacy: options.privacy, ttlMs: options.ttlMs, fact: options.fact, entities: options.entities
    });
  } catch (_) {}
  return { status: 'ok', file: filePath, memoryId: structured?.record?.id || null };
}

function atomicWrite(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function renderTurn(turn) {
  const lines = [
    `<!-- turnId:${turn.turnId} -->`,
    `**Turn ID:** ${turn.turnId}`,
    `**Holat:** ${turn.status || 'accepted'}`,
    `Foydalanuvchi: ${turn.user || '(javob kutilmoqda)'}`
  ];
  if (turn.assistant) lines.push(`Jarvis: ${turn.assistant}`);
  for (const tool of turn.tools || []) {
    lines.push(`Vazifa [${tool.status || 'running'}] ${tool.description || tool.callId}: ${tool.result || ''}`.trim());
  }
  if (turn.error) lines.push(`Xatolik: ${turn.error}`);
  return lines.join('\n');
}

function upsertTurnMemory(turn) {
  if (!turn?.turnId || !turn?.user) throw new Error('Persist qilish uchun turnId va accepted user text kerak');
  ensureDirs();
  const safeTurn = {
    ...turn,
    turnId: redactSensitive(turn.turnId).text.slice(0, 300),
    user: redactSensitive(turn.user).text.slice(0, 4000),
    assistant: redactSensitive(turn.assistant || '').text.slice(0, 4000),
    error: redactSensitive(turn.error || '').text.slice(0, 1000),
    tools: (turn.tools || []).slice(-20).map(tool => ({
      callId: redactSensitive(tool.callId || '').text.slice(0, 300),
      description: redactSensitive(tool.description || '').text.slice(0, 1000),
      result: redactSensitive(tool.result || '').text.slice(0, 3000),
      status: String(tool.status || '').slice(0, 40)
    }))
  };
  const date = localDateStr(new Date(turn.createdAt || Date.now()));
  const time = new Date(turn.createdAt || Date.now()).toTimeString().slice(0, 5);
  const filePath = path.join(MEMORY_DIR, date + '.md');
  const header = `# ${date} — Jarvis Xotirasi\n\nBog'liq: [[User]] · [[DailyTasks]]\n\n`;
  let existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : header;
  const marker = `<!-- turnId:${safeTurn.turnId} -->`;
  const block = `---\n## ${time} — Ovozli turn\n${renderTurn(safeTurn)}\n\n**Teglar:** #voice #turn-journal\n`;
  const start = existing.indexOf(marker);
  if (start >= 0) {
    const separator = existing.lastIndexOf('---\n', start);
    const next = existing.indexOf('\n---\n', start);
    existing = existing.slice(0, separator < 0 ? start : separator) + block + (next < 0 ? '' : existing.slice(next + 1));
  } else {
    existing += (existing.endsWith('\n') ? '' : '\n') + block;
  }
  atomicWrite(filePath, existing);

  const content = renderTurn(safeTurn);
  const structured = rememberStructured({
    id: `turn:${safeTurn.turnId}`, layer: 'episodic', title: 'Ovozli turn', content,
    tags: ['voice', 'turn-journal', safeTurn.status || 'accepted'], source: safeTurn.source || 'voice',
    confidence: 0.95, privacy: 'private', createdAt: safeTurn.createdAt
  });
  updateSessionContext(safeTurn);
  return { status: 'ok', file: filePath, memoryId: structured.record.id, turnId: safeTurn.turnId };
}

// ── 2. Xotira qidirish (grep) ────────────────────────────────────────
function searchMemory(query, limit = 5) {
  ensureDirs();

  // Birinchi to'g'ri matn qidiruvi
  const results = [];
  const files = (fs.existsSync(MEMORY_DIR) ? fs.readdirSync(MEMORY_DIR) : [])
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

  const structured = retrieveStructured(query, { limit }).map(record => ({
    id: record.id, layer: record.layer, title: record.title, content: record.content,
    confidence: record.confidence, score: record.score, source: record.source
  }));
  return { status: 'ok', query, results, structured };
}

// ── 2b. Semantik (ma'no bo'yicha) qidiruv — RAG ─────────────────────────
// Oddiy grep faqat bir xil so'zni topadi ("topdim.uz" desa faqat shu so'z
// bor joylarni). Semantik qidiruv ma'noga qaraydi — "loyihamda qanday
// xato bor edi" kabi savol bilan "topdim.uz'da bug topildi" degan
// yozuvni ham topa oladi, so'zlar mos kelmasa ham.
function embedText(text) {
  return new Promise((resolve, reject) => {
    const KEY = azureEnv('AZURE_EMBEDDING_KEY', azureEnv('AZURE_OPENAI_KEY'));
    const RAW_ENDPOINT = (azureEnv('AZURE_EMBEDDING_ENDPOINT', azureEnv('AZURE_OPENAI_ENDPOINT')) || '').replace(/\/$/, '').replace(/\/openai\/v1$/, '');
    // Bazadagi yorliq (AZURE_EMBEDDING_DEPLOYMENT) eski yozuvlarga bog'langan; haqiqiy Azure deployment nomi alohida bo'lishi mumkin.
    const deployment = azureEnv('AZURE_EMBEDDING_API_DEPLOYMENT', azureEnv('AZURE_EMBEDDING_DEPLOYMENT', 'text-embedding-3-large-2'));
    if (!KEY || !RAW_ENDPOINT) return reject(new Error('AZURE_EMBEDDING_KEY/ENDPOINT yo\'q'));
    const payload = JSON.stringify({ model: deployment, input: String(text).slice(0, 8000) });
    const url = new URL(RAW_ENDPOINT + '/openai/v1/embeddings');
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

function rerank(query, documents, limit) {
  const endpoint = azureEnv('AZURE_RERANK_ENDPOINT');
  const key = azureEnv('AZURE_RERANK_KEY');
  if (!endpoint || !key || !documents.length) return Promise.resolve(null);
  const payload = JSON.stringify({
    model: azureEnv('AZURE_RERANK_DEPLOYMENT', 'Cohere-rerank-v4.0-pro'),
    query: String(query).slice(0, 4000), documents,
    top_n: Math.max(1, Math.min(limit, documents.length))
  });
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(endpoint), {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(parsed.error?.message || `rerank HTTP ${res.statusCode}`));
          resolve(Array.isArray(parsed.results) ? parsed.results : null);
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('rerank timeout')); });
    req.write(payload); req.end();
  });
}

function blockId(file, block) {
  return require('crypto').createHash('sha1').update(file + '|' + block).digest('hex');
}

// Obsidian Markdown is canonical. PostgreSQL stores only its derived vectors.
async function updateEmbedIndex() {
  ensureDirs();
  if (!fs.existsSync(MEMORY_DIR)) return { status: 'ok', added: 0 };
  const embeddingModel = azureEnv('AZURE_EMBEDDING_DEPLOYMENT', 'text-embedding-3-large-2');
  const pool = getPgPool();
  const knownRows = await pool.query('SELECT id FROM jarvis.memory_embeddings WHERE embedding_model = $1', [embeddingModel]);
  const known = new Set(knownRows.rows.map(row => row.id));
  const upsert = `INSERT INTO jarvis.memory_embeddings
    (id, source_file, memory_date, memory_time, topic, snippet, embedding, embedding_model, source_hash, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7::halfvec,$8,$9,now())
    ON CONFLICT (id) DO UPDATE SET source_file=EXCLUDED.source_file, memory_date=EXCLUDED.memory_date,
    memory_time=EXCLUDED.memory_time, topic=EXCLUDED.topic, snippet=EXCLUDED.snippet, embedding=EXCLUDED.embedding,
    embedding_model=EXCLUDED.embedding_model, source_hash=EXCLUDED.source_hash, updated_at=now()`;
  const files = (await fs.promises.readdir(MEMORY_DIR)).filter(f => f.endsWith('.md'));
  let added = 0;
  for (const file of files) {
    const date = file.replace('.md', '');
    const content = await fs.promises.readFile(path.join(MEMORY_DIR, file), 'utf8');
    const blocks = content.split(/^---$/m).map(b => b.trim()).filter(Boolean);
    for (const block of blocks) {
      const m = block.match(/^## (\d{2}:\d{2}) — (.+)$/m);
      if (!m) continue;
      const id = blockId(file, block);
      if (known.has(id)) continue;
      try {
        const embedding = await embedText(block.slice(0, 2000));
        await pool.query(upsert, [id, file, date, m[1], m[2].trim(), block.slice(0, 500), vectorLiteral(embedding), embeddingModel, id]);
        known.add(id);
        added++;
      } catch (e) { /* bitta bloqda xato bo'lsa, qolganlarini davom ettiramiz */ }
    }
  }
  const count = await pool.query('SELECT count(*)::int AS total FROM jarvis.memory_embeddings WHERE embedding_model = $1', [embeddingModel]);
  return { status: 'ok', added, total: count.rows[0].total };
}

async function semanticSearch(query, limit = 5, options = {}) {
  if (!options.skipIndexUpdate) await updateEmbedIndex();
  let qEmbedding;
  try { qEmbedding = await embedText(query); } catch (e) { return { status: 'error', message: e.message }; }
  let results;
  try {
    const candidateLimit = Math.max(limit, 20);
    const rows = await getPgPool().query(`SELECT id, source_file AS file, memory_date::text AS date,
      memory_time::text AS time, topic, snippet, 1 - (embedding <=> $1::halfvec) AS score
      FROM jarvis.memory_embeddings WHERE embedding_model = $2
      ORDER BY embedding <=> $1::halfvec LIMIT $3`, [vectorLiteral(qEmbedding), azureEnv('AZURE_EMBEDDING_DEPLOYMENT', 'text-embedding-3-large-2'), candidateLimit]);
    results = rows.rows;
  } catch (e) { return { status: 'error', message: e.message, results: [] }; }
  if (!results.length) return { status: 'empty', results: [] };
  try {
    const ranked = await rerank(query, results.map(item => `${item.topic}\n${item.snippet}`), limit);
    if (ranked) results = ranked.map(item => ({ ...results[item.index], rerankScore: item.relevance_score })).filter(Boolean);
  } catch (_) {}
  return { status: 'ok', query, results: results.slice(0, limit) };
}

// ── 3. Sessiya konteksti ─────────────────────────────────────────────
function readSessionContext() {
  if (!fs.existsSync(CONTEXT_FILE)) return '';
  return fs.readFileSync(CONTEXT_FILE, 'utf8');
}
function writeSessionContext(text) {
  ensureDirs();
  atomicWrite(CONTEXT_FILE, String(text || '').slice(-SESSION_CONTEXT_MAX_CHARS));
}
function appendSessionContext(text) {
  ensureDirs();
  const existing = fs.existsSync(CONTEXT_FILE) ? fs.readFileSync(CONTEXT_FILE, 'utf8') : '';
  const bounded = (existing + '\n' + text).slice(-SESSION_CONTEXT_MAX_CHARS);
  atomicWrite(CONTEXT_FILE, bounded);
}

function updateSessionContext(turn) {
  ensureDirs();
  let turns = [];
  if (fs.existsSync(CONTEXT_FILE)) {
    try {
      const match = fs.readFileSync(CONTEXT_FILE, 'utf8').match(/```json\n([\s\S]*?)\n```/);
      if (match) turns = JSON.parse(match[1]);
    } catch (_) {}
  }
  const compact = {
    turnId: turn.turnId, at: turn.updatedAt || Date.now(), status: turn.status,
    user: String(turn.user || '').slice(0, 500), assistant: String(turn.assistant || '').slice(0, 700),
    tasks: (turn.tools || []).slice(-5).map(tool => ({ status: tool.status, description: String(tool.description || '').slice(0, 240), result: String(tool.result || '').slice(0, 300) }))
  };
  const index = turns.findIndex(item => item.turnId === compact.turnId);
  if (index >= 0) turns[index] = compact; else turns.push(compact);
  turns = turns.slice(-SESSION_CONTEXT_MAX_TURNS);
  while (JSON.stringify(turns).length > SESSION_CONTEXT_MAX_CHARS && turns.length > 1) turns.shift();
  atomicWrite(CONTEXT_FILE, '# Jarvis Session Context\n\nFaqat Jarvisga qaratilgan so‘nggi turnlar. Avtomatik yangilanadi.\n\n```json\n' + JSON.stringify(turns, null, 2) + '\n```\n');
  return { status: 'ok', turns: turns.length };
}

async function recallMemory(query, limit = 6) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return { status: 'error', message: 'query kerak', results: [] };
  const merged = [];
  const seen = new Set();
  const add = (item) => {
    const key = item.id || `${item.source}:${item.title}:${item.content}`;
    if (!seen.has(key)) { seen.add(key); merged.push(item); }
  };
  try {
    const semantic = await semanticSearch(cleanQuery, limit, { skipIndexUpdate: true });
    for (const item of semantic.results || []) add({ id: item.id, source: 'semantic', date: item.date, title: item.topic, content: item.snippet, score: item.score });
  } catch (_) {}
  try {
    const lexical = searchMemory(cleanQuery, limit);
    for (const item of lexical.results || []) add({ id: item.file, source: 'lexical', date: item.date, title: item.file, content: item.matches.map(match => match.text).join(' | ') });
    for (const item of lexical.structured || []) add({ ...item, source: item.source || 'structured' });
  } catch (_) {}
  try {
    const profile = readProfile();
    if (profile.status === 'ok' && /\b(profile|preference|prefer|men haqimda|yoqtir|odat)\b/i.test(cleanQuery)) {
      add({ id: 'profile', source: 'profile', title: 'User profile', content: profile.content.slice(0, 2500) });
    }
  } catch (_) {}
  try {
    const context = readSessionContext();
    const tokens = cleanQuery.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 3);
    if (tokens.some(token => context.toLowerCase().includes(token))) add({ id: 'session-context', source: 'recent-turns', title: 'Recent turns', content: context.slice(-2500) });
  } catch (_) {}
  return { status: 'ok', query: cleanQuery, results: merged.slice(0, Math.max(1, limit)) };
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
  try {
    rememberStructured({
      layer: 'user_profile', title: section, content: value, source,
      confidence: source === 'user' ? 0.95 : 0.7,
      fact: { subject: 'user', predicate: section, object: value }
    });
  } catch (_) {}
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
    case 'remember': {
      try { console.log(JSON.stringify(rememberStructured(payload))); }
      catch (error) { console.log(JSON.stringify({ status: 'error', message: error.message })); }
      return;
    }
    case 'retrieve':
      console.log(JSON.stringify({ status: 'ok', results: retrieveStructured(payload.query || '', { limit: payload.limit || 5, layers: payload.layers }) }));
      return;
    case 'purge_expired':
      console.log(JSON.stringify(memoryOS.purgeExpired()));
      return;
    case 'migrate_legacy':
      console.log(JSON.stringify(memoryOS.migrateLegacy({ memoryDir: MEMORY_DIR, profileFile: PROFILE_FILE })));
      return;
    case 'snapshot':
      console.log(JSON.stringify({ status: 'ok', memory: memoryOS.snapshot() }));
      return;
    case 'write':
      if (!payload.topic || !payload.content) {
        console.log(JSON.stringify({ status: 'error', message: 'topic va content kerak' }));
        return;
      }
      const wr = writeMemory(payload.topic, payload.content, payload.tags || [], payload.options || {});
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
  upsertTurnMemory, updateSessionContext, recallMemory,
  rememberStructured, retrieveStructured, memoryOS,
  readSessionContext, writeSessionContext, appendSessionContext,
  readProfile, updateProfile,
  addPronunciationNote, getPronunciationNotes,
  MEMORY_DIR, PROFILE_FILE, CONTEXT_FILE, PRONUNCIATION_FILE, MEMORY_OS_FILE,
  postgresConfig, getPgPool
};
