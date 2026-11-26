import {
  APP_TIME_ZONE,
  AUDIT_VIEWER_ROLES,
  DOWNLOAD_LINK_HOURS,
  EXPORT_MAX_VOUCHERS,
  auditQuerySchema,
  createExportSchema,
  exportFiltersSchema,
  paginationQuerySchema,
  type AuditEntry,
  type AuditFacets,
  type AuditQuery,
  type DownloadLink,
  type ExportFilters,
  type ExportJob,
  type ExportPreview,
} from '@ticketmanager/shared';
import { and, count, desc, eq, gt, inArray, like, sql, type SQL } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { hashToken, newToken } from '../auth/crypto.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import type { Db } from '../db/client.js';
import {
  advances,
  auditLog,
  emailOutbox,
  exportJobs,
  files,
  users,
  voucherAttachments,
  vouchers,
} from '../db/schema.js';
import { AppError, forbidden, notFound } from '../http/errors.js';
import { paginate } from '../http/pagination.js';
import { contentDisposition } from '../http/upload.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import type { Services } from '../services.js';
import { readFile } from '../storage/files.js';
import { getVoucherDetail } from '../vouchers/queries.js';
import { canView } from '../vouchers/workflow.js';
import { EXPORT_ROLES, exportCondition } from './scope.js';
import { ExportTooLargeError, buildVoucherZip, safeName, toCsv } from './zip.js';

const idParams = z.object({ id: z.uuid() });
const tokenParams = z.object({ token: z.string().min(20).max(100) });

function requireExportRole(req: Request) {
  if (!EXPORT_ROLES.includes(req.auth!.activeRole)) {
    throw forbidden('Switch to your employee, manager, Accounts or Director role to export');
  }
}

function toJob(j: typeof exportJobs.$inferSelect): ExportJob {
  return {
    id: j.id,
    status: j.status,
    filters: j.filters as ExportFilters,
    includeProofs: j.includeProofs,
    role: j.role,
    filename: j.filename,
    vouchers: j.voucherCount,
    sizeBytes: j.sizeBytes,
    error: j.error,
    downloads: j.downloads,
    createdAt: j.createdAt.toISOString(),
    completedAt: j.completedAt?.toISOString() ?? null,
    expiresAt: j.expiresAt?.toISOString() ?? null,
  };
}

/** "vouchers-2026-11-26-1530.zip", in Indian time. */
function exportFilename(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: APP_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `vouchers-${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}.zip`;
}

