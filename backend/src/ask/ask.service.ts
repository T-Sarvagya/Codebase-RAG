/**
 * ask.service.ts
 *
 * The QUESTION-ANSWERING half of the system — the "RAG" (Retrieval-Augmented
 * Generation) flow:
 *
 *   1. RETRIEVE: embed the question, then use pgvector to find the code chunks
 *      whose embeddings are closest to it (cosine distance via the <=> operator).
 *   2. AUGMENT:  build a prompt that puts those chunks in front of the model as
 *      numbered CONTEXT snippets.
 *   3. GENERATE: ask Gemini to answer using ONLY that context and to cite which
 *      snippet each claim came from, e.g. "[2]".
 *   4. GROUND:   parse the [n] markers out of the answer and map them back to
 *      real file:line locations — that's what makes citations clickable and what
 *      lets us flag an answer that cited nothing (a hallucination smell).
 *
 * There are TWO ways to run this:
 *   - ask():          one-shot, returns the whole answer at once (simple).
 *   - streamAnswer(): yields events (sources, then tokens as the model writes
 *                     them, then a final "done" with citations) so the UI can
 *                     render the answer live. Both share the same retrieve +
 *                     ground helpers below, so behavior stays consistent.
 */
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { GeminiService } from '../gemini/gemini.service';

/** A chunk pulled back from the vector search, plus how close it was. */
interface RetrievedChunk {
  id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string | null;
  symbol_name: string | null;
  content: string;
  distance: number; // 0 = identical direction; smaller = more relevant
}

/** A citation/source we hand to the UI so it can render a clickable chip. */
export interface Citation {
  marker: number; // the [n] number (its position in the retrieved list)
  chunkId: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface AskResult {
  answer: string;
  citations: Citation[];
  grounded: boolean; // false if the answer cited no context (possible hallucination)
  retrievedChunkCount: number;
}

/** Everything the generation step needs, produced by retrieval + prompt building. */
interface Prepared {
  chunks: RetrievedChunk[];
  sources: Citation[]; // all retrieved chunks, numbered (before we know what's cited)
  systemInstruction: string;
  userPrompt: string;
}

/** One event in the streaming response. */
export type StreamEvent =
  | { type: 'sources'; data: Citation[] }
  | { type: 'token'; data: string }
  | { type: 'done'; data: { grounded: boolean; citations: Citation[] } }
  | { type: 'error'; data: { message: string } };

@Injectable()
export class AskService {
  // How many chunks to retrieve and feed to the model as context.
  private readonly TOP_K = 8;

  constructor(
    private readonly db: DbService,
    private readonly embeddings: EmbeddingsService,
    private readonly gemini: GeminiService,
  ) {}

  // ===========================================================================
  // PUBLIC: one-shot answer
  // ===========================================================================
  async ask(repoId: string, question: string): Promise<AskResult> {
    const prep = await this.prepare(repoId, question);

    if (prep.chunks.length === 0) {
      return {
        answer:
          "I couldn't find any indexed code for this repository. Has indexing finished?",
        citations: [],
        grounded: false,
        retrievedChunkCount: 0,
      };
    }

    let answer: string;
    try {
      answer = await this.gemini.generate(prep.systemInstruction, prep.userPrompt);
    } catch (err) {
      throw this.toHttpError(err);
    }

    const { citations, grounded } = this.ground(answer, prep.chunks);
    this.logQuery(repoId, question, answer, citations);

    return { answer, citations, grounded, retrievedChunkCount: prep.chunks.length };
  }

  // ===========================================================================
  // PUBLIC: streaming answer (async generator of events)
  // ===========================================================================
  async *streamAnswer(repoId: string, question: string): AsyncGenerator<StreamEvent> {
    const prep = await this.prepare(repoId, question);

    // Tell the UI which chunks we retrieved up front, so it can show "searching
    // N snippets" and resolve [n] markers as they stream in.
    yield { type: 'sources', data: prep.sources };

    if (prep.chunks.length === 0) {
      yield { type: 'done', data: { grounded: false, citations: [] } };
      return;
    }

    // Stream tokens from Gemini, accumulating the full text so we can ground it.
    let full = '';
    try {
      for await (const token of this.gemini.generateStream(
        prep.systemInstruction,
        prep.userPrompt,
      )) {
        full += token;
        yield { type: 'token', data: token };
      }
    } catch (err) {
      const http = this.toHttpError(err);
      yield { type: 'error', data: { message: http.message } };
      return;
    }

    const { citations, grounded } = this.ground(full, prep.chunks);
    this.logQuery(repoId, question, full, citations);
    yield { type: 'done', data: { grounded, citations } };
  }

