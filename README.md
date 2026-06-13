# Ask Your Codebase

Point it at any **public GitHub repo**, and it indexes the code into a vector
database so you can ask plain-English questions and get answers with
**file + line citations**.

It's a RAG (Retrieval-Augmented Generation) app done carefully:
- **Retrieval** uses real embeddings + pgvector similarity search, not keyword grep.
- **Answers are grounded**: the model must cite the exact code snippets it used,
  and answers that cite nothing are flagged as a possible hallucination.

> New here? Read **[CODEBASE_GUIDE.md](./CODEBASE_GUIDE.md)** — a plain-English,
> file-by-file walkthrough of how the whole thing works.

---

## Architecture

```
GitHub repo URL ──▶ clone (simple-git) ──▶ chunk files ──▶ embed (Gemini)
                                                              │
                                                              ▼
React (Vite) ◀──── JSON answer + citations ◀──── NestJS ◀── pgvector (top-k search)
   question ───────────────────────────────▶ NestJS ── Gemini (grounded, cited) ┘
```

- **Frontend:** React + TypeScript (Vite) — `frontend/`
- **Backend:** NestJS + TypeScript — `backend/`
- **Embeddings:** Google Gemini `gemini-embedding-001` (768-dim)
- **Generation:** Google Gemini `gemini-2.5-flash` via `@google/genai`
- **Vector store:** Postgres + `pgvector` (runs in Docker)

> One Gemini key powers **both** embeddings and generation — no second provider,
> and it runs entirely on the free tier (no payment required).

---

## Prerequisites

- **Node 18+** and **npm**
- **Docker** (for the Postgres + pgvector container)
- **One free API key** — **Gemini**, from Google AI Studio:
  https://aistudio.google.com/apikey (the developer API key, **not** the consumer
  "Gemini Advanced/Pro" app subscription). It powers both embeddings and answers.
  - Note: if a model reports `free tier limit 0` for your key, switch
    `GEMINI_MODEL` (e.g. to `gemini-2.5-flash-lite`) — see `.env.example`.

---

## Setup & run

```bash
# 1. From the repo root: copy the env template and fill in your Gemini key
cp .env.example backend/.env
#    then edit backend/.env -> set GEMINI_API_KEY

# 2. Start the vector database (Postgres + pgvector) in Docker
docker compose up -d

# 3. Backend (http://localhost:3000)
cd backend
npm install        # first time only
npm run start:dev  # boots, auto-creates the DB schema, watches for changes

# 4. Frontend (http://localhost:5173) — in a second terminal
cd frontend
npm install        # first time only
npm run dev
```

Open http://localhost:5173, paste a GitHub URL, wait for indexing to reach
**ready**, then ask a question.

---

## API (backend)

| Method | Route               | Purpose                                            |
| ------ | ------------------- | -------------------------------------------------- |
| `POST` | `/repos`            | Start indexing a repo. Body `{ url }`. Returns the new repo (status `pending`). |
| `GET`  | `/repos/:id`        | Poll indexing status (`pending`→`cloning`→`chunking`→`embedding`→`ready`/`error`). |
| `POST` | `/repos/:id/ask`    | Ask a question. Body `{ question }`. Returns `{ answer, citations, grounded }`. |

---

## Project status

Built in milestones (see `.claude/plans` for the full plan):

- ✅ **M1 — Scaffold + infra:** monorepo, Docker pgvector, NestJS + Vite apps.
- ✅ **M2 — Ingest:** clone → walk → chunk → embed → store in pgvector.
- ✅ **M3 — Grounded answering:** top-k retrieval → Gemini → cited answer; React UI.
- ⏳ **M4 — AST-aware chunking** (tree-sitter, function/class boundaries).
- ⏳ **M5 — Token streaming** (SSE) + in-app code viewer for citations.
- ⏳ **M6 — Polish, deploy notes, screenshots.**

> The current chunker is a simple line-window splitter (see `chunker.service.ts`);
> milestone 4 swaps it for AST-aware chunking without changing anything downstream.
