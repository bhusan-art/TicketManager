import type { Role } from '@ticketmanager/shared';
import request from 'supertest';
import { createAccessTokens } from '../src/auth/accessToken.js';
import { hashPassword } from '../src/auth/crypto.js';
import type { GoogleClient, GoogleIdentity } from '../src/auth/google.js';
import { loadConfig } from '../src/config.js';
import { emailOutbox, users } from '../src/db/schema.js';
import { createOutboxMailer } from '../src/mail/mailer.js';
import { createExportRunner } from '../src/documents/runner.js';
import type { Services } from '../src/services.js';
import { asc, sql } from 'drizzle-orm';
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

// ---- Auth helpers ----

export const TEST_PASSWORD = 'Expense#2026';

export function fakeGoogle(identity: () => GoogleIdentity | Error): GoogleClient {
  return {
    authUrl: ({ state }) => `https://accounts.google.test/auth?state=${state}`,
    exchange: async () => {
      const result = identity();
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

export function testServices(db: Db, overrides: Partial<Services> = {}) {
  let wakes = 0;
  const mailer = Object.assign(
    createOutboxMailer(db, () => {
      wakes += 1;
    }),
    { wakes: () => wakes },
  );
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:9080' });
  const services: Services = {
    db,
    config,
    mailer,
    exports: createExportRunner(db, (err) => console.error('Export failed in test', err)),
    tokens: createAccessTokens(config.JWT_SECRET, config.ACCESS_TOKEN_MINUTES),
    google: null,
    ...overrides,
  };
  return { services, mailer, app: testApp({ services }) };
}

/** Emails in the outbox, oldest first. */
export async function outbox(db: Db) {
  return db.select().from(emailOutbox).orderBy(asc(emailOutbox.createdAt), asc(emailOutbox.id));
}

let counter = 0;
const passwordHash = hashPassword(TEST_PASSWORD);

export async function makeUser(
  db: Db,
  fields: Partial<typeof users.$inferInsert> & { roles?: Role[]; password?: string | null } = {},
) {
  counter += 1;
  const { password, ...rest } = fields;
  const [row] = await db
    .insert(users)
    .values({
      email: `user${counter}@example.com`,
      name: `User ${counter}`,
      roles: ['employee'],
      passwordHash:
        password === null ? null : password ? await hashPassword(password) : await passwordHash,
      ...rest,
    })
    .returning();
  return row!;
}

/** Signs in and returns the access token and refresh cookie. */
export async function signIn(
  app: Parameters<typeof request>[0],
  email: string,
  password = TEST_PASSWORD,
) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200)
    throw new Error(`Sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return {
    token: res.body.accessToken as string,
    cookie: cookie.map((c) => c.split(';')[0]!).join('; '),
    user: res.body.user,
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
