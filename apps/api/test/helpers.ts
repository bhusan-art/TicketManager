import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe } from 'vitest';
import { createApp, type AppOptions } from '../src/app.js';
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
 * Tests that need MongoDB use MONGO_URL_TEST (CI and `docker compose` both provide one).
 * Without it they are skipped locally; CI sets REQUIRE_DB_TESTS=1 so they can never be skipped there.
 */
const MONGO_URL_TEST = process.env.MONGO_URL_TEST;
if (!MONGO_URL_TEST && process.env.REQUIRE_DB_TESTS) {
  throw new Error('MONGO_URL_TEST must be set when REQUIRE_DB_TESTS is set');
}

export const describeWithDb = describe.skipIf(!MONGO_URL_TEST);

export function useTestDb() {
  beforeAll(async () => {
    await mongoose.connect(MONGO_URL_TEST!, { serverSelectionTimeoutMS: 5000 });
    await mongoose.connection.dropDatabase();
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  });
  beforeEach(async () => {
    const db = mongoose.connection.db!;
    const collections = await db.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
}
