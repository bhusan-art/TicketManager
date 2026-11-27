import {
  REVIEW_STAGES,
  answerQuerySchema,
  approvalQueueQuerySchema,
  approveVoucherSchema,
  commentSchema,
  paginationQuerySchema,
  queryVoucherSchema,
  rejectVoucherSchema,
  returnVoucherSchema,
  type ApprovalQueueItem,
  type ApprovalStatus,
  type Issue,
  type ReviewStage,
  type VoucherAction,
  type VoucherEventType,
} from '@ticketmanager/shared';
import { and, eq, ilike, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import type { Tx } from '../db/client.js';
import { advances, departments, users, voucherLines, vouchers } from '../db/schema.js';
import { AppError, conflict, forbidden, notFound } from '../http/errors.js';
import { paginate } from '../http/pagination.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import type { Services } from '../services.js';
import { recordEvent } from './events.js';
import {
  getVoucherDetail,
  projectCondition,
  toVoucherSummary,
  voucherSummaryColumns,
} from './queries.js';
import { canView, isFinalApproval, nextStatus, permissions } from './workflow.js';

const idParams = z.object({ id: z.uuid() });

const PAST_TENSE: Record<'approve' | 'query' | 'return' | 'reject' | 'answer', VoucherEventType> = {
  approve: 'approved',
  query: 'queried',
  return: 'returned',
  reject: 'rejected',
  answer: 'answered',
};

/** Review steps on a voucher: approve, query, return, reject, answer a query, comment. */
export function voucherReviewRouter({ db }: Services) {
  const router = Router();
  router.use(requireAuth);

  /** Locks the voucher, checks the version and that the caller may take this step. */
  async function lockFor(
    tx: Tx,
    req: Request,
    id: string,
    action: VoucherAction,
    version?: number,
  ) {
    const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.id, id)).for('update');
    if (!voucher || !canView(req.auth!, voucher)) throw notFound('Voucher');
    if (version !== undefined && version !== voucher.version) {
      throw conflict('This voucher was changed somewhere else. Reload it and try again.', {
        currentVersion: voucher.version,
      });
    }
    if (!permissions(req.auth!, voucher)[action]) {
      if (voucher.employeeId === req.auth!.userId && action !== 'answer' && action !== 'comment') {
        throw forbidden('You cannot review your own claim');
      }
      throw conflict(
        action === 'answer'
          ? 'There is no open query on this voucher'
          : `You cannot ${action} this voucher now`,
      );
    }
    return voucher;
  }

  async function respond(req: Request, id: string) {
    return (await getVoucherDetail(db, id, req.auth!))!;
  }

  /** Accounts opening the voucher counts as starting review; after that it can't be cancelled. */
  const reviewStart = (req: Request, v: typeof vouchers.$inferSelect) =>
    req.auth!.activeRole === 'accounts' && !v.accountsReviewStartedAt ? new Date() : undefined;

  async function audit(
    tx: Tx,
    req: Request,
    id: string,
    action: string,
    before: unknown,
    after: unknown,
  ) {
    await recordAudit(tx, {
      action: `voucher.${action}`,
      entityType: 'voucher',
      entityId: id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.activeRole,
      before,
      after,
      req,
    });
  }

  /** Accounts marks the voucher as under review when they open it. Safe to call repeatedly. */
  router.post('/:id/start-review', async (req, res) => {
    const { id } = parseParams(idParams, req);
    await db.transaction(async (tx) => {
      const [v] = await tx.select().from(vouchers).where(eq(vouchers.id, id)).for('update');
      if (!v || !canView(req.auth!, v)) throw notFound('Voucher');
      if (!permissions(req.auth!, v).approve || v.approvalStatus !== 'pending_accounts') return;
      if (v.accountsReviewStartedAt) return;
      await tx
        .update(vouchers)
        .set({ accountsReviewStartedAt: new Date(), version: sql`${vouchers.version} + 1` })
        .where(eq(vouchers.id, id));
      await recordEvent(tx, {
        voucherId: id,
        type: 'review_started',
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
      });
    });
    res.json(await respond(req, id));
  });

  router.post('/:id/approve', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const input = parseBody(approveVoucherSchema, req);
    await db.transaction(async (tx) => {
      const v = await lockFor(tx, req, id, 'approve', input.version);
      const lines = await tx
        .select()
        .from(voucherLines)
        .where(eq(voucherLines.voucherId, id))
        .orderBy(voucherLines.position);
      const byId = new Map(input.lines.map((l) => [l.id, l]));
      const issues: Issue[] = input.lines.flatMap((l, i) =>
        lines.some((x) => x.id === l.id)
          ? []
          : [{ path: `lines.${i}.id`, message: 'This line is not on the voucher' }],
      );

      const decided = lines.map((line, i) => {
        const given = byId.get(line.id);
        const approvedPaise = given?.approvedPaise ?? line.approvedPaise ?? line.amountPaise;
        const reviewNote = given ? (given.note ?? null) : line.reviewNote;
        if (approvedPaise > line.amountPaise) {
          issues.push({
            path: `lines.${i}.approvedPaise`,
            message: 'You cannot approve more than was claimed',
          });
        } else if (approvedPaise < line.amountPaise && !reviewNote) {
          issues.push({
            path: `lines.${i}.note`,
            message: 'Say why you are approving less than claimed',
          });
        }
        return { line, approvedPaise, reviewNote };
      });
      if (issues.length)
        throw new AppError('VALIDATION_FAILED', 'Check the approved amounts', issues);

      const total = decided.reduce((s, d) => s + d.approvedPaise, 0);
      if (total === 0) {
        throw new AppError('VALIDATION_FAILED', 'Nothing is approved. Reject the voucher instead.');
      }
      const next = nextStatus(v.approvalStatus, 'approve', total < v.totalPaise);
      const final = isFinalApproval(next);

      for (const d of decided) {
        if (d.approvedPaise !== d.line.approvedPaise || d.reviewNote !== d.line.reviewNote) {
          await tx
            .update(voucherLines)
            .set({ approvedPaise: d.approvedPaise, reviewNote: d.reviewNote })
            .where(eq(voucherLines.id, d.line.id));
        }
      }
      if (final && v.advanceId) {
        // Lock the advance so it can't close while this claim joins its settlement.
        const [advance] = await tx
          .select({ status: advances.status, number: advances.number })
          .from(advances)
          .where(eq(advances.id, v.advanceId))
          .for('update');
        if (advance?.status !== 'open') {
          throw conflict(
            `Advance ${advance?.number ?? ''} is no longer open. Return the voucher so the employee can untag it.`,
          );
        }
      }
      const changes = {
        approvalStatus: next,
        approvedTotalPaise: total,
        ...(final && {
          decidedAt: new Date(),
          // A claim tagged to an advance is settled there, not paid on its own.
          paymentStatus: v.advanceId ? ('against_advance' as const) : ('payment_pending' as const),
        }),
        ...(reviewStart(req, v) && { accountsReviewStartedAt: reviewStart(req, v) }),
      };
      await tx
        .update(vouchers)
        .set({ ...changes, version: sql`${vouchers.version} + 1` })
        .where(eq(vouchers.id, id));
      const reduced = decided
        .filter((d) => d.approvedPaise < d.line.amountPaise)
        .map((d) => ({
          lineId: d.line.id,
          position: d.line.position,
          claimedPaise: d.line.amountPaise,
          approvedPaise: d.approvedPaise,
          note: d.reviewNote,
        }));
      await recordEvent(tx, {
        voucherId: id,
        type: 'approved',
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        fromStatus: v.approvalStatus,
        toStatus: next,
        message: input.note ?? null,
        meta: { approvedTotalPaise: total, reduced },
      });
      await audit(
        tx,
        req,
        id,
        'approved',
        { approvalStatus: v.approvalStatus },
        {
          ...changes,
          reduced,
        },
      );
    });
    res.json(await respond(req, id));
  });

  /** Query, return and reject all take a message and move the voucher on. */
  function messageStep(action: 'query' | 'return' | 'reject', schema: typeof queryVoucherSchema) {
    router.post(`/:id/${action}`, async (req, res) => {
      const { id } = parseParams(idParams, req);
      const { version, message } = parseBody(schema, req);
      await db.transaction(async (tx) => {
        const v = await lockFor(tx, req, id, action, version);
        const next = nextStatus(v.approvalStatus, action);
        const started = reviewStart(req, v);
        const changes = {
          approvalStatus: next,
          ...(action === 'reject' && { decidedAt: new Date() }),
          ...(started && { accountsReviewStartedAt: started }),
        };
        await tx
          .update(vouchers)
          .set({ ...changes, version: sql`${vouchers.version} + 1` })
          .where(eq(vouchers.id, id));
        await recordEvent(tx, {
          voucherId: id,
          type: PAST_TENSE[action],
          actorId: req.auth!.userId,
          actorRole: req.auth!.activeRole,
          fromStatus: v.approvalStatus,
          toStatus: next,
          message,
          // An Accounts query goes to the employee with their manager copied in.
          meta: action === 'query' && v.managerId ? { cc: v.managerId } : null,
        });
        await audit(
          tx,
          req,
          id,
          PAST_TENSE[action],
          { approvalStatus: v.approvalStatus },
          {
            ...changes,
            message,
          },
        );
      });
      res.json(await respond(req, id));
    });
  }
  messageStep('query', queryVoucherSchema);
  messageStep('return', returnVoucherSchema);
  messageStep('reject', rejectVoucherSchema);

  /** The employee answers a query; the voucher goes back to whoever asked. */
  router.post('/:id/answer', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const { version, message } = parseBody(answerQuerySchema, req);
    await db.transaction(async (tx) => {
      const v = await lockFor(tx, req, id, 'answer', version);
      const next = nextStatus(v.approvalStatus, 'answer');
      await tx
        .update(vouchers)
        .set({ approvalStatus: next, version: sql`${vouchers.version} + 1` })
        .where(eq(vouchers.id, id));
      await recordEvent(tx, {
        voucherId: id,
        type: 'answered',
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        fromStatus: v.approvalStatus,
        toStatus: next,
        message,
      });
      await audit(
        tx,
        req,
        id,
        'answered',
        { approvalStatus: v.approvalStatus },
        {
          approvalStatus: next,
          message,
        },
      );
    });
    res.json(await respond(req, id));
  });

  /** Comments don't change the voucher, so they need no version. */
  router.post('/:id/comments', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const { message } = parseBody(commentSchema, req);
    await db.transaction(async (tx) => {
      await lockFor(tx, req, id, 'comment');
      await recordEvent(tx, {
        voucherId: id,
        type: 'comment',
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        message,
      });
    });
    res.status(201).json(await respond(req, id));
  });

  return router;
}

