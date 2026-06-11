/**
 * AnswerPanel.tsx
 *
 * Renders the result of a question: the generated answer plus the list of
 * citations. Each citation is a clickable chip that opens the exact file +
 * line range on GitHub (a real in-app code viewer arrives in milestone 5).
 *
 * If the answer cited nothing (`grounded === false`) we show a warning, because
 * an uncited answer is exactly the "hallucination smell" the grounding step is
 * designed to catch.
 */
import { AskResult, Repo } from '../api';

interface Props {
  repo: Repo;
  result: AskResult;
}

export function AnswerPanel({ repo, result }: Props) {
  return (
    <div className="answer-panel">
      {/* The model's answer. Citations appear inline as [1], [2] markers. */}
      <h3>Answer</h3>
      <p className="answer-text">{result.answer}</p>

      {!result.grounded && (
        <p className="warning">
          ⚠️ This answer didn't cite any indexed code — treat it with caution.
        </p>
      )}

      {result.citations.length > 0 && (
        <>
          <h4>Sources</h4>
          <ul className="citation-list">
            {result.citations.map((c) => (
              <li key={c.chunkId}>
                <a
                  className="citation-chip"
                  href={buildGithubUrl(repo, c.filePath, c.startLine, c.endLine)}
                  target="_blank"
                  rel="noreferrer"
                >
                  [{c.marker}] {c.filePath}:{c.startLine}-{c.endLine}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Construct a GitHub "blob" URL that deep-links to the cited lines, e.g.
 * https://github.com/owner/repo/blob/main/src/x.ts#L10-L42
 */
function buildGithubUrl(
  repo: Repo,
  filePath: string,
  startLine: number,
  endLine: number,
): string {
  const base = repo.url.replace(/\.git$/, '').replace(/\/$/, '');
  const branch = repo.default_branch ?? 'main';
  return `${base}/blob/${branch}/${filePath}#L${startLine}-L${endLine}`;
}
