import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function createDb(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { pool, db };
}

/** Applies any pending migrations in apps/api/drizzle. Safe to run on every start. */
export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/** Postgres error code, whether thrown by pg directly or wrapped by Drizzle. */
export function pgErrorCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 3; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** A transaction handle, as passed to `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Functions that work both inside and outside a transaction take this. */
export type DbOrTx = Db | Tx;
