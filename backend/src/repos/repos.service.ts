/**
 * repos.service.ts
 *
 * The INDEXING half of the system. Given a GitHub URL it runs the pipeline:
 *
 *   clone repo  ->  walk source files  ->  chunk each file  ->  embed chunks
 *               ->  store chunks+vectors in pgvector  ->  mark repo "ready"
 *
 * Indexing can take a while, so createRepo() returns immediately with a repo id
 * and the heavy work runs in the background. The frontend polls GET /repos/:id
 * to watch `status` move pending -> cloning -> chunking -> embedding -> ready.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { simpleGit } from 'simple-git';
import { promises as fs } from 'fs';
import { join } from 'path';
import { DbService } from '../db/db.service';
import { ChunkerService, RawChunk } from '../chunker/chunker.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';

/** Row shape of the `repos` table (the columns we read back). */
export interface RepoRow {
  id: string;
  url: string;
  default_branch: string | null;
  status: string;
  error: string | null;
  chunk_count: number;
  created_at: string;
  indexed_at: string | null;
}

@Injectable()
export class ReposService {
  private readonly logger = new Logger(ReposService.name);

  // Where cloned repos land temporarily. Under cwd (backend/) and git-ignored.
  private readonly CLONE_BASE = join(process.cwd(), '.repos');

  // Safety caps so one huge repo can't exhaust the embedding free tier or
  // make a demo crawl. If we hit the cap we LOG it (never silently truncate).
  private readonly MAX_FILES = 600;
  private readonly MAX_CHUNKS = 1500;
  private readonly MAX_FILE_BYTES = 200_000; // skip files larger than ~200 KB

