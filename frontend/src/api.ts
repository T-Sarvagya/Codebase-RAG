/**
 * api.ts
 *
 * All calls to the NestJS backend live here, so the React components stay free
 * of fetch/URL details. The base URL can be overridden with a VITE_API_URL env
 * var at build time; it defaults to the local backend.
 */

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// ---- Types mirroring the backend's JSON responses --------------------------

/** A repo row as returned by POST /repos and GET /repos/:id. */
export interface Repo {
  id: string;
  url: string;
  default_branch: string | null;
  status: 'pending' | 'cloning' | 'chunking' | 'embedding' | 'ready' | 'error';
  error: string | null;
  chunk_count: number;
}

/** One clickable citation in an answer. */
export interface Citation {
  marker: number;
  chunkId: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

/** Result of POST /repos/:id/ask (non-streaming). */
export interface AskResult {
  answer: string;
  citations: Citation[];
  grounded: boolean;
  retrievedChunkCount: number;
}

/** A full code chunk, returned by GET /chunks/:id for the code viewer. */
export interface Chunk {
  id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string | null;
  symbol_name: string | null;
  content: string;
}

/** Callbacks for the streaming ask. Each fires as the matching SSE frame arrives. */
export interface StreamHandlers {
  onSources?: (sources: Citation[]) => void; // retrieved chunks (before generation)
  onToken?: (text: string) => void; // one piece of the answer
  onDone?: (d: { grounded: boolean; citations: Citation[] }) => void;
  onError?: (message: string) => void;
}

// ---- Small fetch helper ----------------------------------------------------

/** Wraps fetch with JSON handling + readable errors (surfaces backend messages). */
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    // NestJS error bodies look like { message: string | string[], ... }
    const body = await res.json().catch(() => ({}));
    const msg = Array.isArray(body.message)
      ? body.message.join(', ')
      : body.message ?? res.statusText;
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// ---- The three endpoints the UI needs --------------------------------------

/** Start indexing a GitHub repo. Returns immediately with a pending repo. */
export function createRepo(url: string): Promise<Repo> {
  return request<Repo>('/repos', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

/** Poll a repo's indexing status. */
export function getRepo(id: string): Promise<Repo> {
  return request<Repo>(`/repos/${id}`);
}

/** Ask a question about an indexed repo (one-shot, non-streaming). */
export function askQuestion(id: string, question: string): Promise<AskResult> {
  return request<AskResult>(`/repos/${id}/ask`, {
    method: 'POST',
    body: JSON.stringify({ question }),
  });
}

/** Fetch one stored chunk's full content (for the code viewer). */
export function getChunk(chunkId: string): Promise<Chunk> {
  return request<Chunk>(`/chunks/${chunkId}`);
}

/**
 * Ask a question and STREAM the answer. The backend sends Server-Sent-Events
 * frames (`sources`, many `token`s, then `done` — or `error`); we read the
 * response body as a stream, split it into frames on the blank-line separator,
 * and dispatch each to the matching handler.
 *
 * We use fetch (not the browser's EventSource) because EventSource can only do
 * GET — we need POST to send the question in the body.
 */
export async function askStream(
  repoId: string,
  question: string,
  handlers: StreamHandlers,
): Promise<void> {
  const res = await fetch(`${API_URL}/repos/${repoId}/ask/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });

  if (!res.ok || !res.body) {
    // Validation / early failures come back as a normal JSON error body.
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = Array.isArray(body.message) ? body.message.join(', ') : body.message ?? msg;
    } catch {
      /* ignore */
    }
    handlers.onError?.(msg);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Read the stream chunk by chunk; a network "chunk" may contain part of a
  // frame or several frames, so we buffer and split on the SSE separator.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      dispatchFrame(frame, handlers);
    }
  }
}

/** Parse one SSE frame ("event: x\ndata: y") and call the right handler. */
function dispatchFrame(frame: string, handlers: StreamHandlers): void {
  let event = '';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!event) return;

  let data: unknown = null;
  try {
    data = dataLines.length ? JSON.parse(dataLines.join('\n')) : null;
  } catch {
    return; // skip malformed frames
  }

  switch (event) {
    case 'sources':
      handlers.onSources?.(data as Citation[]);
      break;
    case 'token':
      handlers.onToken?.(data as string);
      break;
    case 'done':
      handlers.onDone?.(data as { grounded: boolean; citations: Citation[] });
      break;
    case 'error':
      handlers.onError?.((data as { message: string }).message);
      break;
  }
}