  // ===========================================================================
  // SHARED HELPERS
  // ===========================================================================

  /** RETRIEVE + AUGMENT: vector search, then build the numbered prompt. */
  private async prepare(repoId: string, question: string): Promise<Prepared> {
    // Embed the question with input_type "query" (matches how docs were stored).
    const queryVector = await this.embeddings.embedQuery(question);
    const literal = this.db.toVectorLiteral(queryVector);

    // `embedding <=> $1` is pgvector's cosine-distance operator. Ordering by it
    // ascending and LIMITing gives the nearest (most relevant) chunks.
    const chunks = await this.db.query<RetrievedChunk>(
      `SELECT id, file_path, start_line, end_line, language, symbol_name, content,
              embedding <=> $1 AS distance
         FROM code_chunks
        WHERE repo_id = $2
        ORDER BY embedding <=> $1
        LIMIT $3`,
      [literal, repoId, this.TOP_K],
    );

    // The numbered list of all retrieved chunks (the candidate sources). The
    // [n] number is its 1-based position, which maps straight back to chunks[n-1].
    const sources: Citation[] = chunks.map((c, i) => ({
      marker: i + 1,
      chunkId: c.id,
      filePath: c.file_path,
      startLine: c.start_line,
      endLine: c.end_line,
    }));

    const context = chunks
      .map((c, i) => {
        const header = `[${i + 1}] ${c.file_path}:${c.start_line}-${c.end_line}`;
        return `${header}\n\`\`\`${c.language ?? ''}\n${c.content}\n\`\`\``;
      })
      .join('\n\n');

    const systemInstruction = [
      'You are a code assistant answering questions about ONE specific codebase.',
      'You are given numbered CONTEXT snippets, each taken from a real file.',
      'Rules:',
      '- Answer ONLY using information found in the CONTEXT. Never use outside',
      '  knowledge and never invent code, file names, or behavior.',
      '- When you state something about the code, cite the snippet(s) it came',
      '  from using their number in square brackets, e.g. [2] or [1][3].',
      '- If the CONTEXT does not contain the answer, say you do not have enough',
      '  information in the indexed code. Do not guess.',
      '- Be concise and concrete; refer to real file paths and symbol names.',
    ].join('\n');

    const userPrompt =
      `CONTEXT:\n${context}\n\n` +
      `QUESTION: ${question}\n\n` +
      `Answer the question using the context above, with inline [n] citations.`;

    return { chunks, sources, systemInstruction, userPrompt };
  }

  /** GROUND: map the [n] markers the model used back to real chunk citations. */
  private ground(
    answer: string,
    chunks: RetrievedChunk[],
  ): { citations: Citation[]; grounded: boolean } {
    const usedMarkers = new Set<number>();
    for (const match of answer.matchAll(/\[(\d+)\]/g)) {
      const n = Number(match[1]);
      if (n >= 1 && n <= chunks.length) usedMarkers.add(n);
    }

    const citations: Citation[] = [...usedMarkers]
      .sort((a, b) => a - b)
      .map((n) => {
        const c = chunks[n - 1];
        return {
          marker: n,
          chunkId: c.id,
          filePath: c.file_path,
          startLine: c.start_line,
          endLine: c.end_line,
        };
      });

    // An answer that cites nothing is suspicious — flag it so the UI can warn.
    return { citations, grounded: citations.length > 0 };
  }

  /** Best-effort logging of the Q/A for history; never blocks the response. */
  private logQuery(
    repoId: string,
    question: string,
    answer: string,
    citations: Citation[],
  ): void {
    void this.db
      .query(
        `INSERT INTO query_logs (repo_id, question, answer, cited_chunk_ids)
         VALUES ($1, $2, $3, $4::uuid[])`,
        [repoId, question, answer, citations.map((c) => c.chunkId)],
      )
      .catch(() => undefined);
  }

  /** Convert a Gemini error into a clean HttpException (429 for rate limits). */
  private toHttpError(err: unknown): HttpException {
    const message = err instanceof Error ? err.message : String(err);
    if (/429|RESOURCE_EXHAUSTED|quota/i.test(message)) {
      return new HttpException(
        'Gemini free-tier rate limit hit — wait ~30s and ask again. ' +
          '(Tip: gemini-2.5-flash-lite has higher free limits.)',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return new HttpException(
      'Failed to generate an answer.',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
