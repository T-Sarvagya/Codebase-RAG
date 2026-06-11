/**
 * db.module.ts
 *
 * Marked @Global so we only import it once (in AppModule) and then DbService
 * is injectable everywhere without re-importing this module in each feature
 * module. The database connection is a truly app-wide singleton, which is
 * exactly the case @Global is meant for.
 */
import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service';

@Global()
@Module({
  providers: [DbService],
  exports: [DbService], // make DbService available to importers/everywhere
})
export class DbModule {}
