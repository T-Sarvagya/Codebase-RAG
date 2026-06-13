/**
 * App.tsx  —  the top-level component that orchestrates the whole UI flow:
 *
 *   1. Hero screen: a centered headline + the "paste a GitHub URL" form.
 *   2. While the repo's status isn't "ready"/"error", poll GET /repos/:id every
 *      couple of seconds and show animated progress.
 *   3. When ready, show the question box. Submit -> STREAM the answer live.
 *   4. Render the streaming answer + citations; clicking a citation opens the
 *      in-app CodeViewer with the exact cited code.
 *
 * Also owns the light/dark THEME (persisted to localStorage, applied as a
 * data-theme attribute on <html>). State is intentionally simple useState/hooks
 * so the data flow stays easy to follow.
 */
import { useEffect, useState, FormEvent } from 'react';
import './App.css';
import { Repo, Citation, createRepo, getRepo, askStream } from './api';
import { RepoForm } from './components/RepoForm';
import { AnswerPanel } from './components/AnswerPanel';
import { CodeViewer } from './components/CodeViewer';
import { ThemeToggle } from './components/ThemeToggle';

type Theme = 'light' | 'dark';

// Human-readable label for each indexing status.
const STATUS_LABEL: Record<Repo['status'], string> = {
  pending: 'Queued',
  cloning: 'Cloning repository',
  chunking: 'Splitting into chunks',
  embedding: 'Generating embeddings',
  ready: 'Ready',
  error: 'Failed',
};

// Maps a status to a badge style variant.
function badgeVariant(status: Repo['status']): string {
  if (status === 'ready') return 'is-ready';
  if (status === 'error') return 'is-error';
  return 'is-working';
}

function App() {
  // ---- Theme ----
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
  );
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('ayc-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  // ---- App state ----
  const [repo, setRepo] = useState<Repo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false); // a stream is in progress
  const [answer, setAnswer] = useState(''); // accumulates as tokens arrive
  const [citations, setCitations] = useState<Citation[]>([]);
  const [grounded, setGrounded] = useState<boolean | null>(null);
  const [hasAsked, setHasAsked] = useState(false);

  const [viewerChunkId, setViewerChunkId] = useState<string | null>(null);

  // ---- Step 1: start indexing a repo ----
  async function handleIndex(url: string) {
    setError(null);
    resetAnswer();
    try {
      const created = await createRepo(url); // returns a "pending" repo
      setRepo(created); // triggers the polling effect below
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start indexing');
    }
  }

  // ---- Step 2: poll status until ready/error ----
  useEffect(() => {
    if (!repo) return;
    if (repo.status === 'ready' || repo.status === 'error') return;

    const timer = setTimeout(async () => {
      try {
        const fresh = await getRepo(repo.id);
        setRepo(fresh); // updating status re-runs this effect
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to poll status');
      }
    }, 2000);

    return () => clearTimeout(timer);
  }, [repo]);

  // ---- Step 3/4: ask a question (STREAMING) ----
  async function handleAsk(e: FormEvent) {
    e.preventDefault();
    if (!repo || question.trim().length < 3) return;

    setAsking(true);
    setError(null);
    setHasAsked(true);
    setAnswer('');
    setCitations([]);
    setGrounded(null);

    await askStream(repo.id, question.trim(), {
      onToken: (text) => setAnswer((prev) => prev + text),
      onDone: (d) => {
        setCitations(d.citations);
        setGrounded(d.grounded);
        setAsking(false);
      },
      onError: (message) => {
        setError(message);
        setAsking(false);
      },
    });
  }

  function resetAnswer() {
    setAnswer('');
    setCitations([]);
    setGrounded(null);
    setHasAsked(false);
  }

  function reset() {
    setRepo(null);
    setQuestion('');
    setError(null);
    setViewerChunkId(null);
    resetAnswer();
  }

  const isIndexing = repo != null && repo.status !== 'ready' && repo.status !== 'error';

  return (
    <div className="shell">
      {/* Persistent top bar: brand + theme toggle. */}
      <header className="topbar reveal">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">Ask Your Codebase</div>
            <div className="brand-kicker">code intelligence</div>
          </div>
        </div>
        <ThemeToggle theme={theme} onToggle={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} />
      </header>

      <main className={`container ${!repo ? 'stage-hero' : ''}`}>
        {/* ---- HERO (no repo yet) ---- */}
        {!repo && (
          <>
            <div className="hero-head reveal d-1">
              <div className="eyebrow">retrieval-augmented · cited answers</div>
              <h1>
                Ask your <span className="accent">codebase</span>.
              </h1>
              <p className="subtitle">
                Index any public GitHub repo, then ask questions and get answers with
                exact file&nbsp;+&nbsp;line citations — streamed in live.
              </p>
            </div>
            <div className="reveal d-2">
              <RepoForm onSubmit={handleIndex} busy={false} />
            </div>
          </>
        )}

        {/* ---- WORKING (repo chosen) ---- */}
        {repo && (
          <>
            <section className="repo-status panel reveal">
              <div className="status-row">
                <span className="repo-url">{repo.url}</span>
                <span className={`badge ${badgeVariant(repo.status)}`}>
                  <span className="dot" />
                  {STATUS_LABEL[repo.status]}
                  {repo.status === 'ready' && ` · ${repo.chunk_count} chunks`}
                </span>
              </div>
              <button className="link-button" onClick={reset}>
                ← Use a different repo
              </button>
              {repo.status === 'error' && (
                <p className="warning">Indexing failed: {repo.error}</p>
              )}
            </section>

            {repo.status === 'ready' && (
              <form className="ask-form reveal d-1" onSubmit={handleAsk}>
                <textarea
                  placeholder="e.g. How does authentication work in this codebase?"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  rows={3}
                  disabled={asking}
                />
                <div className="ask-row">
                  <button type="submit" className="btn" disabled={asking || question.trim().length < 3}>
                    {asking ? 'Thinking…' : 'Ask →'}
                  </button>
                </div>
              </form>
            )}

            {isIndexing && (
              <p className="hint">› indexing — this can take a little while for big repos…</p>
            )}

            {error && <p className="warning">{error}</p>}

            {hasAsked && (
              <AnswerPanel
                answer={answer}
                citations={citations}
                grounded={grounded}
                streaming={asking}
                onOpenChunk={setViewerChunkId}
              />
            )}
          </>
        )}
      </main>

      {viewerChunkId && repo && (
        <CodeViewer chunkId={viewerChunkId} repo={repo} onClose={() => setViewerChunkId(null)} />
      )}
    </div>
  );
}

/** The brand mark — a "scan the code" lens, drawn with currentColor (gold). */
function BrandMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    >
      <circle cx="14" cy="14" r="7.5" />
      <line x1="20" y1="20" x2="26" y2="26" />
      <line x1="11" y1="12.5" x2="17.5" y2="12.5" />
      <line x1="11" y1="16" x2="15.5" y2="16" />
    </svg>
  );
}

export default App;
