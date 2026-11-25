import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, runMigrations } from './db/client.js';
import { pruneIdempotencyKeys } from './http/middleware/idempotency.js';
import { checks, createRedis } from './lib/dependencies.js';
import { createLogger } from './lib/logger.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development');

const { pool, db } = createDb(config.DATABASE_URL);
await runMigrations(db);
logger.info('Database migrations applied');
const redis = createRedis(config.REDIS_URL);

const app = createApp({
  logger,
  db,
  version: config.APP_VERSION,
  corsOrigin: config.CORS_ORIGIN,
  healthChecks: {
    database: checks.database(db),
    redis: checks.redis(redis),
  },
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'API listening');
});

const pruneTimer = setInterval(
  () =>
    pruneIdempotencyKeys(db).catch((err: unknown) =>
      logger.warn({ err }, 'Pruning idempotency keys failed'),
    ),
  60 * 60 * 1000,
);
pruneTimer.unref();

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  clearInterval(pruneTimer);
  server.close();
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
