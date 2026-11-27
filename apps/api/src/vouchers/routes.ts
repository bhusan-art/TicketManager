import {
  ATTACHMENT_TYPES,
  CONTRACTUAL_NEEDS_MANAGER,
  type EmploymentType,
  MAX_ATTACHMENTS_PER_LINE,
  VOUCHER_STATUS_GROUPS,
  cancelVoucherSchema,
  createVoucherInputSchema,
  createVoucherSchema,
  listVouchersQuerySchema,
  paginationQuerySchema,
  updateVoucherSchema,
  voucherActionSchema,
  voucherSubmitIssues,
  voucherTotal,
  type ApprovalStatus,
  type Issue,
} from '@ticketmanager/shared';
import { and, count, eq, ilike, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { requireAuth } from '../auth/middleware.js';
import type { Tx } from '../db/client.js';
import {
  advances,
  categories,
  departments,
  projects,
  users,
  voucherAttachments,
  voucherLines,
  vouchers,
} from '../db/schema.js';
import { AppError, conflict, forbidden, notFound } from '../http/errors.js';
import { paginate } from '../http/pagination.js';
import {
  cleanFilename,
  contentDisposition,
  singleFileUpload,
  sniffContentType,
} from '../http/upload.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import type { Services } from '../services.js';
import { readFile, saveFile } from '../storage/files.js';
import { nextDocumentNumber } from './numbering.js';
import { renderVoucherPdf } from './pdf.js';
import { recordEvent } from './events.js';
import {
  getVoucherDetail,
  getVoucherLines,
  selectVoucherSummaries,
  toVoucherSummary,
} from './queries.js';
import { canView, permissions } from './workflow.js';

const idParams = z.object({ id: z.uuid() });
const lineParams = idParams.extend({ lineId: z.uuid() });
const attachmentParams = idParams.extend({ attachmentId: z.uuid() });
const downloadQuery = z.object({ download: z.enum(['0', '1']).optional() });

type LineInput = z.infer<typeof createVoucherSchema>['lines'][number];

const invalid = (message: string, issues: Issue[]) =>
  new AppError('VALIDATION_FAILED', message, issues);

/**
 * Where a newly submitted (or resubmitted) voucher or advance goes first, from the claimant's
 * roles (requirements review). A regular employee with no reporting manager goes straight to
 * Accounts; a contractual one must have a manager.
 */
export function firstStage(user: {
  roles: string[];
  managerId: string | null;
  employmentType: EmploymentType;
}): Extract<ApprovalStatus, 'pending_manager' | 'pending_accounts' | 'pending_director'> {
  // An Accounts user's own claim is checked by the Director, never by their own team.
  if (user.roles.includes('accounts')) return 'pending_director';
  // Managers' and directors' own claims go straight to Accounts.
  if (user.roles.includes('manager') || user.roles.includes('director')) return 'pending_accounts';
  if (user.managerId) return 'pending_manager';
  if (user.employmentType === 'contractual') {
    throw new AppError(
      'VALIDATION_FAILED',
      `${CONTRACTUAL_NEEDS_MANAGER}. Ask an admin to set yours before you submit.`,
      [{ path: 'manager', message: 'No reporting manager' }],
    );
  }
  return 'pending_accounts';
}

/**
 * A voucher can be tagged only to one of the employee's own advances that has been paid out and
 * is not yet settled.
 */
async function assertAdvance(tx: Tx, advanceId: string | null | undefined, employeeId: string) {
  if (!advanceId) return;
  const [a] = await tx
    .select({ employeeId: advances.employeeId, status: advances.status })
    .from(advances)
    .where(eq(advances.id, advanceId));
  if (!a || a.employeeId !== employeeId) {
    throw invalid('Choose one of your own advances', [
      { path: 'advanceId', message: 'This advance is not yours' },
    ]);
  }
  if (a.status !== 'open') {
    throw invalid('This advance is not open', [
      {
        path: 'advanceId',
        message:
          a.status === 'closed'
            ? 'This advance is already settled. Choose another, or none.'
            : 'This advance has not been paid out yet',
      },
    ]);
  }
}

/** A voucher can be booked only to an active project (one it already has may stay). */
async function assertProject(
  tx: Tx,
  projectId: string | null | undefined,
  current?: string | null,
) {
  if (!projectId || projectId === current) return;
  const [p] = await tx
    .select({ status: projects.status })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!p || p.status !== 'active') {
    throw invalid('Choose another project', [
      { path: 'projectId', message: p ? 'This project is closed' : 'Project not found' },
    ]);
  }
}

