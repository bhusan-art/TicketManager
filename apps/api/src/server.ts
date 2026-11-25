import mongoose from 'mongoose';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { checks, connectMongo, createRedis, createS3, ensureBucket } from './lib/dependencies.js';
import { createLogger } from './lib/logger.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development');

await connectMongo(config.MONGO_URL);
logger.info('Connected to MongoDB');
const redis = createRedis(config.REDIS_URL);
const s3 = createS3(config);
try {
  await ensureBucket(s3, config.S3_BUCKET);
} catch (err) {
  // Storage is only needed for uploads; start anyway and let /health report it.
  logger.warn({ err }, 'Could not reach file storage at startup');
}

const app = createApp({
  logger,
  version: config.APP_VERSION,
  corsOrigin: config.CORS_ORIGIN,
  healthChecks: {
    mongo: checks.mongo(),
    redis: checks.redis(redis),
    storage: checks.storage(s3, config.S3_BUCKET),
  },
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'API listening');
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  server.close();
  await Promise.allSettled([mongoose.disconnect(), redis.quit()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
