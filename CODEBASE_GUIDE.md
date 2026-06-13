# Codebase Guide

A plain-English tour of the whole project, written so you can understand **what
each file does and how the pieces fit together**. Read this top-to-bottom once
and the code will make sense.

---

## 1. The big picture

There are two jobs in this app, and almost every file belongs to one of them:

1. **Indexing** ("learn this repo") — take a GitHub URL, download the code, cut
   it into small pieces, turn each piece into a vector (a list of numbers that
   captures its meaning), and store those in a database.
2. **Answering** ("ask about the repo") — take a question, turn it into a vector,
   find the stored code pieces whose vectors are closest, and ask an LLM to write
   an answer using only those pieces, citing where each fact came from.

This pattern is called **RAG — Retrieval-Augmented Generation**. The LLM doesn't
"know" your repo; we *retrieve* the relevant code and *feed* it to the LLM so its
answer is grounded in real code rather than guesswork.

```
                    INDEXING (once per repo)
 GitHub URL ─▶ clone ─▶ split into chunks ─▶ embed each chunk ─▶ store in pgvector

                    ANSWERING (per question)
 question ─▶ embed question ─▶ find nearest chunks ─▶ LLM writes a cited answer
```

---

## 2. Folder layout

```
ask-your-codebase/
├── docker-compose.yml      # the Postgres+pgvector database (the only infra)
├── .env.example            # template for the API keys / DB url
├── README.md               # how to run it
├── CODEBASE_GUIDE.md        # this file
│
├── backend/                # NestJS API (indexing + answering)
│   └── src/
│       ├── main.ts          # app entry point (CORS, validation, start server)
│       ├── app.module.ts    # root module: wires all the feature modules together
│       │
│       ├── db/              # database access
│       │   ├── schema.sql        # the tables + pgvector extension
│       │   ├── db.service.ts     # one shared connection pool + query helpers
│       │   └── db.module.ts      # makes DbService available app-wide (@Global)
│       │
│       ├── embeddings/      # text -> vector (Gemini)
│       │   ├── embeddings.service.ts
│       │   └── embeddings.module.ts
│       │
│       ├── gemini/          # answer generation (Google Gemini)
│       │   ├── gemini.service.ts
│       │   └── gemini.module.ts
│       │
│       ├── chunker/         # split a file into chunks
│       │   ├── chunker.service.ts
│       │   └── chunker.module.ts
│       │
│       ├── repos/           # INDEXING feature (clone -> chunk -> embed -> store)
│       │   ├── repos.controller.ts   # POST /repos, GET /repos/:id
│       │   ├── repos.service.ts      # the indexing pipeline
│       │   ├── repos.module.ts
│       │   └── dto/create-repo.dto.ts
│       │
│       └── ask/             # ANSWERING feature (retrieve -> generate -> cite)
│           ├── ask.controller.ts     # POST /repos/:id/ask  and  .../ask/stream (SSE)
│           ├── ask.service.ts        # the RAG flow (one-shot + streaming generator)
│           ├── chunks.controller.ts  # GET /chunks/:id  (code viewer source)
│           ├── ask.module.ts
│           └── dto/ask.dto.ts
│
└── frontend/               # React + Vite UI
    └── src/
        ├── api.ts                     # all calls to the backend live here
        ├── App.tsx                    # the orchestrator (state + polling)
        ├── App.css / index.css        # styles
        └── components/
            ├── RepoForm.tsx           # the "paste a GitHub URL" input
            ├── AnswerPanel.tsx        # renders the streaming answer + citations
            └── CodeViewer.tsx         # modal showing the cited code (line numbers)
```

---

## 3. NestJS in 60 seconds (so the backend makes sense)

NestJS organizes code into **modules**, **controllers**, and **services**:

- **Controller** = the HTTP layer. It maps a URL+method (e.g. `POST /repos`) to a
  method, validates the request body, and calls a service. No logic lives here.
- **Service** = the business logic (cloning, embedding, querying the DB, etc.).
  Services are **injected** into controllers/other services via the constructor —
  you never `new` them yourself; Nest creates one shared instance and hands it
  out (this is "dependency injection").
- **Module** = a box that groups related controllers/services and declares what it
  needs (`imports`) and what it shares (`exports`).

So "where does `POST /repos` go?" → `repos.controller.ts` → which calls
`repos.service.ts`. That pattern repeats everywhere.

