/**
 * embeddings.service.ts
 *
 * Turns text into embedding vectors — entirely LOCALLY, using a small
 * sentence-transformer (`all-MiniLM-L6-v2`, 384 dims) run via transformers.js
 * (ONNX runtime). An "embedding" captures the *meaning* of text as a point in
 * vector space, so semantically similar code ends up close together — which is
 * what powers the similarity search.
 *
 * WHY LOCAL (and not a hosted embedding API)? Hosted free tiers (Voyage,
 * Gemini) rate-limit bulk embedding hard — indexing anything bigger than a tiny
 * repo hits `429 / RESOURCE_EXHAUSTED`. Running the model on the CPU has **no
 * API key, no quota, and no rate limit**, so it indexes repos of any size
 * reliably. The model (~25 MB) downloads once on first use and is then cached;
 * after that, embedding is ~tens of milliseconds per chunk. (Generation still
 * uses Gemini — that's one request per question, which the free tier handles.)
 *
 * Two entry points kept identical to before, so nothing else changed:
 *   - embedDocuments(): code chunks we store
 *   - embedQuery():     the user's question at search time
 */
import { Injectable, Logger } from '@nestjs/common';
import { pipeline } from '@huggingface/transformers';

// The pipeline is an async-callable object; we only use it loosely typed.
type Extractor = (
  input: string | string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);

  // ONNX sentence-transformer. 384-dim output — must match vector(384) in schema.sql.
  private readonly MODEL = 'Xenova/all-MiniLM-L6-v2';
  private readonly BATCH_SIZE = 32;

  // Load the model once, lazily, and share the single instance. The first call
  // downloads + initialises the model (slow, one-time); later calls reuse it.
  private extractorPromise: Promise<Extractor> | null = null;

  private getExtractor(): Promise<Extractor> {
    if (!this.extractorPromise) {
      this.logger.log(
        `Loading local embedding model "${this.MODEL}" (first run downloads ~25MB)…`,
      );
      // pipeline() returns the callable feature-extraction model.
      this.extractorPromise = pipeline(
        'feature-extraction',
        this.MODEL,
      ) as unknown as Promise<Extractor>;
    }
    return this.extractorPromise;
  }

  /** Embed many code chunks. Returns one 384-dim vector per input, in order. */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();

    const all: number[][] = [];
    // Embed in modest batches to bound memory on large repos.
    for (let i = 0; i < texts.length; i += this.BATCH_SIZE) {
      const batch = texts.slice(i, i + this.BATCH_SIZE);
      // mean pooling + L2 normalize = standard sentence-embedding recipe; the
      // normalized vectors work directly with pgvector's cosine distance.
      const out = await extractor(batch, { pooling: 'mean', normalize: true });
      all.push(...out.tolist());
      this.logger.log(
        `Embedded ${Math.min(i + this.BATCH_SIZE, texts.length)}/${texts.length} chunks`,
      );
    }
    return all;
  }

  /** Embed a single search query. Returns one 384-dim vector. */
  async embedQuery(text: string): Promise<number[]> {
    const extractor = await this.getExtractor();
    const out = await extractor([text], { pooling: 'mean', normalize: true });
    return out.tolist()[0];
  }
}
