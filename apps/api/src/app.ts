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
import {
  createRateLimiter,
  DEFAULT_RATE_LIMITS,
  type RateLimits,
} from './http/middleware/rateLimit.js';
import { requestId } from './http/middleware/requestId.js';
import { healthRouter, type HealthCheck } from './routes/health.js';
import type { Services } from './services.js';
import { systemRouter } from './system/routes.js';
import { adminRouter } from './users/adminRoutes.js';
import { advanceSettingsRouter, advancesRouter } from './advances/routes.js';
import { categoriesRouter } from './categories/routes.js';
import { projectsRouter } from './projects/routes.js';
import { whatsAppRouter } from './notifications/whatsapp.js';
import { auditRouter, exportsRouter, voucherZipRouter } from './documents/routes.js';
import {
  advanceFollowUpRouter,
  emailLogRouter,
  notificationSettingsRouter,
  notificationsRouter,
  voucherFollowUpRouter,
} from './notifications/routes.js';
import { paymentQueueRouter, voucherPaymentsRouter } from './payments/routes.js';
import { accountsRouter, reportsRouter } from './reports/routes.js';
import { approvalsRouter, voucherReviewRouter } from './vouchers/reviewRoutes.js';
import { vouchersRouter } from './vouchers/routes.js';
import { formsRouter } from './documents/formsRoutes.js';

export interface AppOptions {
  logger: Logger;
  version: string;
  corsOrigin: string;
  healthChecks: Record<string, HealthCheck>;
  /** Needed for idempotency. Tests that don't touch the database can leave it out. */
  db?: Db;
  /** Enables sign-in and the feature routes. Implies `db`. */
  services?: Services;
  /** When the worker last checked in. Leave out where there is no worker (tests). */
  workerLastSeen?: () => Promise<string | null>;
  /** Per-address limits on sign-in and similar endpoints. `false` turns them off (tests). */
  rateLimits?: RateLimits | false;
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
    // Workflow steps add emails to the outbox in their transaction. Once a change has gone through,
    // nudge the worker so the email goes out now rather than on its next sweep.
    api.use((req, res, next) => {
      if (req.method !== 'GET') {
        res.on('finish', () => {
          if (res.statusCode < 400) services.mailer.wake();
        });
      }
      next();
    });
    const limits = options.rateLimits ?? DEFAULT_RATE_LIMITS;
    if (limits) {
      const { limit } = createRateLimiter();
      api.post('/auth/login', limit('login', limits.login));
      api.post('/auth/password/forgot', limit('passwordForgot', limits.passwordForgot));
      api.post('/auth/password/reset', limit('passwordReset', limits.passwordReset));
      api.get('/auth/google/callback', limit('google', limits.google));
      api.get('/exports/download/:token', limit('exportLink', limits.exportLink));
    }
    api.use('/auth', authRouter(services));
    api.use('/admin', adminRouter(services));
    api.use('/categories', categoriesRouter(services));
    api.use('/projects', projectsRouter(services));
    api.use('/vouchers', vouchersRouter(services));
    api.use('/vouchers', voucherFollowUpRouter(services));
    api.use('/vouchers', voucherZipRouter(services));
    api.use('/vouchers', whatsAppRouter('voucher', services));
    api.use('/vouchers', voucherReviewRouter(services));
    api.use('/approvals', approvalsRouter(services));
    api.use('/vouchers', voucherPaymentsRouter(services));
    api.use('/payments', paymentQueueRouter(services));
    api.use('/accounts', accountsRouter(services));
    api.use('/reports', reportsRouter(services));
    api.use('/advances', advancesRouter(services));
    api.use('/admin/settings/advances', advanceSettingsRouter(services));
    api.use('/advances', advanceFollowUpRouter(services));
    api.use('/advances', whatsAppRouter('advance', services));
    api.use('/forms', formsRouter(services));
    api.use('/notifications', notificationsRouter(services));
    api.use('/admin/emails', emailLogRouter(services));
    api.use(
      '/admin/system',
      systemRouter(services, {
        version: options.version,
        checks: options.healthChecks,
        workerLastSeen: options.workerLastSeen ?? (async () => null),
      }),
    );
    api.use('/admin/settings/notifications', notificationSettingsRouter(services));
    api.use('/exports', exportsRouter(services));
    api.use('/audit', auditRouter(services));
  }
  for (const [path, router] of Object.entries(options.routers ?? {})) {
    api.use(path, router);
  }
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
