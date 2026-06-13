/**
 * CodeViewer.tsx
 *
 * A modal overlay that shows the actual code behind a citation. When you click a
 * citation chip, the parent passes the chunk id here; we fetch that chunk's
 * stored content from the backend and render it with real line numbers (the same
 * line numbers shown in the citation, e.g. `auth.service.ts:13-19`).
 *
 * This is the in-app alternative to opening GitHub — but we still offer a
 * "view on GitHub" link for the full file in context.
 */
import { useEffect, useState } from 'react';
import { Chunk, Repo, getChunk } from '../api';

interface Props {
  chunkId: string;
  repo: Repo;
  onClose: () => void;
}

export function CodeViewer({ chunkId, repo, onClose }: Props) {
  const [chunk, setChunk] = useState<Chunk | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch the chunk whenever the selected id changes.
  useEffect(() => {
    let cancelled = false;
    setChunk(null);
    setError(null);
    getChunk(chunkId)
      .then((c) => !cancelled && setChunk(c))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load'));
    return () => {
      cancelled = true;
    };
  }, [chunkId]);

  // Close on Escape for convenience.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Clicking the dark backdrop (but not the dialog) closes the viewer.
  return (
    <div className="viewer-backdrop" onClick={onClose}>
      <div className="viewer-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="viewer-header">
          <span className="viewer-title">
            {chunk
              ? `${chunk.file_path}:${chunk.start_line}-${chunk.end_line}`
              : 'Loading…'}
            {chunk?.symbol_name && <em className="viewer-symbol"> · {chunk.symbol_name}</em>}
          </span>
          <div className="viewer-actions">
            {chunk && (
              <a
                href={githubUrl(repo, chunk)}
                target="_blank"
                rel="noreferrer"
                className="link-button"
              >
                View on GitHub ↗
              </a>
            )}
            <button className="link-button" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </header>

        {error && <p className="warning">{error}</p>}

        {chunk && (
          // Render each line with its real (absolute) line number on the left.
          <pre className="viewer-code">
            <code>
              {chunk.content.split('\n').map((line, i) => (
                <div className="code-line" key={i}>
                  <span className="line-no">{chunk.start_line + i}</span>
                  <span className="line-text">{line || ' '}</span>
                </div>
              ))}
            </code>
          </pre>
        )}
      </div>
    </div>
  );
}

/** Deep-link to the cited lines on GitHub for full context. */
function githubUrl(repo: Repo, chunk: Chunk): string {
  const base = repo.url.replace(/\.git$/, '').replace(/\/$/, '');
  const branch = repo.default_branch ?? 'main';
  return `${base}/blob/${branch}/${chunk.file_path}#L${chunk.start_line}-L${chunk.end_line}`;
}
