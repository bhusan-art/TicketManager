import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { authenticate } from './auth/middleware.js';
import { authRouter } from './auth/routes.js';
import type { Db } from './db/client.js';
import type { Logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './http/middleware/errorHandler.js';
import { idempotency } from './http/middleware/idempotency.js';
import { requestId } from './http/middleware/requestId.js';
import { healthRouter, type HealthCheck } from './routes/health.js';
import type { Services } from './services.js';
import { adminRouter } from './users/adminRoutes.js';
import { categoriesRouter } from './categories/routes.js';
import { approvalsRouter, voucherReviewRouter } from './vouchers/reviewRoutes.js';
import { vouchersRouter } from './vouchers/routes.js';

export interface AppOptions {
  logger: Logger;
  version: string;
  corsOrigin: string;
  healthChecks: Record<string, HealthCheck>;
  /** Needed for idempotency. Tests that don't touch the database can leave it out. */
  db?: Db;
  /** Enables sign-in and the feature routes. Implies `db`. */
  services?: Services;
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

  const services = options.services;
  const db = services?.db ?? options.db;
  const api = express.Router();
  api.use('/health', healthRouter(options.version, options.healthChecks));
  if (services) {
    api.use(cookieParser(services.config.JWT_SECRET));
    api.use(authenticate(services.db, services.tokens));
  }
  if (db) api.use(idempotency(db, { scope: (req) => req.auth?.userId ?? 'anonymous' }));
  if (services) {
    api.use('/auth', authRouter(services));
    api.use('/admin', adminRouter(services));
    api.use('/categories', categoriesRouter(services));
    api.use('/vouchers', vouchersRouter(services));
    api.use('/vouchers', voucherReviewRouter(services));
    api.use('/approvals', approvalsRouter(services));
  }
  for (const [path, router] of Object.entries(options.routers ?? {})) {
    api.use(path, router);
  }
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