/** Employee expense vouchers: drafts, lines, proofs, submit, cancel and the voucher PDF. */
export function vouchersRouter({ db }: Services) {
  const router = Router();
  router.use(requireAuth);

  /** Locks the voucher for the rest of the transaction. 404 unless the caller may see it. */
  async function lockOwn(tx: Tx, req: Request, id: string, version?: number) {
    const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.id, id)).for('update');
    if (!voucher || !canView(req.auth!, voucher)) throw notFound('Voucher');
    if (version !== undefined && version !== voucher.version) {
      throw conflict('This voucher was changed somewhere else. Reload it and try again.', {
        currentVersion: voucher.version,
      });
    }
    return { voucher, can: permissions(req.auth!, voucher) };
  }

  const notEditable = () =>
    conflict(
      'This voucher can no longer be edited. Only drafts and returned vouchers can be changed.',
    );

  /** Category ids must exist. A line may keep an inactive category it already had. */
  async function assertCategories(tx: Tx, lines: LineInput[], keep: Set<string>) {
    const ids = [...new Set(lines.map((l) => l.categoryId).filter((id): id is string => !!id))];
    if (ids.length === 0) return;
    const rows = await tx
      .select({ id: categories.id, status: categories.status })
      .from(categories)
      .where(inArray(categories.id, ids));
    const usable = new Set(
      rows.filter((r) => r.status === 'active' || keep.has(r.id)).map((r) => r.id),
    );
    const issues = lines.flatMap((l, i) =>
      l.categoryId && !usable.has(l.categoryId)
        ? [{ path: `lines.${i}.categoryId`, message: 'This category is not available' }]
        : [],
    );
    if (issues.length) throw invalid('Some categories are not available', issues);
  }

  const lineValues = (line: LineInput, position: number) => ({
    position,
    categoryId: line.categoryId ?? null,
    expenseDate: line.expenseDate ?? null,
    description: line.description ?? null,
    vendorName: line.vendorName ?? null,
    amountPaise: line.amountPaise,
    isGst: line.isGst,
    // GST details only mean something on a GST line.
    gstin: line.isGst ? (line.gstin ?? null) : null,
    invoiceNumber: line.invoiceNumber ?? null,
    cgstPaise: line.isGst ? line.cgstPaise : 0,
    sgstPaise: line.isGst ? line.sgstPaise : 0,
    igstPaise: line.isGst ? line.igstPaise : 0,
    missingProofReason: line.missingProofReason ?? null,
  });

  async function detail(req: Request, id: string) {
    const [row] = await db.select().from(vouchers).where(eq(vouchers.id, id));
    if (!row || !canView(req.auth!, row)) throw notFound('Voucher');
    return (await getVoucherDetail(db, id, req.auth!))!;
  }

  // ---- List and read ----

  router.get('/', async (req, res) => {
    const page = parseQuery(paginationQuerySchema, req);
    const filters = parseQuery(listVouchersQuerySchema, req);
    // Accounts can list the paper claims they typed in for others instead of their own.
    if (filters.entered && req.auth!.activeRole !== 'accounts') {
      throw forbidden('Switch to the Accounts role to see paper claims');
    }
    const where: SQL[] = [
      filters.entered
        ? eq(vouchers.enteredById, req.auth!.userId)
        : eq(vouchers.employeeId, req.auth!.userId),
    ];
    if (filters.status) {
      where.push(inArray(vouchers.approvalStatus, [...VOUCHER_STATUS_GROUPS[filters.status]]));
    }
    if (filters.search) {
      const term = `%${filters.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(or(ilike(vouchers.number, term), ilike(vouchers.purpose, term))!);
    }
    const condition = and(...where);
    const result = await paginate({
      query: page,
      sortable: {
        createdAt: vouchers.createdAt,
        updatedAt: vouchers.updatedAt,
        submittedAt: vouchers.submittedAt,
        number: vouchers.number,
        totalPaise: vouchers.totalPaise,
      },
      defaultSort: '-createdAt',
      tiebreaker: vouchers.id,
      fetch: ({ orderBy, limit, offset }) =>
        selectVoucherSummaries(db)
          .where(condition)
          .orderBy(...orderBy)
          .limit(limit)
          .offset(offset),
      count: () => db.$count(vouchers, condition),
    });
    res.json({ data: result.data.map(toVoucherSummary), meta: result.meta });
  });

  /** Counts per My Expenses tab. */
  router.get('/counts', async (req, res) => {
    const rows = await db
      .select({ status: vouchers.approvalStatus, n: count() })
      .from(vouchers)
      .where(eq(vouchers.employeeId, req.auth!.userId))
      .groupBy(vouchers.approvalStatus);
    const counts: Record<string, number> = { all: 0 };
    for (const [group, statuses] of Object.entries(VOUCHER_STATUS_GROUPS)) {
      counts[group] = rows
        .filter((r) => (statuses as readonly string[]).includes(r.status))
        .reduce((sum, r) => sum + r.n, 0);
    }
    counts.all = rows.reduce((sum, r) => sum + r.n, 0);
    res.json(counts);
  });

  /** Accounts: people to type a paper claim in for (active, not themselves). */
  router.get('/claimants', async (req, res) => {
    if (req.auth!.activeRole !== 'accounts') {
      throw forbidden('Switch to the Accounts role to enter paper claims');
    }
    const { search } = parseQuery(z.object({ search: z.string().trim().max(100).optional() }), req);
    const where: (SQL | undefined)[] = [
      eq(users.status, 'active'),
      sql`${users.id} <> ${req.auth!.userId}`,
    ];
    if (search) {
      const term = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        or(ilike(users.name, term), ilike(users.employeeCode, term), ilike(users.email, term)),
      );
    }
    const data = await db
      .select({
        id: users.id,
        name: users.name,
        employeeCode: users.employeeCode,
        department: departments.name,
      })
      .from(users)
      .leftJoin(departments, eq(departments.id, users.departmentId))
      .where(and(...where))
      .orderBy(users.name)
      .limit(20);
    res.json({ data });
  });

  router.get('/:id', async (req, res) => {
    const { id } = parseParams(idParams, req);
    res.json(await detail(req, id));
  });

  // ---- Drafts ----

  router.post('/', async (req, res) => {
    const { employeeId: forId, ...input } = parseBody(createVoucherInputSchema, req);
    const paper = !!forId && forId !== req.auth!.userId;
    if (paper) {
      if (req.auth!.activeRole !== 'accounts') {
        throw forbidden('Only Accounts can enter a claim for someone else');
      }
      const [who] = await db
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, forId));
      if (!who || who.status !== 'active') {
        throw invalid('Choose an active employee', [
          { path: 'employeeId', message: 'This person is not an active user' },
        ]);
      }
    }
    const employeeId = paper ? forId : req.auth!.userId;
    const id = await db.transaction(async (tx) => {
      await assertCategories(tx, input.lines, new Set());
      await assertAdvance(tx, input.advanceId, employeeId);
      await assertProject(tx, input.projectId);
      const [voucher] = await tx
        .insert(vouchers)
        .values({
          employeeId,
          enteredById: paper ? req.auth!.userId : null,
          advanceId: input.advanceId ?? null,
          projectId: input.projectId ?? null,
          purpose: input.purpose ?? null,
          totalPaise: voucherTotal(input.lines),
        })
        .returning({ id: vouchers.id });
      if (input.lines.length) {
        await tx
          .insert(voucherLines)
          .values(input.lines.map((l, i) => ({ voucherId: voucher!.id, ...lineValues(l, i) })));
      }
      await recordAudit(tx, {
        action: 'voucher.created',
        entityType: 'voucher',
        entityId: voucher!.id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        after: {
          purpose: input.purpose ?? null,
          lines: input.lines.length,
          ...(paper ? { paperClaimFor: employeeId } : {}),
        },
        req,
      });
      await recordEvent(tx, {
        voucherId: voucher!.id,
        type: 'created',
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        toStatus: 'draft',
      });
      return voucher!.id;
    });
    res.status(201).json(await detail(req, id));
  });

  /** Replaces the purpose and lines. Lines with an id are kept (with their proofs). */
  router.patch('/:id', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const input = parseBody(updateVoucherSchema, req);
    await db.transaction(async (tx) => {
      const { voucher, can } = await lockOwn(tx, req, id, input.version);
      if (!can.edit) throw notEditable();

      const existing = await tx
        .select({ id: voucherLines.id, categoryId: voucherLines.categoryId })
        .from(voucherLines)
        .where(eq(voucherLines.voucherId, id));
      const existingIds = new Set(existing.map((l) => l.id));
      const unknown = input.lines.flatMap((l, i) =>
        l.id && !existingIds.has(l.id)
          ? [{ path: `lines.${i}.id`, message: 'This line is not on the voucher' }]
          : [],
      );
      const ids = input.lines.map((l) => l.id).filter(Boolean);
      if (new Set(ids).size !== ids.length) {
        unknown.push({ path: 'lines', message: 'A line appears twice' });
      }
      if (unknown.length) throw invalid('Some lines are not on this voucher', unknown);
      await assertCategories(
        tx,
        input.lines,
        new Set(existing.map((l) => l.categoryId).filter((c): c is string => !!c)),
      );
      if (input.advanceId && input.advanceId !== voucher.advanceId) {
        await assertAdvance(tx, input.advanceId, voucher.employeeId);
      }
      await assertProject(tx, input.projectId, voucher.projectId);

      const keep = input.lines.map((l) => l.id).filter((x): x is string => !!x);
      // Removing a line removes its proofs too (the database cascades and deletes the files).
      await tx
        .delete(voucherLines)
        .where(
          keep.length
            ? and(eq(voucherLines.voucherId, id), notInArray(voucherLines.id, keep))
            : eq(voucherLines.voucherId, id),
        );
      for (const [i, line] of input.lines.entries()) {
        if (line.id) {
          await tx
            .update(voucherLines)
            .set(lineValues(line, i))
            .where(eq(voucherLines.id, line.id));
        } else {
          await tx.insert(voucherLines).values({ voucherId: id, ...lineValues(line, i) });
        }
      }
      const total = voucherTotal(input.lines);
      await tx
        .update(vouchers)
        .set({
          advanceId: input.advanceId ?? null,
          projectId: input.projectId ?? null,
          purpose: input.purpose ?? null,
          totalPaise: total,
          version: sql`${vouchers.version} + 1`,
        })
        .where(eq(vouchers.id, id));
      await recordAudit(tx, {
        action: 'voucher.updated',
        entityType: 'voucher',
        entityId: id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        before: { purpose: voucher.purpose, totalPaise: voucher.totalPaise },
        after: { purpose: input.purpose ?? null, totalPaise: total, lines: input.lines.length },
        req,
      });
    });
    res.json(await detail(req, id));
  });

  /** Deletes a draft that was never submitted. */
  router.delete('/:id', async (req, res) => {
    const { id } = parseParams(idParams, req);
    await db.transaction(async (tx) => {
      const { voucher, can } = await lockOwn(tx, req, id);
      if (!can.delete) throw conflict('Only drafts that were never submitted can be deleted');
      await tx.delete(vouchers).where(eq(vouchers.id, id));
      await recordAudit(tx, {
        action: 'voucher.deleted',
        entityType: 'voucher',
        entityId: id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        before: { purpose: voucher.purpose, totalPaise: voucher.totalPaise },
        req,
      });
    });
    res.status(204).end();
  });

  // ---- Submit and cancel ----

  router.post('/:id/submit', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const { version } = parseBody(voucherActionSchema, req);
    await db.transaction(async (tx) => {
      const { voucher, can } = await lockOwn(tx, req, id, version);
      if (!can.submit) throw conflict('This voucher has already been submitted');
      const resubmission = voucher.approvalStatus === 'returned';

      const lines = await getVoucherLines(tx, id);
      const issues = voucherSubmitIssues({
        purpose: voucher.purpose,
        lines: lines.map((l) => ({
          ...l,
          categoryId: l.category?.id ?? null,
          attachmentCount: l.attachments.length,
        })),
      });
      const categoryIds = lines.map((l) => l.category?.id).filter((c): c is string => !!c);
      if (categoryIds.length) {
        const inactive = new Set(
          (
            await tx
              .select({ id: categories.id })
              .from(categories)
              .where(and(inArray(categories.id, categoryIds), eq(categories.status, 'inactive')))
          ).map((c) => c.id),
        );
        lines.forEach((l, i) => {
          if (l.category && inactive.has(l.category.id)) {
            issues.push({
              path: `lines.${i}.categoryId`,
              message: `"${l.category.name}" is no longer in use. Choose another category.`,
            });
          }
        });
      }
      if (voucher.projectId) {
        const [p] = await tx
          .select({ name: projects.name, status: projects.status })
          .from(projects)
          .where(eq(projects.id, voucher.projectId));
        if (p?.status !== 'active') {
          issues.push({
            path: 'projectId',
            message: `"${p?.name ?? 'The project'}" is closed. Choose another project.`,
          });
        }
      }
      if (issues.length) throw invalid('Fix these before submitting', issues);
      // The advance may have been settled since the voucher was tagged.
      await assertAdvance(tx, voucher.advanceId, voucher.employeeId);

      const [claimant] = await tx
        .select({
          roles: users.roles,
          managerId: users.managerId,
          employmentType: users.employmentType,
          departmentId: users.departmentId,
        })
        .from(users)
        .where(eq(users.id, voucher.employeeId));
      const status = firstStage(claimant!);
      const number = voucher.number ?? (await nextDocumentNumber(tx, 'EXP'));
      const changes = {
        number,
        approvalStatus: status,
        departmentId: claimant!.departmentId,
        managerId: status === 'pending_manager' ? claimant!.managerId : null,
        submittedAt: new Date(),
        // A resubmission is reviewed afresh from the first stage.
        approvedTotalPaise: null,
      };
      await tx
        .update(vouchers)
        .set({ ...changes, version: sql`${vouchers.version} + 1` })
        .where(eq(vouchers.id, id));
      if (resubmission) {
        await tx
          .update(voucherLines)
          .set({ approvedPaise: null, reviewNote: null })
          .where(eq(voucherLines.voucherId, id));
      }
      await recordEvent(tx, {
        voucherId: id,
        type: resubmission ? 'resubmitted' : 'submitted',
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        fromStatus: voucher.approvalStatus,
        toStatus: status,
        meta: { totalPaise: voucher.totalPaise },
      });
      await recordAudit(tx, {
        action: resubmission ? 'voucher.resubmitted' : 'voucher.submitted',
        entityType: 'voucher',
        entityId: id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        before: { approvalStatus: voucher.approvalStatus },
        after: { ...changes, totalPaise: voucher.totalPaise },
        req,
      });
    });
    res.json(await detail(req, id));
  });

  router.post('/:id/cancel', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const { version, reason } = parseBody(cancelVoucherSchema, req);
    await db.transaction(async (tx) => {
      const { voucher, can } = await lockOwn(tx, req, id, version);
      if (!can.cancel) {
        throw conflict(
          voucher.approvalStatus === 'draft'
            ? 'Drafts are deleted, not cancelled'
            : 'This voucher can no longer be cancelled',
        );
      }
      const changes = {
        approvalStatus: 'cancelled' as const,
        cancelledAt: new Date(),
        cancelReason: reason,
      };
      await tx
        .update(vouchers)
        .set({ ...changes, version: sql`${vouchers.version} + 1` })
        .where(eq(vouchers.id, id));
      await recordAudit(tx, {
        action: 'voucher.cancelled',
        entityType: 'voucher',
        entityId: id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        before: { approvalStatus: voucher.approvalStatus },
        after: changes,
        req,
      });
      await recordEvent(tx, {
        voucherId: id,
        type: 'cancelled',
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        fromStatus: voucher.approvalStatus,
        toStatus: 'cancelled',
        message: reason,
      });
    });
    res.json(await detail(req, id));
  });

  // ---- Proofs ----

  router.post('/:id/lines/:lineId/attachments', singleFileUpload('file'), async (req, res) => {
    const { id, lineId } = parseParams(lineParams, req);
    const upload = req.file!;
    const contentType = sniffContentType(upload.buffer);
    if (!contentType || !(contentType in ATTACHMENT_TYPES)) {
      const message = 'Upload a PDF, JPG, PNG or WEBP file';
      throw invalid(message, [{ path: 'file', message }]);
    }
    const attachmentId = await db.transaction(async (tx) => {
      const { voucher, can } = await lockOwn(tx, req, id);
      // While answering a query the employee may add bills, but not remove or change anything.
      if (!can.edit && !can.answer) throw notEditable();
      const [line] = await tx
        .select({ id: voucherLines.id })
        .from(voucherLines)
        .where(and(eq(voucherLines.id, lineId), eq(voucherLines.voucherId, id)));
      if (!line) throw notFound('Line');
      const existing = await tx.$count(voucherAttachments, eq(voucherAttachments.lineId, lineId));
      if (existing >= MAX_ATTACHMENTS_PER_LINE) {
        throw conflict(`A line can have at most ${MAX_ATTACHMENTS_PER_LINE} files`);
      }
      const file = await saveFile(tx, {
        filename: cleanFilename(upload.originalname),
        contentType,
        data: upload.buffer,
        uploadedBy: req.auth!.userId,
      });
      const [attachment] = await tx
        .insert(voucherAttachments)
        .values({ voucherId: id, lineId, fileId: file.id })
        .returning({ id: voucherAttachments.id });
      await tx
        .update(vouchers)
        .set({ version: sql`${vouchers.version} + 1` })
        .where(eq(vouchers.id, id));
      await recordAudit(tx, {
        action: 'voucher.attachment_added',
        entityType: 'voucher',
        entityId: id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        after: { lineId, filename: file.filename, sizeBytes: file.sizeBytes, sha256: file.sha256 },
        req,
      });
      // Drafts change freely; once submitted, every added bill shows on the timeline.
      if (voucher.submittedAt) {
        await recordEvent(tx, {
          voucherId: id,
          type: 'attachment_added',
          actorId: req.auth!.userId,
          actorRole: req.auth!.activeRole,
          message: file.filename,
          meta: { lineId, attachmentId: attachment!.id },
        });
      }
      return attachment!.id;
    });
    const detailed = await detail(req, id);
    const attachment = detailed.lines
      .flatMap((l) => l.attachments)
      .find((a) => a.id === attachmentId);
    res.status(201).json({ attachment, version: detailed.version });
  });

  async function findAttachment(voucherId: string, attachmentId: string) {
    const [row] = await db
      .select({
        id: voucherAttachments.id,
        fileId: voucherAttachments.fileId,
        lineId: voucherAttachments.lineId,
      })
      .from(voucherAttachments)
      .where(
        and(eq(voucherAttachments.id, attachmentId), eq(voucherAttachments.voucherId, voucherId)),
      );
    if (!row) throw notFound('Attachment');
    return row;
  }

  router.get('/:id/attachments/:attachmentId', async (req, res) => {
    const { id, attachmentId } = parseParams(attachmentParams, req);
    const { download } = parseQuery(downloadQuery, req);
    const [voucher] = await db.select().from(vouchers).where(eq(vouchers.id, id));
    if (!voucher || !canView(req.auth!, voucher)) throw notFound('Voucher');
    const attachment = await findAttachment(id, attachmentId);
    const file = await readFile(db, attachment.fileId);
    if (!file) throw notFound('Attachment');
    res
      .status(200)
      .type(file.contentType)
      .set({
        'Content-Disposition': contentDisposition(
          download === '1' ? 'attachment' : 'inline',
          file.filename,
        ),
        'Content-Length': String(file.sizeBytes),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        // An uploaded file must never run as a page on our origin.
        'Content-Security-Policy':
          "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      })
      .end(file.data);
  });

  router.delete('/:id/attachments/:attachmentId', async (req, res) => {
    const { id, attachmentId } = parseParams(attachmentParams, req);
    const version = await db.transaction(async (tx) => {
      const { can } = await lockOwn(tx, req, id);
      if (!can.edit) throw notEditable();
      const attachment = await findAttachment(id, attachmentId);
      await tx.delete(voucherAttachments).where(eq(voucherAttachments.id, attachment.id));
      const [updated] = await tx
        .update(vouchers)
        .set({ version: sql`${vouchers.version} + 1` })
        .where(eq(vouchers.id, id))
        .returning({ version: vouchers.version });
      await recordAudit(tx, {
        action: 'voucher.attachment_removed',
        entityType: 'voucher',
        entityId: id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        before: { attachmentId, lineId: attachment.lineId },
        req,
      });
      return updated!.version;
    });
    res.json({ version });
  });

  // ---- PDF ----

  router.get('/:id/pdf', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const voucher = await detail(req, id);
    const pdf = await renderVoucherPdf(voucher);
    const name = `${voucher.number ?? 'draft-voucher'}.pdf`;
    res
      .status(200)
      .type('application/pdf')
      .set({
        'Content-Disposition': contentDisposition('attachment', name),
        'Cache-Control': 'private, no-store',
      })
      .end(pdf);
  });

  return router;
}
