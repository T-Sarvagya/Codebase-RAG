/**
 * chunks.controller.ts
 *
 * Serves a single stored code chunk by id:
 *   GET /chunks/:id  ->  { filePath, startLine, endLine, language, symbolName, content }
 *
 * The frontend's code viewer calls this when you click a citation, so it can
 * show the actual cited code (with line numbers) inside the app — no round trip
 * to GitHub. We already stored the chunk's text at index time, so this is just
 * a lookup.
 */
import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { DbService } from '../db/db.service';

interface ChunkRow {
  id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string | null;
  symbol_name: string | null;
  content: string;
}

@Controller('chunks')
export class ChunksController {
  constructor(private readonly db: DbService) {}

  @Get(':id')
  async getChunk(@Param('id') id: string): Promise<ChunkRow> {
    const [chunk] = await this.db.query<ChunkRow>(
      `SELECT id, file_path, start_line, end_line, language, symbol_name, content
         FROM code_chunks
        WHERE id = $1`,
      [id],
    );
    if (!chunk) throw new NotFoundException(`Chunk ${id} not found`);
    return chunk;
  }
}
