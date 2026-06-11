/**
 * embeddings.service.ts
 *
 * Turns text into embedding vectors using Voyage AI's `voyage-code-3` model,
 * which is tuned specifically for source code. An "embedding" is just an array
 * of numbers (1024 of them here) that captures the *meaning* of the text, so
 * that semantically similar snippets end up close together in vector space.
 *
 * We call Voyage's REST API directly with the built-in `fetch` (Node 18+),
 * so there's no extra SDK to learn — you can see exactly what goes over the wire.
 *
 * Two entry points, because Voyage gives better retrieval when you tell it
 * whether the text is a stored document or a search query:
 *   - embedDocuments(): for code chunks we store         (input_type: "document")
 *   - embedQuery():     for the user's question at search (input_type: "query")
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Shape of the JSON Voyage returns. We only type the fields we read.
interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
}

@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);
  private readonly apiKey: string;
  private readonly model: string;

  // Voyage accepts up to 128 inputs per request; we stay well under that.
  private readonly BATCH_SIZE = 64;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.getOrThrow<string>('VOYAGE_API_KEY');
    this.model = this.config.get<string>('VOYAGE_MODEL', 'voyage-code-3');
  }

  /** Embed many code chunks. Returns one vector per input, in the same order. */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const all: number[][] = [];
    // Send in batches so we don't blow past Voyage's per-request limits.
    for (let i = 0; i < texts.length; i += this.BATCH_SIZE) {
      const batch = texts.slice(i, i + this.BATCH_SIZE);
      const vectors = await this.callVoyage(batch, 'document');
      all.push(...vectors);
      this.logger.log(
        `Embedded ${Math.min(i + this.BATCH_SIZE, texts.length)}/${texts.length} chunks`,
      );
    }
    return all;
  }

  /** Embed a single search query. Returns one vector. */
  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.callVoyage([text], 'query');
    return vector;
  }

  /**
   * The actual HTTP call. `inputType` is Voyage's hint about how the text will
   * be used — matching documents at index time with queries at search time
   * measurably improves retrieval quality.
   */
  private async callVoyage(
    input: string[],
    inputType: 'document' | 'query',
  ): Promise<number[][]> {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input,
        model: this.model,
        input_type: inputType,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Voyage API error ${res.status}: ${body}`);
    }

    const json = (await res.json()) as VoyageResponse;
    // Voyage may return results out of order, so sort by `index` to be safe.
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