---

## 4. The shared building blocks

These three services are used by both features.

### `db/` — the database
- **`schema.sql`** defines three tables: `repos` (one row per indexed repo, with a
  `status` for progress), `code_chunks` (the important one — each chunk's text +
  its `embedding vector(768)`), and `query_logs` (history). It also turns on the
  `pgvector` extension.
- **`db.service.ts`** opens one connection **pool** at startup, runs `schema.sql`
  (a tiny "migration" — safe to run every boot because everything is
  `IF NOT EXISTS`), and exposes `query()` for parameterised SQL plus
  `toVectorLiteral()` to format a JS number array as a pgvector value.
- **`db.module.ts`** is `@Global`, so `DbService` is injectable everywhere without
  re-importing it.

### `embeddings/` — text → vector (Gemini)
- **`embeddings.service.ts`** calls Gemini's `gemini-embedding-001` model to turn
  text into 768-number vectors. `embedDocuments()` is used at index time (batched,
  with retry/backoff on rate limits); `embedQuery()` at search time. It tells
  Gemini whether the text is a `RETRIEVAL_DOCUMENT` or a `RETRIEVAL_QUERY`, which
  improves match quality. (We chose Gemini over Voyage because Voyage's free tier
  throttles to 3 requests/min — Gemini's free tier is far more usable, and reusing
  the same key keeps the app on one provider.)

### `gemini/` — generation (Gemini)
- **`gemini.service.ts`** wraps Google's `@google/genai` SDK. `generate()` returns a
  full answer; `generateStream()` is ready for the future streaming milestone.
  Keeping all Gemini calls here means swapping the model/provider touches one file.

### `chunker/` — splitting files (AST-aware)
- **`chunker.service.ts`** turns a file's text into `RawChunk`s (text + start/end
  line + language + **symbol name**). It parses each file with **tree-sitter** and
  chunks on real syntax boundaries:
  - one chunk per top-level **function** and arrow-const (`const x = () => …`);
  - for a **class**: a "header" chunk (signature + fields) plus one chunk per
    **method**, named `ClassName.methodName`;
  - significant **callbacks** passed to calls (Express `router.get('/x', …)`,
    `.map`, event listeners) named after their call;
  - leftover lines (imports, top-level code) are captured by a line-window
    "gap fill" so nothing is ever dropped.
  Supported grammars: TS / TSX / JS / Python. Anything else (JSON, Markdown, CSS,
  or a file that fails to parse) **gracefully falls back** to plain line-window
  chunking. Oversized chunks are sub-split to keep embeddings focused. The public
  `chunkFile()` signature is unchanged from the original naive version, so the
  rest of the app didn't need to change — it just gets better chunks now.

---

## 5. Feature 1 — Indexing (`repos/`)

**Entry point:** `POST /repos { url }` → `repos.controller.ts` → `ReposService.createRepo()`.

`createRepo()` inserts a `pending` repo row and **returns immediately**, while the
real work runs in the background (`indexRepo()`, deliberately not `await`ed). That's
why the UI gets an id instantly and then polls for progress.

`indexRepo()` is the pipeline, and it updates the row's `status` at each stage:

1. **`cloning`** — `simple-git` shallow-clones the repo into `backend/.repos/<id>`.
2. **`chunking`** — `collectSourceFiles()` walks the repo (skipping `node_modules`,
   `.git`, lockfiles, oversized/binary files), then `chunker` splits each file.
   Safety caps (`MAX_FILES`, `MAX_CHUNKS`) prevent a giant repo from blowing the
   embedding free tier — and we **log** when a cap is hit (never silently drop).
3. **`embedding`** — `embeddings.embedDocuments()` turns every chunk into a vector.
4. **store** — `storeChunks()` bulk-inserts chunks + vectors into `code_chunks`.
5. **`ready`** — records `chunk_count` and `indexed_at`.

