/**
 * app.module.ts
 *
 * The root module — it imports every feature module and the cross-cutting ones.
 *
 *   ConfigModule  -> loads backend/.env and makes ConfigService injectable
 *   DbModule      -> the @Global pgvector connection (used everywhere)
 *   ReposModule   -> POST /repos, GET /repos/:id        (indexing)
 *   AskModule     -> POST /repos/:id/ask                (question answering)
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module';
import { ReposModule } from './repos/repos.module';
import { AskModule } from './ask/ask.module';

@Module({
  imports: [
    // isGlobal so ConfigService is available in every module without re-import.
    // It reads the .env file in the backend working directory on startup.
    ConfigModule.forRoot({ isGlobal: true }),
    DbModule,
    ReposModule,
    AskModule,
  ],
})
export class AppModule {}
