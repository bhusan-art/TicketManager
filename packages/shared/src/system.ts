import type { DependencyStatus } from './health.js';

/** Redis key the worker refreshes on every outbox sweep. The API reads it for /health. */
export const WORKER_HEARTBEAT_KEY = 'ticketmanager:worker:heartbeat';
/** Gone this long after the last beat means the worker is down (a sweep runs every 15 s). */
export const WORKER_HEARTBEAT_TTL_SECONDS = 120;

/** A backup older than this is reported as overdue (nightly, with some slack). */
export const BACKUP_OVERDUE_HOURS = 26;

export const BACKUP_RUN_STATUSES = ['ok', 'failed'] as const;
export type BackupRunStatus = (typeof BACKUP_RUN_STATUSES)[number];

/** One nightly (or manual) database backup, as recorded by the backup service. */
export interface BackupRun {
  id: number;
  status: BackupRunStatus;
  file: string | null;
  sizeBytes: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string;
}

/** What Admins see on the dashboard: services, the worker, email and backups. */
export interface SystemStatus {
  version: string;
  uptimeSeconds: number;
  checks: Record<string, DependencyStatus>;
  worker: { lastSeenAt: string | null };
  email: { pending: number; failed: number; oldestPendingAt: string | null };
  backups: {
    lastSuccessAt: string | null;
    /** No successful backup in BACKUP_OVERDUE_HOURS (or ever). */
    overdue: boolean;
    recent: BackupRun[];
  };
}