function sendZip(res: Response, filename: string, data: Buffer) {
  res
    .status(200)
    .type('application/zip')
    .set({
      'Content-Disposition': contentDisposition('attachment', filename),
      'Content-Length': String(data.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    .end(data);
}

async function preview(db: Db, req: Request, filters: ExportFilters): Promise<ExportPreview> {
  const where = exportCondition({ userId: req.auth!.userId, role: req.auth!.activeRole }, filters);
  const [v] = await db
    .select({ n: count(), total: sql<string>`coalesce(sum(${vouchers.totalPaise}), 0)` })
    .from(vouchers)
    .where(where);
  const [p] = await db
    .select({ n: count(), bytes: sql<string>`coalesce(sum(${files.sizeBytes}), 0)` })
    .from(voucherAttachments)
    .innerJoin(vouchers, eq(vouchers.id, voucherAttachments.voucherId))
    .innerJoin(files, eq(files.id, voucherAttachments.fileId))
    .where(where);
  return {
    vouchers: v!.n,
    totalPaise: Number(v!.total),
    proofs: p!.n,
    proofBytes: Number(p!.bytes),
    tooMany: v!.n > EXPORT_MAX_VOUCHERS,
  };
}

/** /exports: bulk ZIP exports, their history, and shareable download links. */
export function exportsRouter({ db, config, exports }: Services) {
  const router = Router();

  /** A shareable link: works without signing in, until it expires or the export does. */
  router.get('/download/:token', async (req, res) => {
    const { token } = parseParams(tokenParams, req);
    const [job] = await db
      .select()
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.linkTokenHash, hashToken(token)),
          gt(exportJobs.linkExpiresAt, new Date()),
          eq(exportJobs.status, 'ready'),
        ),
      );
    const file = job?.fileId ? await readFile(db, job.fileId) : undefined;
    if (!job || !file) {
      throw new AppError('NOT_FOUND', 'This download link has expired. Ask for a new one.');
    }
    await db
      .update(exportJobs)
      .set({ downloads: sql`${exportJobs.downloads} + 1` })
      .where(eq(exportJobs.id, job.id));
    await recordAudit(db, {
      action: 'export.downloaded',
      entityType: 'export',
      entityId: job.id,
      meta: { via: 'link' },
      req,
    });
    sendZip(res, job.filename, file.data);
  });

  router.use(requireAuth);

  router.get('/preview', async (req, res) => {
    requireExportRole(req);
    res.json(await preview(db, req, parseQuery(exportFiltersSchema, req)));
  });

  router.post('/', async (req, res) => {
    requireExportRole(req);
    const input = parseBody(createExportSchema, req);
    const p = await preview(db, req, input.filters);
    if (p.vouchers === 0) {
      throw new AppError('VALIDATION_FAILED', 'No vouchers match these filters');
    }
    if (p.tooMany) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${p.vouchers} vouchers match; an export holds up to ${EXPORT_MAX_VOUCHERS}. Narrow the dates or filters.`,
      );
    }
    const job = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(exportJobs)
        .values({
          requestedBy: req.auth!.userId,
          role: req.auth!.activeRole,
          filters: input.filters,
          includeProofs: input.includeProofs,
          filename: exportFilename(),
        })
        .returning();
      await recordAudit(tx, {
        action: 'export.requested',
        entityType: 'export',
        entityId: row!.id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        after: { filters: input.filters, includeProofs: input.includeProofs, vouchers: p.vouchers },
        req,
      });
      return row!;
    });
    exports.schedule(job.id);
    res.status(202).json(toJob(job));
  });

  /** The signed-in person's exports, newest first. */
  router.get('/', async (req, res) => {
    const page = parseQuery(paginationQuerySchema, req);
    const where = eq(exportJobs.requestedBy, req.auth!.userId);
    res.json(
      await paginate({
        query: page,
        sortable: { createdAt: exportJobs.createdAt },
        defaultSort: '-createdAt',
        tiebreaker: exportJobs.id,
        fetch: async ({ orderBy, limit, offset }) =>
          (
            await db
              .select()
              .from(exportJobs)
              .where(where)
              .orderBy(...orderBy)
              .limit(limit)
              .offset(offset)
          ).map(toJob),
        count: () => db.$count(exportJobs, where),
      }),
    );
  });

  /** Only the person who made an export can see or download it. */
  async function own(req: Request) {
    const { id } = parseParams(idParams, req);
    const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, id));
    if (!job || job.requestedBy !== req.auth!.userId) throw notFound('Export');
    return job;
  }

  router.get('/:id', async (req, res) => {
    res.json(toJob(await own(req)));
  });

  router.get('/:id/download', async (req, res) => {
    const job = await own(req);
    const file = job.status === 'ready' && job.fileId ? await readFile(db, job.fileId) : undefined;
    if (!file) {
      throw new AppError(
        'CONFLICT',
        job.status === 'expired' ? 'This export has expired' : 'This export is not ready',
      );
    }
    await db
      .update(exportJobs)
      .set({ downloads: sql`${exportJobs.downloads} + 1` })
      .where(eq(exportJobs.id, job.id));
    await recordAudit(db, {
      action: 'export.downloaded',
      entityType: 'export',
      entityId: job.id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.activeRole,
      req,
    });
    sendZip(res, job.filename, file.data);
  });

  /** Makes a link anyone can open for DOWNLOAD_LINK_HOURS. A new link replaces the old one. */
  router.post('/:id/link', async (req, res) => {
    const job = await own(req);
    if (job.status !== 'ready') throw new AppError('CONFLICT', 'This export is not ready');
    const token = newToken();
    const hours = Math.min(
      DOWNLOAD_LINK_HOURS,
      Math.max(0, ((job.expiresAt?.getTime() ?? 0) - Date.now()) / 3_600_000),
    );
    const expiresAt = new Date(Date.now() + hours * 3_600_000);
    await db.transaction(async (tx) => {
      await tx
        .update(exportJobs)
        .set({ linkTokenHash: hashToken(token), linkExpiresAt: expiresAt })
        .where(eq(exportJobs.id, job.id));
      await recordAudit(tx, {
        action: 'export.link_created',
        entityType: 'export',
        entityId: job.id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        after: { expiresAt: expiresAt.toISOString() },
        req,
      });
    });
    const link: DownloadLink = {
      url: `${config.PUBLIC_URL.replace(/\/$/, '')}/api/v1/exports/download/${token}`,
      expiresAt: expiresAt.toISOString(),
    };
    res.status(201).json(link);
  });

  return router;
}

/** GET /vouchers/:id/zip: one voucher's PDF and bills in a ZIP, for anyone who can open it. */
export function voucherZipRouter({ db }: Services) {
  const router = Router();
  router.get('/:id/zip', requireAuth, async (req, res) => {
    const { id } = parseParams(idParams, req);
    const [row] = await db.select().from(vouchers).where(eq(vouchers.id, id));
    if (!row || !canView(req.auth!, row)) throw notFound('Voucher');
    const v = (await getVoucherDetail(db, id, req.auth!))!;
    let zip;
    try {
      zip = await buildVoucherZip(db, req.auth!, [id], true);
    } catch (err) {
      if (err instanceof ExportTooLargeError) throw new AppError('CONFLICT', err.message);
      throw err;
    }
    await recordAudit(db, {
      action: 'voucher.zip_downloaded',
      entityType: 'voucher',
      entityId: id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.activeRole,
      meta: { files: zip.files },
      req,
    });
    sendZip(res, `${safeName(v.number ?? 'draft-voucher')}.zip`, zip.data);
  });
  return router;
}

// ---- Audit log ----

function auditWhere(q: AuditQuery): SQL | undefined {
  const where: SQL[] = [];
  const tz = sql.raw(`'${APP_TIME_ZONE}'`);
  if (q.from) where.push(sql`(${auditLog.at} at time zone ${tz})::date >= ${q.from}`);
  if (q.to) where.push(sql`(${auditLog.at} at time zone ${tz})::date <= ${q.to}`);
  if (q.actorId) where.push(eq(auditLog.actorId, q.actorId));
  if (q.entityType) where.push(eq(auditLog.entityType, q.entityType));
  if (q.entityId) where.push(eq(auditLog.entityId, q.entityId));
  if (q.action) {
    const term = q.action.replace(/[\\%_]/g, (c) => `\\${c}`);
    where.push(
      q.action.endsWith('.') ? like(auditLog.action, `${term}%`) : eq(auditLog.action, q.action),
    );
  }
  return where.length ? and(...where) : undefined;
}

/** Readable names: voucher and advance numbers, people's names, email subjects. */
async function labels(db: Db, rows: { entityType: string; entityId: string | null }[]) {
  const ids = (type: string) => [
    ...new Set(
      rows
        .filter((r) => r.entityType === type && r.entityId && /^[0-9a-f-]{36}$/.test(r.entityId))
        .map((r) => r.entityId!),
    ),
  ];
  const out = new Map<string, string>();
  const put = (type: string, list: { id: string; label: string | null }[]) => {
    for (const x of list) if (x.label) out.set(`${type}:${x.id}`, x.label);
  };
  const v = ids('voucher');
  if (v.length) {
    put(
      'voucher',
      await db
        .select({ id: vouchers.id, label: vouchers.number })
        .from(vouchers)
        .where(inArray(vouchers.id, v)),
    );
  }
  const a = ids('advance');
  if (a.length) {
    put(
      'advance',
      await db
        .select({ id: advances.id, label: advances.number })
        .from(advances)
        .where(inArray(advances.id, a)),
    );
  }
  const u = ids('user');
  if (u.length) {
    put(
      'user',
      await db.select({ id: users.id, label: users.name }).from(users).where(inArray(users.id, u)),
    );
  }
  const e = ids('email');
  if (e.length) {
    put(
      'email',
      await db
        .select({ id: emailOutbox.id, label: emailOutbox.subject })
        .from(emailOutbox)
        .where(inArray(emailOutbox.id, e)),
    );
  }
  const x = ids('export');
  if (x.length) {
    put(
      'export',
      await db
        .select({ id: exportJobs.id, label: exportJobs.filename })
        .from(exportJobs)
        .where(inArray(exportJobs.id, x)),
    );
  }
  return out;
}

async function auditEntries(
  db: Db,
  where: SQL | undefined,
  limit: number,
  offset: number,
  orderBy: SQL[],
) {
  const rows = await db
    .select({ e: auditLog, actorName: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);
  const names = await labels(
    db,
    rows.map((r) => r.e),
  );
  return rows.map(({ e, actorName }): AuditEntry => ({
    id: e.id,
    at: e.at.toISOString(),
    actor: e.actorId && actorName ? { id: e.actorId, name: actorName } : null,
    actorRole: e.actorRole,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    entityLabel: (e.entityId && names.get(`${e.entityType}:${e.entityId}`)) ?? null,
    before: e.before,
    after: e.after,
    meta: e.meta as Record<string, unknown> | null,
    requestId: e.requestId,
    ip: e.ip,
  }));
}

/** Most rows in one CSV download of the audit log. */
const AUDIT_CSV_MAX = 10_000;

/** /audit: read-only view of the append-only audit log, for Admins, Directors and Accounts. */
export function auditRouter({ db }: Services) {
  const router = Router();
  router.use(requireRole(...AUDIT_VIEWER_ROLES));

  router.get('/', async (req, res) => {
    const page = parseQuery(paginationQuerySchema, req);
    const where = auditWhere(parseQuery(auditQuerySchema, req));
    res.json(
      await paginate({
        query: page,
        sortable: { at: auditLog.at },
        defaultSort: '-at',
        tiebreaker: auditLog.id,
        fetch: ({ orderBy, limit, offset }) => auditEntries(db, where, limit, offset, orderBy),
        count: () => db.$count(auditLog, where),
      }),
    );
  });

  router.get('/facets', async (_req, res) => {
    const [types, actions, actors] = await Promise.all([
      db.selectDistinct({ v: auditLog.entityType }).from(auditLog).orderBy(auditLog.entityType),
      db.selectDistinct({ v: auditLog.action }).from(auditLog).orderBy(auditLog.action),
      db
        .selectDistinct({ id: users.id, name: users.name })
        .from(auditLog)
        .innerJoin(users, eq(users.id, auditLog.actorId))
        .orderBy(users.name),
    ]);
    const facets: AuditFacets = {
      entityTypes: types.map((t) => t.v),
      actions: actions.map((a) => a.v),
      actors,
    };
    res.json(facets);
  });

  /** The filtered log as CSV (newest first, up to 10,000 rows). Downloading it is itself logged. */
  router.get('/csv', async (req, res) => {
    const query = parseQuery(auditQuerySchema, req);
    const where = auditWhere(query);
    const entries = await auditEntries(db, where, AUDIT_CSV_MAX, 0, [
      desc(auditLog.at),
      desc(auditLog.id),
    ]);
    const json = (v: unknown) => (v === null || v === undefined ? '' : JSON.stringify(v));
    const csv = toCsv([
      [
        'Time',
        'Person',
        'Role',
        'Action',
        'Type',
        'Record',
        'Record id',
        'Before',
        'After',
        'Details',
        'IP',
        'Request id',
      ],
      ...entries.map((e) => [
        e.at,
        e.actor?.name ?? 'System',
        e.actorRole,
        e.action,
        e.entityType,
        e.entityLabel,
        e.entityId,
        json(e.before),
        json(e.after),
        json(e.meta),
        e.ip,
        e.requestId,
      ]),
    ]);
    await recordAudit(db, {
      action: 'audit.exported',
      entityType: 'audit',
      actorId: req.auth!.userId,
      actorRole: req.auth!.activeRole,
      meta: { filters: query, rows: entries.length },
      req,
    });
    res
      .status(200)
      .type('text/csv; charset=utf-8')
      .set({
        'Content-Disposition': contentDisposition(
          'attachment',
          `audit-log-${new Date().toISOString().slice(0, 10)}.csv`,
        ),
        'Cache-Control': 'private, no-store',
      })
      .end(csv);
  });

  return router;
}