const employees = alias(users, 'employee');

/** The approver's queues: what waits for me, what I queried, and what I already handled. */
export function approvalsRouter({ db }: Services) {
  const router = Router();
  router.use(requireRole('manager', 'accounts', 'director'));

  function stageFor(req: Request): ReviewStage {
    const role = req.auth!.activeRole;
    return role === 'manager'
      ? 'pending_manager'
      : role === 'accounts'
        ? 'pending_accounts'
        : 'pending_director';
  }

  /** Vouchers this approver may act on at their stage, never their own. */
  function scope(req: Request, status: ApprovalStatus): SQL {
    const me = req.auth!.userId;
    const base = and(eq(vouchers.approvalStatus, status), ne(vouchers.employeeId, me))!;
    return req.auth!.activeRole === 'manager' ? and(base, eq(vouchers.managerId, me))! : base;
  }

  function condition(req: Request, view: 'pending' | 'queried' | 'done'): SQL {
    const stage = stageFor(req);
    if (view === 'pending') return scope(req, stage);
    if (view === 'queried') return scope(req, REVIEW_STAGES[stage].query);
    return sql`exists (select 1 from voucher_events e where e.voucher_id = "vouchers"."id"
      and e.actor_id = ${req.auth!.userId} and e.actor_role = ${req.auth!.activeRole}
      and e.type in ('approved', 'returned', 'rejected', 'queried'))`;
  }

  router.get('/', async (req, res) => {
    const page = parseQuery(paginationQuerySchema, req);
    const { view, search, projectId } = parseQuery(approvalQueueQuerySchema, req);
    const where: SQL[] = [condition(req, view)];
    if (projectId) where.push(projectCondition(projectId));
    if (search) {
      const term = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        or(
          ilike(vouchers.number, term),
          ilike(vouchers.purpose, term),
          ilike(employees.name, term),
          ilike(employees.employeeCode, term),
        )!,
      );
    }
    const filter = and(...where);
    const result = await paginate({
      query: page,
      sortable: {
        submittedAt: vouchers.submittedAt,
        updatedAt: vouchers.updatedAt,
        totalPaise: vouchers.totalPaise,
        number: vouchers.number,
      },
      // Oldest first while waiting; most recent first once handled.
      defaultSort: view === 'done' ? '-updatedAt' : 'submittedAt',
      tiebreaker: vouchers.id,
      fetch: ({ orderBy, limit, offset }) =>
        db
          .select({
            ...voucherSummaryColumns,
            employeeId: employees.id,
            employeeName: employees.name,
            employeeCode: employees.employeeCode,
            departmentId: departments.id,
            departmentName: departments.name,
            accountsReviewStartedAt: vouchers.accountsReviewStartedAt,
          })
          .from(vouchers)
          .innerJoin(employees, eq(employees.id, vouchers.employeeId))
          .leftJoin(departments, eq(departments.id, vouchers.departmentId))
          .where(filter)
          .orderBy(...orderBy)
          .limit(limit)
          .offset(offset),
      count: async () => {
        const [row] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(vouchers)
          .innerJoin(employees, eq(employees.id, vouchers.employeeId))
          .where(filter);
        return row!.n;
      },
    });
    const data: ApprovalQueueItem[] = result.data.map((r) => {
      const {
        employeeId,
        employeeName,
        employeeCode,
        departmentId,
        departmentName,
        accountsReviewStartedAt,
        ...summary
      } = r;
      return {
        ...toVoucherSummary(summary),
        employee: { id: employeeId, name: employeeName, employeeCode },
        department:
          departmentId && departmentName ? { id: departmentId, name: departmentName } : null,
        reviewStarted: Boolean(accountsReviewStartedAt),
      };
    });
    res.json({ data, meta: result.meta });
  });

  router.get('/counts', async (req, res) => {
    const [pending, queried] = await Promise.all([
      db.$count(vouchers, condition(req, 'pending')),
      db.$count(vouchers, condition(req, 'queried')),
    ]);
    res.json({ pending, queried });
  });

  return router;
}
