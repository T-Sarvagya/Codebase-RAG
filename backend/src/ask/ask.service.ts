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
 */
import { Injectable } from '@nestjs/common';
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

/** A citation we hand back to the UI so it can render a clickable chip. */
export interface Citation {
  marker: number; // the [n] number used in the answer
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

@Injectable()
export class AskService {
  // How many chunks to retrieve and feed to the model as context.
  private readonly TOP_K = 8;

  constructor(
    private readonly db: DbService,
    private readonly embeddings: EmbeddingsService,
    private readonly gemini: GeminiService,
  ) {}

  async ask(repoId: string, question: string): Promise<AskResult> {
    // --- 1. RETRIEVE -------------------------------------------------------
    // Embed the question with input_type "query" (matches how docs were stored).
    const queryVector = await this.embeddings.embedQuery(question);
    const literal = this.db.toVectorLiteral(queryVector);

    // `embedding <=> $1` is pgvector's cosine-distance operator. Ordering by it
    // ascending and LIMITing gives the nearest (most relevant) chunks. The
    // ivfflat index makes this fast once the table has data.
    const chunks = await this.db.query<RetrievedChunk>(
      `SELECT id, file_path, start_line, end_line, language, symbol_name, content,
              embedding <=> $1 AS distance
         FROM code_chunks
        WHERE repo_id = $2
        ORDER BY embedding <=> $1
        LIMIT $3`,
      [literal, repoId, this.TOP_K],
    );

    if (chunks.length === 0) {
      return {
        answer:
          "I couldn't find any indexed code for this repository. Has indexing finished?",
        citations: [],
        grounded: false,
        retrievedChunkCount: 0,
      };
    }

    // --- 2. AUGMENT --------------------------------------------------------
    // Build the numbered context block. The [n] number is what the model will
    // cite, and its position (n-1) maps straight back to chunks[n-1].
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

    // --- 3. GENERATE -------------------------------------------------------
    const answer = await this.gemini.generate(systemInstruction, userPrompt);

    // --- 4. GROUND ---------------------------------------------------------
    // Pull every [n] marker the model actually used, dedupe, and map back to
    // the real chunk it points at. Markers outside 1..TOP_K are ignored.
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
    const grounded = citations.length > 0;

    // Best-effort logging of the Q/A for history; never block the response on it.
    void this.db
      .query(
        `INSERT INTO query_logs (repo_id, question, answer, cited_chunk_ids)
         VALUES ($1, $2, $3, $4::uuid[])`,
        [repoId, question, answer, citations.map((c) => c.chunkId)],
      )
      .catch(() => undefined);

    return {
      answer,
      citations,
      grounded,
      retrievedChunkCount: chunks.length,
    };
  }
}