If anything throws, the `catch` writes `status = 'error'` + the message to the row
(so the UI can show it), and the `finally` deletes the clone (the code now lives in
the DB as chunks, so we don't need the files on disk).

**Polling:** `GET /repos/:id` just reads the row back so the UI can watch `status`.

---

## 6. Feature 2 — Answering (`ask/`)

**Entry point:** `POST /repos/:id/ask { question }` → `ask.controller.ts` →
`AskService.ask()`. This is the RAG flow, in four steps (the comments in
`ask.service.ts` label them):

1. **Retrieve** — embed the question (`embedQuery`), then run a pgvector query:
   `ORDER BY embedding <=> $queryVector LIMIT 8`. The `<=>` operator is cosine
   distance, so this returns the 8 most semantically-relevant chunks.
2. **Augment** — build a numbered CONTEXT block: `[1] path:10-42` + the code, `[2]
   …`, etc. The number `n` maps directly back to the nth retrieved chunk.
3. **Generate** — send Gemini a strict system instruction ("answer ONLY from the
   context; cite snippets like [2]; say you don't know if it's not there") plus
   the context + question.
4. **Ground** — scan the answer for `[n]` markers, map each back to its real chunk,
   and return those as `citations` (with `file:line`). If the answer cited
   **nothing**, we set `grounded: false` so the UI can warn — an uncited answer is
   the classic hallucination smell. The Q/A is also logged to `query_logs`.

The response shape: `{ answer, citations[], grounded, retrievedChunkCount }`.

**Streaming version** — `POST /repos/:id/ask/stream` does the same RAG flow but
emits the answer live as Server-Sent-Events instead of waiting for the whole
thing. `AskService.streamAnswer()` is an async generator that yields:
`{type:'sources'}` (the retrieved chunks), then many `{type:'token'}` (pieces of
the answer as Gemini writes them via `gemini.generateStream()`), then
`{type:'done', citations, grounded}`. The controller writes each as an SSE frame
(`event: …\ndata: …\n\n`). Both paths share the same `prepare()` (retrieve +
build prompt) and `ground()` (map `[n]` → citations) helpers, so they stay
consistent. **`chunks.controller.ts`** serves `GET /chunks/:id` so the frontend's
code viewer can fetch the exact cited code on demand.

---

## 7. The frontend (`frontend/src/`)

- **`api.ts`** — the only file that knows the backend URL. It exposes
  `createRepo()`, `getRepo()`, `askQuestion()`, `getChunk()`, and `askStream()`
  plus the TypeScript types that mirror the backend's JSON. `askStream()` reads
  the SSE response with a `fetch()` + ReadableStream reader, splits it into frames
  on the blank-line separator, and calls `onToken` / `onDone` / `onError`
  callbacks. Components import from here, never `fetch` directly.
- **`App.tsx`** — the orchestrator. It holds the small amount of state (current
  repo, question, result, error) and drives the flow:
  1. show `RepoForm` → on submit, `createRepo()` and store the repo;
  2. a `useEffect` **polls** `getRepo()` every 2s until status is `ready`/`error`;
  3. once `ready`, show the question box → on submit, call `askStream()`,
     appending each token to the `answer` state so it renders live;
  4. render `AnswerPanel`; when a citation is clicked, store its chunk id and
     render the `CodeViewer` modal.
- **`components/RepoForm.tsx`** — the controlled input for the GitHub URL.
- **`components/AnswerPanel.tsx`** — shows the answer as it streams in (with a
  blinking cursor), a warning if it wasn't grounded, and each citation as a
  button that opens the in-app code viewer.
- **`components/CodeViewer.tsx`** — a modal that fetches the cited chunk via
  `getChunk()` and renders it with real line numbers, plus a "view on GitHub"
  link for the full file in context.

---

## 8. Following one question end-to-end

> *User asks: "How does login work?" on an indexed repo.*

1. `AnswerPanel`/`App.tsx` → `api.askQuestion(repoId, "How does login work?")`
2. → `POST /repos/:id/ask` → `AskController.askQuestion()` → `AskService.ask()`
3. `EmbeddingsService.embedQuery()` → Gemini → a 768-number vector for the question
4. `DbService.query()` runs the `<=>` similarity search → the 8 closest code chunks
   (e.g. `auth.service.ts`, `login.controller.ts` …)
5. `AskService` builds the numbered CONTEXT and calls `GeminiService.generate()`
6. Gemini returns prose with `[1]`, `[3]` citations
7. `AskService` maps `[1]`,`[3]` → real `file:line` citations, sets `grounded: true`
8. JSON travels back to the browser → `AnswerPanel` renders the answer + clickable
   `auth.service.ts:12-40` chips.

That's the whole system. Everything else is plumbing around those eight steps.
