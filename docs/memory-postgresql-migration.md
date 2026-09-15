# Memory embedding migration proposal: PostgreSQL + pgvector

## Objective

Replace the former `/.memory-embeddings.json` full-file load/rewrite path with PostgreSQL 14 and `pgvector`. PostgreSQL now persists the derived vectors, metadata, filtering, and nearest-neighbor search outside the voice process. Obsidian Markdown remains the canonical human-readable memory source.

## Preconditions (verified on this host)

- PostgreSQL 14 listens on port `5432`.
- `pgvector 0.8.6` is available and enabled in `memory_agent`.
- The Node.js `pg` package is installed.

The migration is complete. The retained command is idempotent and can be used to re-import a separately archived legacy index if recovery requires it.

## Proposed schema

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS jarvis;

CREATE TABLE jarvis.memory_embeddings (
  id text PRIMARY KEY,
  source_file text NOT NULL,
  memory_date date,
  memory_time time,
  topic text NOT NULL,
  snippet text NOT NULL,
  embedding halfvec(3072) NOT NULL,
  embedding_model text NOT NULL,
  source_hash text,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX memory_embeddings_date_idx ON jarvis.memory_embeddings (memory_date DESC);
CREATE INDEX memory_embeddings_embedding_hnsw_idx
  ON jarvis.memory_embeddings USING hnsw (embedding halfvec_cosine_ops);
```

`3072` is derived from the existing 16,384-character base64 encoding: 12,288 decoded bytes / 4 bytes per Float32. `halfvec` is used because pgvector HNSW indexes `vector` dimensions only up to 2,000, while `halfvec` supports 4,000 dimensions.

## Safe rollout

1. Run `scripts/migrate_memory_to_pg.js` against an archived legacy index to inspect count, dimension and duplicate IDs.
2. Run with `--apply` to use idempotent (`ON CONFLICT ... DO UPDATE`) PostgreSQL upserts.
3. Runtime semantic reads and derived embedding writes use PostgreSQL directly; no JSON rollback index is retained.

## Connection configuration

Use standard libpq environment variables, preferably a local Unix socket or `127.0.0.1:5432`: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`. Do not place credentials in the migration script.