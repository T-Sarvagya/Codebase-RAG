/**
 * embeddings.service.ts
 *
 * Turns text into embedding vectors using Google's Gemini embedding model
 * (`text-embedding-004`, 768 numbers per vector). An "embedding" captures the
 * *meaning* of text as a point in vector space, so semantically similar code
 * ends up close together — which is what powers the similarity search.
 *
 * WHY GEMINI (and not Voyage)? Voyage's free tier throttles to 3 requests/min
 * and 10K tokens/min, which makes indexing a real repo impractical (you hit
 * HTTP 429 almost immediately). Gemini's free embedding tier is far more
 * generous, it reuses the GEMINI_API_KEY we already have for answering, and it
 * keeps the whole app on a single provider. (voyage-code-3 is marginally better
 * for code, but "works for free" wins here.)
 *
 * Two entry points, because retrieval is better when we tell Gemini whether the
 * text is a stored document or a search query (its `taskType` hint):
 *   - embedDocuments(): code chunks we store     (taskType RETRIEVAL_DOCUMENT)
 *   - embedQuery():     the user's question       (taskType RETRIEVAL_QUERY)
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';

@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly dim: number;

  // How many chunks to embed per API call. Gemini accepts up to 100 per request.
  private readonly BATCH_SIZE = 100;
  // Retry settings for transient rate-limit (429) / server errors.
  private readonly MAX_RETRIES = 5;

  constructor(private readonly config: ConfigService) {
    // Embeddings and generation share one Gemini key.
    const apiKey = this.config.getOrThrow<string>('GEMINI_API_KEY');
    this.model = this.config.get<string>('EMBEDDING_MODEL', 'gemini-embedding-001');
    // Must match the vector(N) size in schema.sql (text-embedding-004 = 768).
    this.dim = Number(this.config.get<string>('EMBEDDING_DIM', '768'));
    this.client = new GoogleGenAI({ apiKey });
  }

  /** Embed many code chunks. Returns one vector per input, in the same order. */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += this.BATCH_SIZE) {
      const batch = texts.slice(i, i + this.BATCH_SIZE);
      const vectors = await this.callGemini(batch, 'RETRIEVAL_DOCUMENT');
      all.push(...vectors);
      this.logger.log(
        `Embedded ${Math.min(i + this.BATCH_SIZE, texts.length)}/${texts.length} chunks`,
      );
    }
    return all;
  }

  /** Embed a single search query. Returns one vector. */
  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.callGemini([text], 'RETRIEVAL_QUERY');
    return vector;
  }

  /**
   * The actual API call, with retry + exponential backoff. If Gemini returns a
   * rate-limit (429 / RESOURCE_EXHAUSTED) or transient server error, we wait a
   * bit and try again instead of failing the whole indexing job.
   */
  private async callGemini(
    input: string[],
    taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
  ): Promise<number[][]> {
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const res = await this.client.models.embedContent({
          model: this.model,
          contents: input,
          // taskType tunes the vector for retrieval; outputDimensionality keeps
          // the size consistent with our pgvector column.
          config: { taskType, outputDimensionality: this.dim },
        });

        const embeddings = res.embeddings ?? [];
        if (embeddings.length !== input.length) {
          throw new Error(
            `Gemini returned ${embeddings.length} embeddings for ${input.length} inputs`,
          );
        }
        // Each embedding is { values: number[] }; map to plain number arrays.
        return embeddings.map((e) => e.values ?? []);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const retryable = /429|RESOURCE_EXHAUSTED|50\d|UNAVAILABLE/i.test(message);

        // Give up if it's not retryable, or we've exhausted our attempts.
        if (!retryable || attempt === this.MAX_RETRIES) throw err;

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s.
        const delayMs = 1000 * 2 ** attempt;
        this.logger.warn(
          `Embedding call hit a limit (attempt ${attempt + 1}); retrying in ${delayMs}ms…`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    // Unreachable, but satisfies TypeScript's control-flow analysis.
    throw new Error('Embedding failed after retries');
  }
}
