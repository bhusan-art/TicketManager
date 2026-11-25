import { Router } from 'express';
import type { DependencyStatus, HealthResponse } from '@ticketmanager/shared';

export type HealthCheck = () => Promise<boolean>;

const TIMEOUT_MS = 2000;

async function run(check: HealthCheck): Promise<DependencyStatus> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const ok = await Promise.race([
      check(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), TIMEOUT_MS);
      }),
    ]);
    return ok ? 'up' : 'down';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

export function healthRouter(version: string, checks: Record<string, HealthCheck>) {
  const router = Router();

  /** Liveness: the process is up. Used by Docker's healthcheck. */
  router.get('/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  /** Readiness: the process and every dependency are reachable. */
  router.get('/', async (_req, res) => {
    const names = Object.keys(checks);
    const results = await Promise.all(names.map((n) => run(checks[n]!)));
    const statuses = Object.fromEntries(names.map((n, i) => [n, results[i]!]));
    const allUp = results.every((r) => r === 'up');
    const body: HealthResponse = {
      status: allUp ? 'ok' : 'degraded',
      version,
      uptimeSeconds: Math.round(process.uptime()),
      checks: statuses,
    };
    res.status(allUp ? 200 : 503).json(body);
  });

  return router;
}
