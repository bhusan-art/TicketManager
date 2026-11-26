import { EXPORT_KEEP_DAYS, EXPORT_MAX_VOUCHERS, type ExportFilters } from '@ticketmanager/shared';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { recordAudit } from '../audit/audit.js';
import type { Db } from '../db/client.js';
import { exportJobs, files, users, vouchers } from '../db/schema.js';
import { saveFile } from '../storage/files.js';
import { exportCondition } from './scope.js';
import { EXPORT_MAX_BYTES, ExportTooLargeError, buildVoucherZip } from './zip.js';

export interface ExportRunner {
  /** Builds the export soon, one at a time, in the background. */
  schedule(id: string): void;
  /** Resolves once everything scheduled so far has finished. For tests and shutdown. */
  idle(): Promise<void>;
  /** Picks up exports left queued or half-built by a restart. */
  resume(): Promise<void>;
  /** Deletes the ZIPs of expired exports. Returns how many. */
  prune(): Promise<number>;
}

/**
 * Builds export ZIPs inside the API process. Building needs the same voucher queries and PDF
 * code as the API, and exports are rare, so a separate service isn't worth it yet.
 */
export function createExportRunner(db: Db, onError: (err: unknown) => void): ExportRunner {
  let chain: Promise<void> = Promise.resolve();

  async function run(id: string) {
    // Claim it; another API instance (or an earlier call) may have it already.
    const [job] = await db
      .update(exportJobs)
      .set({ status: 'running', startedAt: new Date() })
      .where(and(eq(exportJobs.id, id), inArray(exportJobs.status, ['queued', 'running'])))
      .returning();
    if (!job) return;
    try {
      const [user] = await db.select().from(users).where(eq(users.id, job.requestedBy));
      if (!user || user.status !== 'active' || !user.roles.includes(job.role)) {
        throw new Error('The person who asked for this export can no longer export in that role');
      }
      // Who may see what is checked again now, not just when it was requested.
      const rows = await db
        .select({ id: vouchers.id })
        .from(vouchers)
        .where(exportCondition({ userId: user.id, role: job.role }, job.filters as ExportFilters))
        .orderBy(asc(vouchers.submittedAt), asc(vouchers.number))
        .limit(EXPORT_MAX_VOUCHERS + 1);
      if (rows.length === 0) throw new Error('No vouchers match these filters any more');
      if (rows.length > EXPORT_MAX_VOUCHERS) {
        throw new Error(`More than ${EXPORT_MAX_VOUCHERS} vouchers match. Narrow the filters.`);
      }
      const auth = {
        userId: user.id,
        sessionId: `export:${job.id}`,
        activeRole: job.role,
        roles: user.roles,
        email: user.email,
        name: user.name,
      };
      const zip = await buildVoucherZip(
        db,
        auth,
        rows.map((r) => r.id),
        job.includeProofs,
      );
      await db.transaction(async (tx) => {
        const file = await saveFile(
          tx,
          {
            filename: job.filename,
            contentType: 'application/zip',
            data: zip.data,
            uploadedBy: user.id,
          },
          { maxBytes: EXPORT_MAX_BYTES },
        );
        const completedAt = new Date();
        await tx
          .update(exportJobs)
          .set({
            status: 'ready',
            fileId: file.id,
            voucherCount: zip.vouchers,
            sizeBytes: file.sizeBytes,
            completedAt,
            expiresAt: new Date(completedAt.getTime() + EXPORT_KEEP_DAYS * 86_400_000),
          })
          .where(eq(exportJobs.id, job.id));
        await recordAudit(tx, {
          action: 'export.completed',
          entityType: 'export',
          entityId: job.id,
          actorId: user.id,
          actorRole: job.role,
          after: { vouchers: zip.vouchers, files: zip.files, sizeBytes: file.sizeBytes },
        });
      });
    } catch (err) {
      const message =
        err instanceof ExportTooLargeError || err instanceof Error
          ? err.message
          : 'The export could not be built';
      await db
        .update(exportJobs)
        .set({ status: 'failed', error: message.slice(0, 500), completedAt: new Date() })
        .where(eq(exportJobs.id, job.id));
      if (!(err instanceof ExportTooLargeError)) onError(err);
    }
  }

  return {
    schedule(id) {
      chain = chain.then(() => run(id)).catch(onError);
    },
    idle: () => chain,
    async resume() {
      const pending = await db
        .select({ id: exportJobs.id })
        .from(exportJobs)
        .where(inArray(exportJobs.status, ['queued', 'running']))
        .orderBy(asc(exportJobs.createdAt));
      for (const p of pending) this.schedule(p.id);
    },
    async prune() {
      const expired = await db
        .select({ id: exportJobs.id, fileId: exportJobs.fileId })
        .from(exportJobs)
        .where(and(eq(exportJobs.status, 'ready'), lt(exportJobs.expiresAt, new Date())));
      for (const e of expired) {
        await db.transaction(async (tx) => {
          await tx
            .update(exportJobs)
            .set({ status: 'expired', fileId: null, linkTokenHash: null, linkExpiresAt: null })
            .where(eq(exportJobs.id, e.id));
          if (e.fileId) await tx.delete(files).where(eq(files.id, e.fileId));
        });
      }
      return expired.length;
    },
  };
}
