/**
 * repos.module.ts
 *
 * Wires the indexing feature together. It needs the ChunkerModule and
 * EmbeddingsModule (DbModule is @Global, so it doesn't need importing here).
 */
import { Module } from '@nestjs/common';
import { ReposController } from './repos.controller';
import { ReposService } from './repos.service';
import { ChunkerModule } from '../chunker/chunker.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';

@Module({
  imports: [ChunkerModule, EmbeddingsModule],
  controllers: [ReposController],
  providers: [ReposService],
})
export class ReposModule {}
