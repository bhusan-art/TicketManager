import cors from 'cors';
import express, { type Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './http/middleware/errorHandler.js';
import { idempotency } from './http/middleware/idempotency.js';
import { requestId } from './http/middleware/requestId.js';
import { healthRouter, type HealthCheck } from './routes/health.js';

export interface AppOptions {
  logger: Logger;
  version: string;
  corsOrigin: string;
  healthChecks: Record<string, HealthCheck>;
  /** Extra routers mounted under /api/v1, keyed by path. Feature phases add theirs here. */
  routers?: Record<string, Router>;
}

export function createApp(options: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger: options.logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: options.corsOrigin.split(',').map((o) => o.trim()),
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  const api = express.Router();
  api.use('/health', healthRouter(options.version, options.healthChecks));
  api.use(idempotency());
  for (const [path, router] of Object.entries(options.routers ?? {})) {
    api.use(path, router);
  }
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
