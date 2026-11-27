import { createAccessTokens } from './auth/accessToken.js';
import { createGoogleClient } from './auth/google.js';
import { createApp } from './app.js';
import { bootstrapAdmin } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createDb, runMigrations } from './db/client.js';
import { createExportRunner } from './documents/runner.js';
import { pruneIdempotencyKeys } from './http/middleware/idempotency.js';
import { checks, createRedis, workerLastSeen } from './lib/dependencies.js';
import { createLogger } from './lib/logger.js';
import { createOutboxMailer, createWorkerWaker } from './mail/mailer.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development');

const { pool, db } = createDb(config.DATABASE_URL);
await runMigrations(db);
logger.info('Database migrations applied');
await bootstrapAdmin(db, config, logger);

const redis = createRedis(config.REDIS_URL);
const waker = createWorkerWaker(config.REDIS_URL, (err) =>
  logger.warn({ err }, 'Could not wake the worker; mail goes out on its next sweep'),
);
const mailer = createOutboxMailer(db, waker.wake);
const exports = createExportRunner(db, (err) => logger.error({ err }, 'Export failed'));
await exports.resume();
const google =
  config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
    ? createGoogleClient({
        clientId: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        redirectUri: `${config.PUBLIC_URL}/api/v1/auth/google/callback`,
      })
    : null;
logger.info(google ? 'Google sign-in enabled' : 'Google sign-in not configured');

const app = createApp({
  logger,
  version: config.APP_VERSION,
  corsOrigin: config.CORS_ORIGIN,
  services: {
    db,
    config,
    mailer,
    exports,
    google,
    tokens: createAccessTokens(config.JWT_SECRET, config.ACCESS_TOKEN_MINUTES),
  },
  healthChecks: {
    database: checks.database(db),
    redis: checks.redis(redis),
    worker: checks.worker(redis),
  },
  workerLastSeen: workerLastSeen(redis),
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'API listening');
});

const pruneTimer = setInterval(
  () => {
    pruneIdempotencyKeys(db).catch((err: unknown) =>
      logger.warn({ err }, 'Pruning idempotency keys failed'),
    );
    exports
      .prune()
      .then((n) => n && logger.info({ expired: n }, 'Deleted expired exports'))
      .catch((err: unknown) => logger.warn({ err }, 'Pruning exports failed'));
  },
  60 * 60 * 1000,
);
pruneTimer.unref();

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  clearInterval(pruneTimer);
  server.close();
  await exports.idle();
  await Promise.allSettled([pool.end(), redis.quit(), waker.close()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
