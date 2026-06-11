/**
 * gemini.module.ts
 *
 * Exposes GeminiService for the ask module (and anywhere else that needs to
 * generate text). Embeddings deliberately live in a separate module/provider
 * because they use a different vendor (Voyage), keeping the two concerns apart.
 */
import { Module } from '@nestjs/common';
import { GeminiService } from './gemini.service';

@Module({
  providers: [GeminiService],
  exports: [GeminiService],
})
export class GeminiModule {}
