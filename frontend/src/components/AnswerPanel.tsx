/**
 * AnswerPanel.tsx
 *
 * Renders the answer as it streams in, plus the citations. Each citation is a
 * button that opens the in-app CodeViewer (via the onOpenChunk callback) so you
 * can read the exact cited code without leaving the page.
 *
 * While the answer is still streaming we show a blinking cursor; once it's done,
 * if it cited nothing (`grounded === false`) we show a warning — an uncited
 * answer is the "hallucination smell" the grounding step is designed to catch.
 */
import { Citation } from '../api';

interface Props {
  answer: string; // accumulates as tokens stream in
  citations: Citation[]; // populated on the final "done" frame
  grounded: boolean | null; // null while streaming, true/false when done
  streaming: boolean; // true while tokens are still arriving
  onOpenChunk: (chunkId: string) => void;
}

export function AnswerPanel({ answer, citations, grounded, streaming, onOpenChunk }: Props) {
  return (
    <div className="answer-panel panel">
      <h3>Answer</h3>
      <p className="answer-text">
        {answer}
        {streaming && <span className="cursor">▍</span>}
      </p>

      {/* Only meaningful once streaming finished. */}
      {!streaming && grounded === false && (
        <p className="warning">
          ⚠️ This answer didn't cite any indexed code — treat it with caution.
        </p>
      )}

      {citations.length > 0 && (
        <>
          <h4>Sources</h4>
          <ul className="citation-list">
            {citations.map((c) => (
              <li key={c.chunkId}>
                <button
                  className="citation-chip"
                  onClick={() => onOpenChunk(c.chunkId)}
                  title="View the cited code"
                >
                  [{c.marker}] {c.filePath}:{c.startLine}-{c.endLine}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
