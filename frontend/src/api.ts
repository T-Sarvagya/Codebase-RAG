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

/** Result of POST /repos/:id/ask. */
export interface AskResult {
  answer: string;
  citations: Citation[];
  grounded: boolean;
  retrievedChunkCount: number;
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

/** Ask a question about an indexed repo. */
export function askQuestion(id: string, question: string): Promise<AskResult> {
  return request<AskResult>(`/repos/${id}/ask`, {
    method: 'POST',
    body: JSON.stringify({ question }),
  });
}
