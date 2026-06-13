-- ===========================================================================
-- schema.sql  —  the database structure for Ask-Your-Codebase.
--
-- This file is executed once on backend startup by DbService (see db.service.ts).
-- Every statement is idempotent (IF NOT EXISTS), so running it repeatedly is
-- safe — it only creates things that aren't already there.
-- ===========================================================================

-- pgvector ships as a Postgres EXTENSION. Enabling it unlocks the `vector`
-- column type and the `<=>` cosine-distance operator we use for search.
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- repos: one row per GitHub repository the user has asked us to index.
-- `status` tracks the async indexing job so the UI can poll for progress.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url             TEXT NOT NULL,
  default_branch  TEXT,
  -- pending -> cloning -> chunking -> embedding -> ready  (or 'error')
  status          TEXT NOT NULL DEFAULT 'pending',
  error           TEXT,                 -- populated if status = 'error'
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  indexed_at      TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- code_chunks: the heart of the RAG system. Each row is a small slice of a
-- source file plus its embedding vector. At query time we find the chunks
-- whose vectors are closest to the question's vector.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS code_chunks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id      UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  file_path    TEXT NOT NULL,           -- path inside the repo, e.g. src/auth/auth.service.ts
  start_line   INTEGER NOT NULL,        -- 1-based first line of this chunk
  end_line     INTEGER NOT NULL,        -- 1-based last line (inclusive)
  language     TEXT,                    -- inferred from file extension
  symbol_name  TEXT,                    -- function/class/method name from AST chunking (null for line-window chunks)
  content      TEXT NOT NULL,           -- the actual code text of this chunk
  -- The embedding. vector(384) matches the local model all-MiniLM-L6-v2.
  -- If you swap the embedding model, change this size to match and recreate
  -- the table (see embeddings.service.ts).
  embedding    vector(384) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast filtering of chunks by repo.
CREATE INDEX IF NOT EXISTS code_chunks_repo_idx ON code_chunks (repo_id);

-- ANN (approximate nearest neighbour) index for the embedding column.
-- ivfflat with vector_cosine_ops makes "find the closest vectors" queries fast.
-- `lists` = number of buckets; 100 is a fine default for small/medium datasets.
-- NOTE: ivfflat only speeds up queries once the table has data; on an empty
-- table Postgres just scans, which is fine for our scale.
CREATE INDEX IF NOT EXISTS code_chunks_embedding_idx
  ON code_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ---------------------------------------------------------------------------
-- query_logs: optional history of questions asked (handy for a "recent
-- questions" UI and for debugging which chunks were cited).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS query_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  question        TEXT NOT NULL,
  answer          TEXT,
  cited_chunk_ids UUID[],               -- which chunks the answer cited
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
