/**
 * App.tsx  —  the top-level component that orchestrates the whole UI flow:
 *
 *   1. Show RepoForm.  User submits a GitHub URL -> POST /repos.
 *   2. While the repo's status isn't "ready"/"error", poll GET /repos/:id every
 *      couple of seconds and show progress (cloning -> chunking -> embedding).
 *   3. When ready, show a question box.  Submit -> STREAM the answer live.
 *   4. Render the streaming answer + clickable citations; clicking a citation
 *      opens the in-app CodeViewer with the exact cited code.
 *
 * State here is deliberately simple (a handful of useState hooks) so the data
 * flow is easy to follow. A bigger app might use a state library or React Query.
 */
import { useEffect, useState, FormEvent } from 'react';
import './App.css';
import { Repo, Citation, createRepo, getRepo, askStream } from './api';
import { RepoForm } from './components/RepoForm';
import { AnswerPanel } from './components/AnswerPanel';
import { CodeViewer } from './components/CodeViewer';

// Human-readable label for each indexing status.
const STATUS_LABEL: Record<Repo['status'], string> = {
  pending: 'Queued…',
  cloning: 'Cloning repository…',
  chunking: 'Splitting files into chunks…',
  embedding: 'Generating embeddings…',
  ready: 'Ready',
  error: 'Failed',
};

function App() {
  // The repo we're working with (null until the user indexes one).
  const [repo, setRepo] = useState<Repo | null>(null);
  // Top-level error banner (network errors, validation errors, etc.).
  const [error, setError] = useState<string | null>(null);

  // Question-answering state.
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false); // a stream is in progress
  const [answer, setAnswer] = useState(''); // accumulates as tokens arrive
  const [citations, setCitations] = useState<Citation[]>([]);
  const [grounded, setGrounded] = useState<boolean | null>(null);
  const [hasAsked, setHasAsked] = useState(false); // show the panel once we've asked

  // Which chunk (if any) is open in the code viewer modal.
  const [viewerChunkId, setViewerChunkId] = useState<string | null>(null);

  // ---- Step 1: start indexing a repo -------------------------------------
  async function handleIndex(url: string) {
    setError(null);
    resetAnswer();
    try {
      const created = await createRepo(url); // returns a "pending" repo
      setRepo(created); // this triggers the polling effect below
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start indexing');
    }
  }

  // ---- Step 2: poll status until ready/error -----------------------------
  // This effect re-runs whenever `repo` changes. While the repo is still being
  // indexed, it schedules a poll 2s later; once ready/error it stops.
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

    // Cleanup: cancel the pending timer if the component re-renders/unmounts.
    return () => clearTimeout(timer);
  }, [repo]);

  // ---- Step 3/4: ask a question (STREAMING) ------------------------------
  async function handleAsk(e: FormEvent) {
    e.preventDefault();
    if (!repo || question.trim().length < 3) return;

    setAsking(true);
    setError(null);
    setHasAsked(true);
    setAnswer('');
    setCitations([]);
    setGrounded(null);

    // askStream dispatches each SSE frame to one of these callbacks.
    await askStream(repo.id, question.trim(), {
      // We don't render the raw "sources" list here, but it arrives first and
      // could be used to show "searching N snippets". (Citations come at the end.)
      onToken: (text) => setAnswer((prev) => prev + text), // append live
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

  // Lets the user start over with a different repo.
  function reset() {
    setRepo(null);
    setQuestion('');
    setError(null);
    setViewerChunkId(null);
    resetAnswer();
  }

  const isIndexing =
    repo != null && repo.status !== 'ready' && repo.status !== 'error';

  return (
    <div className="container">
      <header>
        <h1>Ask&nbsp;Your&nbsp;Codebase</h1>
        <p className="subtitle">
          Index any public GitHub repo, then ask questions and get answers with
          file&nbsp;+&nbsp;line citations.
        </p>
      </header>

      {/* Repo input — shown until a repo is being/has been indexed. */}
      {!repo && <RepoForm onSubmit={handleIndex} busy={false} />}

      {/* Indexing progress. */}
      {repo && (
        <section className="repo-status">
          <div>
            <strong>{repo.url}</strong>
            <span className={`badge status-${repo.status}`}>
              {STATUS_LABEL[repo.status]}
              {repo.status === 'ready' && ` · ${repo.chunk_count} chunks`}
            </span>
          </div>
          <button className="link-button" onClick={reset}>
            Use a different repo
          </button>
          {repo.status === 'error' && (
            <p className="warning">Indexing failed: {repo.error}</p>
          )}
        </section>
      )}

      {/* Question box — only once indexing is finished. */}
      {repo?.status === 'ready' && (
        <form className="ask-form" onSubmit={handleAsk}>
          <textarea
            placeholder="e.g. How does authentication work in this codebase?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            disabled={asking}
          />
          <button type="submit" disabled={asking || question.trim().length < 3}>
            {asking ? 'Thinking…' : 'Ask'}
          </button>
        </form>
      )}

      {isIndexing && (
        <p className="hint">Indexing can take a little while for big repos…</p>
      )}

      {error && <p className="warning">{error}</p>}

      {/* The streaming answer + citations. */}
      {hasAsked && (
        <AnswerPanel
          answer={answer}
          citations={citations}
          grounded={grounded}
          streaming={asking}
          onOpenChunk={setViewerChunkId}
        />
      )}

      {/* The code viewer modal, when a citation is open. */}
      {viewerChunkId && repo && (
        <CodeViewer
          chunkId={viewerChunkId}
          repo={repo}
          onClose={() => setViewerChunkId(null)}
        />
      )}
    </div>
  );
}

export default App;
