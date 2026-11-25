import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe } from 'vitest';
import { createApp, type AppOptions } from '../src/app.js';
import { createDb, runMigrations, type Db } from '../src/db/client.js';
import { createLogger } from '../src/lib/logger.js';

export function testApp(overrides: Partial<AppOptions> = {}) {
  return createApp({
    logger: createLogger('silent'),
    version: 'test',
    corsOrigin: 'http://localhost:5173',
    healthChecks: {},
    ...overrides,
  });
}

/**
 * Tests that need PostgreSQL use DATABASE_URL_TEST (CI provides one).
 * Without it they are skipped locally; CI sets REQUIRE_DB_TESTS=1 so they can never be skipped there.
 * The test database is wiped, so never point this at real data.
 */
const DATABASE_URL_TEST = process.env.DATABASE_URL_TEST;
if (!DATABASE_URL_TEST && process.env.REQUIRE_DB_TESTS) {
  throw new Error('DATABASE_URL_TEST must be set when REQUIRE_DB_TESTS is set');
}

export const describeWithDb = describe.skipIf(!DATABASE_URL_TEST);

/** Gives each test file a freshly migrated database and empties every table before each test. */
export function useTestDb() {
  let handle: ReturnType<typeof createDb> | undefined;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL_TEST!);
    await handle.db.execute(sql`drop schema if exists public cascade`);
    await handle.db.execute(sql`drop schema if exists drizzle cascade`);
    await handle.db.execute(sql`create schema public`);
    await runMigrations(handle.db);
  });

  beforeEach(async () => {
    await handle!.db.execute(sql`
      do $$ declare t text;
      begin
        for t in select tablename from pg_tables where schemaname = 'public' loop
          execute format('truncate table %I restart identity cascade', t);
        end loop;
      end $$;
    `);
  });

  afterAll(async () => {
    await handle?.pool.end();
  });

  return {
    get db(): Db {
      return handle!.db;
    },
  };
}
