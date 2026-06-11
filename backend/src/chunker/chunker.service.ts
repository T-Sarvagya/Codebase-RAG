/**
 * chunker.service.ts
 *
 * Splits a source file into smaller "chunks" that we embed and store. Why chunk
 * at all? Embedding a whole file produces one fuzzy vector that means
 * everything-and-nothing; small, focused chunks give precise matches and let us
 * cite exact line ranges.
 *
 * THIS IS THE FIRST-PASS (NAIVE) CHUNKER: it slides a fixed-size window over the
 * file's lines with a little overlap. It's simple and language-agnostic, but it
 * can cut a function in half. Milestone 4 replaces this with AST-aware chunking
 * (tree-sitter) that splits on function/class boundaries — the same public
 * method signature will stay, so nothing downstream has to change.
 */
import { Injectable } from '@nestjs/common';

/** One chunk of a file, with the metadata we need to store + cite it later. */
export interface RawChunk {
  filePath: string; // path relative to the repo root
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  language: string | null; // inferred from the file extension
  symbolName: string | null; // null for naive chunks; AST chunker fills this in
  content: string; // the actual code text
}

@Injectable()
export class ChunkerService {
  // How many lines per chunk, and how many lines adjacent chunks share. Overlap
  // means a function that straddles a window boundary still appears whole in at
  // least one chunk, softening the naive splitter's biggest weakness.
  private readonly WINDOW_LINES = 60;
  private readonly OVERLAP_LINES = 10;

  /** Map common file extensions to a language label (used for display + later AST). */
  private readonly EXT_TO_LANG: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    java: 'java',
    go: 'go',
    rb: 'ruby',
    rs: 'rust',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    json: 'json',
    md: 'markdown',
    sql: 'sql',
    sh: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    html: 'html',
    css: 'css',
  };

  /**
   * Split one file into chunks. Returns [] for empty/whitespace-only files.
   */
  chunkFile(filePath: string, content: string): RawChunk[] {
    const trimmed = content.trim();
    if (trimmed.length === 0) return [];

    const language = this.detectLanguage(filePath);
    const lines = content.split('\n');
    const chunks: RawChunk[] = [];

    // Step forward by (window - overlap) each time so consecutive chunks overlap.
    const step = this.WINDOW_LINES - this.OVERLAP_LINES;

    for (let start = 0; start < lines.length; start += step) {
      const end = Math.min(start + this.WINDOW_LINES, lines.length);
      const slice = lines.slice(start, end).join('\n');

      // Skip windows that are only blank lines.
      if (slice.trim().length === 0) continue;

      chunks.push({
        filePath,
        startLine: start + 1, // convert 0-based array index to 1-based line no.
        endLine: end,
        language,
        symbolName: null,
        content: slice,
      });

      // If this window already reached the end of the file, stop.
      if (end === lines.length) break;
    }

    return chunks;
  }

  /** Look up the language from the file's extension; null if unknown. */
  private detectLanguage(filePath: string): string | null {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    return this.EXT_TO_LANG[ext] ?? null;
  }
}
