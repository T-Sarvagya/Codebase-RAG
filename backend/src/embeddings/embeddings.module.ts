/**
 * embeddings.module.ts
 *
 * Bundles the EmbeddingsService and exports it so both the indexing flow
 * (repos module) and the search flow (ask module) can reuse the same instance.
 */
import { Module } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service';

@Module({
  providers: [EmbeddingsService],
  exports: [EmbeddingsService],
})
export class EmbeddingsModule {}
