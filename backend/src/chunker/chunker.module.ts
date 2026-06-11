/**
 * chunker.module.ts
 *
 * Exports ChunkerService so the repos (indexing) flow can use it. Isolated in
 * its own module so the milestone-4 swap to AST-based chunking is contained
 * entirely within this folder.
 */
import { Module } from '@nestjs/common';
import { ChunkerService } from './chunker.service';

@Module({
  providers: [ChunkerService],
  exports: [ChunkerService],
})
export class ChunkerModule {}
