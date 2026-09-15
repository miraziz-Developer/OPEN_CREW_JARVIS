#!/usr/bin/env node
'use strict';

// Review-first migration utility. It never connects or changes PostgreSQL
// unless --apply is explicitly supplied.
const fs = require('fs');
const path = require('path');
const { PROJECT_DIR } = require('../core/paths');
const { readEnvFile } = require('../core/config');

const INDEX_FILE = path.join(PROJECT_DIR, '.memory-embeddings.json');
const DIMENSIONS = 3072;
const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS jarvis;
CREATE TABLE IF NOT EXISTS jarvis.memory_embeddings (
  id text PRIMARY KEY, source_file text NOT NULL, memory_date date, memory_time time,
  topic text NOT NULL, snippet text NOT NULL, embedding halfvec(${DIMENSIONS}) NOT NULL,
  embedding_model text NOT NULL, source_hash text,
  migrated_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_embeddings_date_idx ON jarvis.memory_embeddings (memory_date DESC);
CREATE INDEX IF NOT EXISTS memory_embeddings_embedding_hnsw_idx
  ON jarvis.memory_embeddings USING hnsw (embedding halfvec_cosine_ops);
`;

function loadPostgresEnvironment() {
  const envFile = path.join(PROJECT_DIR, '.env');
  let values = {};
  try { values = readEnvFile(envFile); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const name of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
    if (process.env[name] === undefined && values[name] !== undefined) process.env[name] = values[name];
  }
}

function parseIndex(file = INDEX_FILE) {
  const index = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(index.entries)) throw new Error('Expected an object containing entries[]');
  return index;
}

function decodeVector(base64) {
  const bytes = Buffer.from(String(base64 || ''), 'base64');
  if (bytes.length !== DIMENSIONS * 4) throw new Error(`Expected ${DIMENSIONS} Float32 values; got ${bytes.length / 4}`);
  const input = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  return Array.from(input);
}

function vectorLiteral(vector) { return `[${vector.join(',')}]`; }

async function migrate(index) {
  let Client;
  try { ({ Client } = require('pg')); }
  catch (_) { throw new Error("Missing Node dependency 'pg'. Install it with: npm install pg"); }
  loadPostgresEnvironment();
  const client = new Client();
  await client.connect();
  try {
    const extension = await client.query("SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS available");
    if (!extension.rows[0].available) throw new Error('pgvector is not installed for this PostgreSQL server; install it before migration.');
    await client.query('BEGIN');
    await client.query(SCHEMA_SQL);
    const sql = `INSERT INTO jarvis.memory_embeddings
      (id, source_file, memory_date, memory_time, topic, snippet, embedding, embedding_model, source_hash, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::halfvec,$8,$9,now())
      ON CONFLICT (id) DO UPDATE SET source_file=EXCLUDED.source_file, memory_date=EXCLUDED.memory_date,
      memory_time=EXCLUDED.memory_time, topic=EXCLUDED.topic, snippet=EXCLUDED.snippet,
      embedding=EXCLUDED.embedding, embedding_model=EXCLUDED.embedding_model, source_hash=EXCLUDED.source_hash, updated_at=now()`;
    for (const entry of index.entries) {
      const vector = decodeVector(entry.embedding);
      await client.query(sql, [entry.id, entry.file, entry.date || null, entry.time || null, entry.topic || '', entry.snippet || '', vectorLiteral(vector), index.model || 'unknown', entry.id]);
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ status: 'ok', migrated: index.entries.length, dimensions: DIMENSIONS, model: index.model || null }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const index = parseIndex();
  const dimensions = index.entries.length ? decodeVector(index.entries[0].embedding).length : 0;
  const ids = new Set(index.entries.map(entry => entry.id));
  const report = { file: INDEX_FILE, entries: index.entries.length, uniqueIds: ids.size, dimensions, model: index.model || null, apply };
  if (!apply) {
    console.log(JSON.stringify({ status: 'dry-run', ...report, next: 'Review docs/memory-postgresql-migration.md, then run with --apply.' }, null, 2));
    return;
  }
  await migrate(index);
}

main().catch(error => { console.error('Migration not completed:', error.message); process.exitCode = 1; });

module.exports = { parseIndex, decodeVector, vectorLiteral, loadPostgresEnvironment, DIMENSIONS, SCHEMA_SQL };