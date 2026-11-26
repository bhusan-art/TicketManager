import { createAccessTokens } from './auth/accessToken.js';
import { createGoogleClient } from './auth/google.js';
import { createApp } from './app.js';
import { bootstrapAdmin } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createDb, runMigrations } from './db/client.js';
import { pruneIdempotencyKeys } from './http/middleware/idempotency.js';
import { checks, createRedis } from './lib/dependencies.js';
import { createLogger } from './lib/logger.js';
import { createQueueMailer } from './mail/mailer.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development');

const { pool, db } = createDb(config.DATABASE_URL);
await runMigrations(db);
logger.info('Database migrations applied');
await bootstrapAdmin(db, config, logger);

const redis = createRedis(config.REDIS_URL);
const mailer = createQueueMailer(config.REDIS_URL);
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
    google,
    tokens: createAccessTokens(config.JWT_SECRET, config.ACCESS_TOKEN_MINUTES),
  },
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
  await Promise.allSettled([pool.end(), redis.quit(), mailer.close()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
