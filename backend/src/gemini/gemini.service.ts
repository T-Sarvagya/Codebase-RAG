/**
 * gemini.service.ts
 *
 * Wraps Google's Gemini model (via the @google/genai SDK) for ANSWER GENERATION.
 * Embeddings come from Voyage (see embeddings.service.ts); Gemini's only job
 * here is to read the retrieved code chunks + the user's question and write a
 * grounded, cited answer.
 *
 * Keeping all Gemini calls behind this one service means if we ever swap the
 * model (or provider), there's exactly one file to change.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private readonly client: GoogleGenAI;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.getOrThrow<string>('GEMINI_API_KEY');
    this.model = this.config.get<string>('GEMINI_MODEL', 'gemini-2.0-flash');
    // The SDK client is cheap to construct and safe to reuse for all requests.
    this.client = new GoogleGenAI({ apiKey });
  }

  /**
   * Generate a complete answer in one shot (non-streaming).
   *
   * @param systemInstruction  The "rules" for the model — here, the instruction
   *                            to answer ONLY from the provided context and to
   *                            cite chunk ids. Kept separate from the user
   *                            content so the model treats it as higher-priority.
   * @param userPrompt          The actual question + the retrieved code context.
   */
  async generate(systemInstruction: string, userPrompt: string): Promise<string> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: userPrompt,
      config: {
        systemInstruction,
        // Low temperature = more deterministic, factual answers. We do NOT want
        // the model getting creative when it's supposed to be grounded in code.
        temperature: 0.2,
      },
    });

    // `.text` concatenates all returned text parts into a single string.
    return response.text ?? '';
  }

  /**
   * Streaming variant — yields the answer token-by-token. Not used in the
   * first pass (milestones 1–3 are non-streaming) but ready for the milestone-5
   * SSE work, so the ask flow can switch over without touching provider code.
   */
  async *generateStream(
    systemInstruction: string,
    userPrompt: string,
  ): AsyncGenerator<string> {
    const stream = await this.client.models.generateContentStream({
      model: this.model,
      contents: userPrompt,
      config: { systemInstruction, temperature: 0.2 },
    });
    for await (const chunk of stream) {
      if (chunk.text) yield chunk.text;
    }
  }
}
