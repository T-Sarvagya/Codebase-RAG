/**
 * ask.module.ts
 *
 * Wires the question-answering feature: it needs EmbeddingsModule (to embed the
 * query) and GeminiModule (to generate the answer). DbModule is @Global.
 */
import { Module } from '@nestjs/common';
import { AskController } from './ask.controller';
import { ChunksController } from './chunks.controller';
import { AskService } from './ask.service';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { GeminiModule } from '../gemini/gemini.module';

@Module({
  imports: [EmbeddingsModule, GeminiModule],
  // ChunksController serves GET /chunks/:id for the in-app code viewer.
  controllers: [AskController, ChunksController],
  providers: [AskService],
})
export class AskModule {}
