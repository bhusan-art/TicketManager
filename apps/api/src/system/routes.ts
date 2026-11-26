import { BACKUP_OVERDUE_HOURS, type BackupRun, type SystemStatus } from '@ticketmanager/shared';
import { desc, eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { backupRuns, emailOutbox } from '../db/schema.js';
import { runCheck, type HealthCheck } from '../routes/health.js';
import type { Services } from '../services.js';

export interface SystemProbes {
  version: string;
  checks: Record<string, HealthCheck>;
  /** When the worker last finished an outbox sweep, or null if it hasn't for a while. */
  workerLastSeen: () => Promise<string | null>;
}

const toRun = (r: typeof backupRuns.$inferSelect): BackupRun => ({
  id: r.id,
  status: r.status,
  file: r.file,
  sizeBytes: r.sizeBytes,
  error: r.error,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt.toISOString(),
});

/** GET /admin/system: services, worker, email outbox and backups at a glance. Admin only. */
export function systemRouter({ db }: Services, probes: SystemProbes) {
  const router = Router();
  router.use(requireRole('admin'));

  router.get('/', async (_req, res) => {
    const names = Object.keys(probes.checks);
    const results = await Promise.all(names.map((n) => runCheck(probes.checks[n]!)));
    const [lastSeenAt, emailRows, runs, [lastOk]] = await Promise.all([
      probes.workerLastSeen().catch(() => null),
      db
        .select({
          status: emailOutbox.status,
          n: sql<number>`count(*)::int`,
          oldest: sql<Date | null>`min(${emailOutbox.createdAt})`,
        })
        .from(emailOutbox)
        .where(sql`${emailOutbox.status} in ('pending', 'failed')`)
        .groupBy(emailOutbox.status),
      db.select().from(backupRuns).orderBy(desc(backupRuns.finishedAt)).limit(10),
      db
        .select({ at: backupRuns.finishedAt })
        .from(backupRuns)
        .where(eq(backupRuns.status, 'ok'))
        .orderBy(desc(backupRuns.finishedAt))
        .limit(1),
    ]);
    const pending = emailRows.find((r) => r.status === 'pending');
    const failed = emailRows.find((r) => r.status === 'failed');
    const lastSuccessAt = lastOk?.at ?? null;
    const body: SystemStatus = {
      version: probes.version,
      uptimeSeconds: Math.round(process.uptime()),
      checks: Object.fromEntries(names.map((n, i) => [n, results[i]!])),
      worker: { lastSeenAt },
      email: {
        pending: pending?.n ?? 0,
        failed: failed?.n ?? 0,
        oldestPendingAt: pending?.oldest ? new Date(pending.oldest).toISOString() : null,
      },
      backups: {
        lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
        overdue:
          !lastSuccessAt ||
          Date.now() - lastSuccessAt.getTime() > BACKUP_OVERDUE_HOURS * 60 * 60 * 1000,
        recent: runs.map(toRun),
      },
    };
    res.json(body);
  });

  return router;
}