  // Directories we never want to index (dependencies, build output, vcs, etc.).
  private readonly IGNORE_DIRS = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    '.next',
    'out',
    'vendor',
    '.venv',
    '__pycache__',
    'coverage',
    '.cache',
  ]);

  constructor(
    private readonly db: DbService,
    private readonly chunker: ChunkerService,
    private readonly embeddings: EmbeddingsService,
  ) {}

  /**
   * Public entry point for POST /repos. Inserts a "pending" row, starts the
   * background indexing job (note: NOT awaited), and returns the new row so the
   * caller immediately gets an id to poll.
   */
  async createRepo(url: string): Promise<RepoRow> {
    const normalized = url.replace(/\/$/, ''); // drop any trailing slash
    const [repo] = await this.db.query<RepoRow>(
      `INSERT INTO repos (url, status) VALUES ($1, 'pending') RETURNING *`,
      [normalized],
    );

    // Fire-and-forget. We deliberately don't `await` this — the HTTP response
    // returns now, and indexing continues in the background. Errors are caught
    // inside indexRepo() and recorded on the row, so an unhandled rejection
    // can't crash the process.
    void this.indexRepo(repo.id, normalized);

    return repo;
  }

  /** GET /repos/:id — fetch current status / metadata. */
  async getRepo(id: string): Promise<RepoRow> {
    const [repo] = await this.db.query<RepoRow>(
      `SELECT * FROM repos WHERE id = $1`,
      [id],
    );
    if (!repo) throw new NotFoundException(`Repo ${id} not found`);
    return repo;
  }

  // -------------------------------------------------------------------------
  // The background pipeline.
  // -------------------------------------------------------------------------
  private async indexRepo(repoId: string, url: string): Promise<void> {
    const dir = join(this.CLONE_BASE, repoId);
    try {
      // 1) CLONE (shallow: --depth 1 grabs only the latest commit = faster/smaller)
      await this.setStatus(repoId, 'cloning');
      await fs.mkdir(this.CLONE_BASE, { recursive: true });
      await simpleGit().clone(url, dir, ['--depth', '1']);

      // Record which branch we ended up on (the repo's default).
      const branch = (
        await simpleGit(dir).revparse(['--abbrev-ref', 'HEAD'])
      ).trim();
      await this.db.query(`UPDATE repos SET default_branch = $1 WHERE id = $2`, [
        branch,
        repoId,
      ]);

      // 2) CHUNK: walk files, split each into chunks.
      await this.setStatus(repoId, 'chunking');
      const files = await this.collectSourceFiles(dir);
      this.logger.log(`${url}: ${files.length} source files to chunk`);

      const chunks: RawChunk[] = [];
      for (const abs of files) {
        const rel = abs.slice(dir.length + 1); // path relative to repo root
        // Strip NUL bytes (0x00): they're valid UTF-8 but Postgres TEXT columns
        // reject them, and they only appear in binary-ish files anyway.
        const content = (await fs.readFile(abs, 'utf8')).split(String.fromCharCode(0)).join('');
        chunks.push(...this.chunker.chunkFile(rel, content));
        if (chunks.length >= this.MAX_CHUNKS) {
          this.logger.warn(
            `Reached MAX_CHUNKS (${this.MAX_CHUNKS}) for ${url}; ` +
              `remaining files were skipped.`,
          );
          break;
        }
      }

      // 3) EMBED: convert every chunk's text into a vector (batched internally).
      await this.setStatus(repoId, 'embedding');
      const vectors = await this.embeddings.embedDocuments(
        chunks.map((c) => c.content),
      );

      // 4) STORE: write chunks + their vectors into pgvector.
      await this.storeChunks(repoId, chunks, vectors);

      // 5) DONE.
      await this.db.query(
        `UPDATE repos
           SET status = 'ready', indexed_at = now(), chunk_count = $1
         WHERE id = $2`,
        [chunks.length, repoId],
      );
      this.logger.log(`${url}: indexed ${chunks.length} chunks ✔`);
    } catch (err) {
      // Any failure is recorded on the row so the UI can show it.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Indexing failed for ${url}: ${message}`);
      await this.db.query(
        `UPDATE repos SET status = 'error', error = $1 WHERE id = $2`,
        [message, repoId],
      );
    } finally {
      // Clean up the clone — the code we need now lives in the DB as chunks.
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Update just the status column (small helper to keep the pipeline readable). */
  private async setStatus(repoId: string, status: string): Promise<void> {
    await this.db.query(`UPDATE repos SET status = $1 WHERE id = $2`, [
      status,
      repoId,
    ]);
  }

  /**
   * Recursively walk the cloned repo and return absolute paths of files worth
   * indexing: known source extensions, not in an ignored dir, not too large.
   */
  private async collectSourceFiles(root: string): Promise<string[]> {
    const out: string[] = [];

    const walk = async (current: string): Promise<void> => {
      if (out.length >= this.MAX_FILES) return;
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (out.length >= this.MAX_FILES) return;
        const full = join(current, entry.name);

        if (entry.isDirectory()) {
          if (this.IGNORE_DIRS.has(entry.name)) continue;
          await walk(full);
        } else if (entry.isFile()) {
          if (!this.isIndexableFile(entry.name)) continue;
          const stat = await fs.stat(full);
          if (stat.size > this.MAX_FILE_BYTES) continue; // skip huge/minified files
          out.push(full);
        }
      }
    };

    await walk(root);
    if (out.length >= this.MAX_FILES) {
      this.logger.warn(
        `Reached MAX_FILES (${this.MAX_FILES}); some files were not indexed.`,
      );
    }
    return out;
  }

  /** Only index files whose extension we recognise (keeps binaries/locks out). */
  private isIndexableFile(name: string): boolean {
    // Skip lockfiles and minified bundles explicitly — they're noise.
    if (/package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.min\.(js|css)$/.test(name))
      return false;
    const allowed = [
      'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rb', 'rs',
      'c', 'h', 'cpp', 'cs', 'php', 'json', 'md', 'sql', 'sh',
      'yml', 'yaml', 'html', 'css',
    ];
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    return allowed.includes(ext);
  }

  /**
   * Bulk-insert chunks. We build one multi-row INSERT per batch so we hit the
   * DB a handful of times instead of once per chunk. The embedding is bound as
   * a pgvector literal string (see DbService.toVectorLiteral).
   */
  private async storeChunks(
    repoId: string,
    chunks: RawChunk[],
    vectors: number[][],
  ): Promise<void> {
    const BATCH = 100;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batchChunks = chunks.slice(i, i + BATCH);
      const batchVectors = vectors.slice(i, i + BATCH);

      // Build the VALUES list + flat params array. Each row has 8 params.
      const valuesSql: string[] = [];
      const params: unknown[] = [];
      batchChunks.forEach((c, j) => {
        const base = j * 8;
        valuesSql.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, ` +
            `$${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
        );
        params.push(
          repoId,
          c.filePath,
          c.startLine,
          c.endLine,
          c.language,
          c.symbolName,
          c.content,
          this.db.toVectorLiteral(batchVectors[j]),
        );
      });

      await this.db.query(
        `INSERT INTO code_chunks
           (repo_id, file_path, start_line, end_line, language, symbol_name, content, embedding)
         VALUES ${valuesSql.join(', ')}`,
        params,
      );
    }
  }
}
