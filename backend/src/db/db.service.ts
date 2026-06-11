/**
 * db.service.ts
 *
 * Thin wrapper around a single shared `pg` connection Pool. Every other part
 * of the app talks to Postgres through this service instead of creating its
 * own connection — that's the standard NestJS pattern (one pooled resource,
 * injected wherever it's needed).
 *
 * Responsibilities:
 *   1. Open a connection pool on startup using DATABASE_URL.
 *   2. Run schema.sql once so the tables/extension exist (a tiny "migration").
 *   3. Expose a `query()` helper and a couple of pgvector convenience methods.
 */
import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, QueryResultRow } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);

  // The pool manages a set of reusable DB connections for us.
  private pool!: Pool;

  constructor(private readonly config: ConfigService) {}

  /** NestJS calls this automatically once when the module starts. */
  async onModuleInit(): Promise<void> {
    const connectionString = this.config.getOrThrow<string>('DATABASE_URL');
    this.pool = new Pool({ connectionString });

    // Fail fast with a clear message if Postgres isn't up yet.
    try {
      await this.pool.query('SELECT 1');
    } catch (err) {
      this.logger.error(
        'Could not connect to Postgres. Is the Docker DB running? ' +
          '(`docker compose up -d`)',
      );
      throw err;
    }

    await this.runSchema();
    this.logger.log('Database ready.');
  }

  /** NestJS calls this on shutdown — close the pool cleanly. */
  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  /**
   * Reads schema.sql and executes it. Every statement is `IF NOT EXISTS`, so
   * this is safe to run on every boot. This is our lightweight migration step;
   * a bigger project would use a real migration tool instead.
   */
  private async runSchema(): Promise<void> {
    // __dirname points at the compiled dist/ folder at runtime, so the .sql
    // file must sit next to the compiled .js. nest-cli.json copies it for us
    // (see the "assets" config). During `ts-node`/dev it resolves from src/.
    const schemaPath = join(__dirname, 'schema.sql');
    const sql = readFileSync(schemaPath, 'utf8');
    await this.pool.query(sql);
    this.logger.log('Schema applied (tables + pgvector extension).');
  }

  /**
   * Run a parameterised SQL query. Always pass user/data values via `params`
   * ($1, $2, ...) — never string-concatenate them — to avoid SQL injection.
   *
   * The generic <T> lets callers describe the row shape they expect back.
   */
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(text, params);
    return result.rows;
  }

  /**
   * pgvector accepts a vector literal as a string like "[0.12,0.98,...]".
   * This helper turns a JS number[] into that exact format so we can bind it
   * as a normal query parameter.
   */
  toVectorLiteral(embedding: number[]): string {
    return `[${embedding.join(',')}]`;
  }
}
