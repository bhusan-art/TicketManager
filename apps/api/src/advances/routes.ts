import {
  ACTIVE_ADVANCE_STATUSES,
  ADVANCE_TRANSACTION_LABELS,
  PAYMENT_MODE_LABELS,
  advanceActionSchema,
  advanceInputSchema,
  advanceListQuerySchema,
  advanceSettingsSchema,
  approveAdvanceSchema,
  cancelAdvanceSchema,
  closeAdvanceSchema,
  disburseAdvanceSchema,
  formatRupees,
  paginationQuerySchema,
  rejectAdvanceSchema,
  returnAdvanceSchema,
  reverseAdvanceTransactionSchema,
  settleByDate,
  settlementTransactionSchema,
  todayIso,
  type AdvanceSettings,
  type AdvanceStatus,
  type AdvanceSummary,
  type LinkableAdvance,
} from '@ticketmanager/shared';
import { and, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { pgErrorCode, type DbOrTx, type Tx } from '../db/client.js';
import { advanceTransactions, advances, departments, settings, users } from '../db/schema.js';
import { AppError, conflict, forbidden, notFound } from '../http/errors.js';
import { paginate } from '../http/pagination.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import type { Services } from '../services.js';
import { firstStage } from '../vouchers/routes.js';
import { nextDocumentNumber } from '../vouchers/numbering.js';
import {
  getAdvanceDetail,
  getSettlement,
  isOverdue,
  recordAdvanceEvent,
  type NewAdvanceEvent,
} from './queries.js';
import { advancePermissions, canViewAdvance, nextAdvanceStatus } from './workflow.js';

const idParams = z.object({ id: z.uuid() });
const txParams = idParams.extend({ txId: z.uuid() });

const field = (path: string, message: string) =>
  new AppError('VALIDATION_FAILED', message, [{ path, message }]);

const ADVANCE_SETTINGS_KEY = 'advances';

export async function getAdvanceSettings(db: DbOrTx): Promise<AdvanceSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, ADVANCE_SETTINGS_KEY));
  const parsed = advanceSettingsSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : { maxAdvancePaise: null };
}

/** Requests, approvals, payout, settlement and closing of advances. */
export function advancesRouter({ db }: Services) {
  const router = Router();
  router.use(requireAuth);

  /** Locks the advance for the transaction. 404 unless the caller may see it; 409 on a stale version. */
  async function lock(tx: Tx, req: Request, id: string, version?: number) {
    const [a] = await tx.select().from(advances).where(eq(advances.id, id)).for('update');
    if (!a || !canViewAdvance(req.auth!, a)) throw notFound('Advance');
    if (version !== undefined && a.version !== version) {
      throw conflict('This advance was changed somewhere else. Reload it and try again.', {
        currentVersion: a.version,
      });
    }
    return a;
  }

  async function bump(tx: Tx, id: string, changes: Partial<typeof advances.$inferInsert>) {
    await tx
      .update(advances)
      .set({ ...changes, version: sql`${advances.version} + 1` })
      .where(eq(advances.id, id));
  }

  function event(req: Request, e: Omit<NewAdvanceEvent, 'actorId' | 'actorRole'>): NewAdvanceEvent {
    return { ...e, actorId: req.auth!.userId, actorRole: req.auth!.activeRole };
  }

  function audit(
    req: Request,
    action: string,
    id: string,
    before: unknown,
    after: unknown,
  ): Parameters<typeof recordAudit>[1] {
    return {
      action,
      entityType: 'advance',
      entityId: id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.activeRole,
      before,
      after,
      req,
    };
  }

  const detail = async (req: Request, id: string) => (await getAdvanceDetail(db, id, req.auth!))!;

  // ---- Lists ----

  const employees = alias(users, 'employee');

  /** What each view shows, and who may ask for it. */
  function viewFilter(req: Request, view: z.infer<typeof advanceListQuerySchema>['view']): SQL {
    const { userId, activeRole } = req.auth!;
    if (view === 'mine') return eq(advances.employeeId, userId);
    const notMine = ne(advances.employeeId, userId);
    if (activeRole === 'manager') {
      const team = and(eq(advances.managerId, userId), notMine)!;
      if (view === 'review') return and(team, eq(advances.status, 'pending_manager'))!;
      if (view === 'all') return and(team, ne(advances.status, 'draft'))!;
      throw forbidden('Switch to the accounts role to see this list');
    }
    if (activeRole !== 'accounts' && activeRole !== 'director') {
      throw forbidden('Switch to an approver role to see this list');
    }
    const submitted = and(notMine, ne(advances.status, 'draft'))!;
    switch (view) {
      case 'review':
        return and(
          notMine,
          eq(advances.status, activeRole === 'accounts' ? 'pending_accounts' : 'pending_director'),
        )!;
      case 'disburse':
        return and(notMine, eq(advances.status, 'approved'))!;
      case 'open':
        return and(notMine, eq(advances.status, 'open'))!;
      case 'closed':
        return and(notMine, eq(advances.status, 'closed'))!;
      default:
        return submitted;
    }
  }

  router.get('/', async (req, res) => {
    const page = parseQuery(paginationQuerySchema, req);
    const { view, search, overdue } = parseQuery(advanceListQuerySchema, req);
    const where: SQL[] = [viewFilter(req, view)];
    if (overdue) {
      where.push(eq(advances.status, 'open'), sql`${advances.settleBy} < ${todayIso()}::date`);
    }
    if (search) {
      const term = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        or(
          ilike(advances.number, term),
          ilike(advances.purpose, term),
          ilike(employees.name, term),
          ilike(employees.employeeCode, term),
        )!,
      );
    }
    const filter = and(...where);
    const result = await paginate({
      query: page,
      sortable: {
        createdAt: advances.createdAt,
        submittedAt: advances.submittedAt,
        settleBy: advances.settleBy,
        requestedPaise: advances.requestedPaise,
      },
      defaultSort: view === 'open' ? 'settleBy' : view === 'mine' ? '-createdAt' : 'submittedAt',
      tiebreaker: advances.id,
      fetch: ({ orderBy, limit, offset }) =>
        db
          .select({
            a: advances,
            employeeName: employees.name,
            employeeCode: employees.employeeCode,
            departmentName: departments.name,
          })
          .from(advances)
          .innerJoin(employees, eq(employees.id, advances.employeeId))
          .leftJoin(departments, eq(departments.id, advances.departmentId))
          .where(filter)
          .orderBy(...orderBy)
          .limit(limit)
          .offset(offset),
      count: async () => {
        const [row] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(advances)
          .innerJoin(employees, eq(employees.id, advances.employeeId))
          .where(filter);
        return row!.n;
      },
    });
    const data: AdvanceSummary[] = await Promise.all(
      result.data.map(async ({ a, employeeName, employeeCode, departmentName }) => ({
        id: a.id,
        number: a.number,
        purpose: a.purpose,
        status: a.status,
        requestedPaise: a.requestedPaise,
        approvedPaise: a.approvedPaise,
        expectedDate: a.expectedDate,
        settleBy: a.settleBy,
        overdue: isOverdue(a),
        employee: { id: a.employeeId, name: employeeName, employeeCode },
        department:
          a.departmentId && departmentName ? { id: a.departmentId, name: departmentName } : null,
        submittedAt: a.submittedAt?.toISOString() ?? null,
        createdAt: a.createdAt.toISOString(),
        settlement:
          a.status === 'open' || a.status === 'closed'
            ? (await getSettlement(db, a.id)).settlement
            : null,
      })),
    );
    res.json({ data, meta: result.meta });
  });

  /** Badge counts for the approver's tabs. */
  router.get('/counts', async (req, res) => {
    const role = req.auth!.activeRole;
    const counts = { review: 0, disburse: 0, overdue: 0 };
    if (!['manager', 'accounts', 'director'].includes(role)) return void res.json(counts);
    const n = async (where: SQL) => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(advances)
        .where(where);
      return row!.n;
    };
    counts.review = await n(viewFilter(req, 'review'));
    if (role === 'accounts') {
      counts.disburse = await n(viewFilter(req, 'disburse'));
      counts.overdue = await n(
        and(viewFilter(req, 'open'), sql`${advances.settleBy} < ${todayIso()}::date`)!,
      );
    }
    res.json(counts);
  });

  /** The caller's open advances, for the "settle against advance" choice on a voucher. */
  router.get('/linkable', async (req, res) => {
    const rows = await db
      .select()
      .from(advances)
      .where(and(eq(advances.employeeId, req.auth!.userId), eq(advances.status, 'open')));
    const data: LinkableAdvance[] = await Promise.all(
      rows.map(async (a) => ({
        id: a.id,
        number: a.number!,
        purpose: a.purpose,
        disbursedPaise: (await getSettlement(db, a.id)).settlement.disbursedPaise,
        settleBy: a.settleBy,
      })),
    );
    res.json({ data });
  });

  router.get('/settings', async (_req, res) => {
    res.json(await getAdvanceSettings(db));
  });

  // ---- The employee's request ----

  router.post('/', async (req, res) => {
    const input = parseBody(advanceInputSchema, req);
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(advances)
        .values({ ...input, notes: input.notes ?? null, employeeId: req.auth!.userId })
        .returning({ id: advances.id });
      await recordAdvanceEvent(tx, event(req, { advanceId: row!.id, type: 'created' }));
      await recordAudit(tx, audit(req, 'advance.created', row!.id, null, input));
      return row!.id;
    });
    res.status(201).json(await detail(req, id));
  });

  router.get('/:id', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const a = await getAdvanceDetail(db, id, req.auth!);
    if (
      !a ||
      !canViewAdvance(req.auth!, {
        ...a,
        employeeId: a.employee.id,
        managerId: a.manager?.id ?? null,
      })
    ) {
      throw notFound('Advance');
    }
    res.json(a);
  });

  router.patch('/:id', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const { version, ...input } = parseBody(
      advanceInputSchema.extend({ version: z.number().int().min(1) }),
      req,
    );
    await db.transaction(async (tx) => {
      const a = await lock(tx, req, id, version);
      if (!advancePermissions(req.auth!, a).edit)
        throw conflict('This advance can no longer be edited');
      await bump(tx, id, { ...input, notes: input.notes ?? null });
      await recordAudit(
        tx,
        audit(
          req,
          'advance.updated',
          id,
          {
            purpose: a.purpose,
            requestedPaise: a.requestedPaise,
            expectedDate: a.expectedDate,
          },
          input,
        ),
      );
    });
    res.json(await detail(req, id));
  });

  router.delete('/:id', async (req, res) => {
    const { id } = parseParams(idParams, req);
    await db.transaction(async (tx) => {
      const a = await lock(tx, req, id);
      if (!advancePermissions(req.auth!, a).delete) {
        throw conflict('Only a draft that was never submitted can be deleted');
      }
      await tx.delete(advances).where(eq(advances.id, id));
      await recordAudit(tx, audit(req, 'advance.deleted', id, { purpose: a.purpose }, null));
    });
    res.status(204).end();
  });

  router.post('/:id/submit', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const { version } = parseBody(advanceActionSchema, req);
    await db.transaction(async (tx) => {
      const a = await lock(tx, req, id, version);
      if (!advancePermissions(req.auth!, a).submit) {
        throw conflict('This advance has already been submitted');
      }
      // Serialise this employee's submissions so two tabs can't both pass the check below.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'advance:' + a.employeeId}))`);
      const [other] = await tx
        .select({ number: advances.number, status: advances.status })
        .from(advances)
        .where(
          and(
            eq(advances.employeeId, a.employeeId),
            ne(advances.id, id),
            inArray(advances.status, [...ACTIVE_ADVANCE_STATUSES]),
          ),
        )
        .limit(1);
      if (other) {
        throw conflict(
          `You already have an active advance (${other.number ?? 'a draft'}). Settle it before you ask for another.`,
        );
      }
      const { maxAdvancePaise } = await getAdvanceSettings(tx);
      if (maxAdvancePaise !== null && a.requestedPaise > maxAdvancePaise) {
        throw field(
          'requestedPaise',
          `Advances are limited to ${formatRupees(maxAdvancePaise)}. Ask for less.`,
        );
      }
      const [claimant] = await tx
        .select({
          roles: users.roles,
          managerId: users.managerId,
          departmentId: users.departmentId,
        })
        .from(users)
        .where(eq(users.id, a.employeeId));
      const status = firstStage(claimant!);
      const number = a.number ?? (await nextDocumentNumber(tx, 'ADV'));
      const changes = {
        number,
        status,
        departmentId: claimant!.departmentId,
        managerId: status === 'pending_manager' ? claimant!.managerId : null,
        submittedAt: new Date(),
        approvedPaise: null,
      };
      await bump(tx, id, changes);
      await recordAdvanceEvent(
        tx,
        event(req, {
          advanceId: id,
          type: a.status === 'returned' ? 'resubmitted' : 'submitted',
          fromStatus: a.status,
          toStatus: status,
          meta: { requestedPaise: a.requestedPaise },
        }),
      );
      await recordAudit(tx, audit(req, 'advance.submitted', id, { status: a.status }, changes));
    });
    res.json(await detail(req, id));
  });

  router.post('/:id/cancel', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const { version, reason } = parseBody(cancelAdvanceSchema, req);
    await db.transaction(async (tx) => {
      const a = await lock(tx, req, id, version);
      if (!advancePermissions(req.auth!, a).cancel) {
        throw conflict('This advance can no longer be cancelled');
      }
      await bump(tx, id, { status: 'cancelled', cancelReason: reason });
      await recordAdvanceEvent(
        tx,
        event(req, {
          advanceId: id,
          type: 'cancelled',
          fromStatus: a.status,
          toStatus: 'cancelled',
          message: reason,
        }),
      );
      await recordAudit(tx, audit(req, 'advance.cancelled', id, { status: a.status }, { reason }));
    });
    res.json(await detail(req, id));
  });

  // ---- Approvers ----

  router.post('/:id/approve', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const input = parseBody(approveAdvanceSchema, req);
    await db.transaction(async (tx) => {
      const a = await lock(tx, req, id, input.version);
      if (!advancePermissions(req.auth!, a).approve) {
        throw a.employeeId === req.auth!.userId
          ? forbidden('You cannot approve your own advance')
          : conflict('This advance is not waiting for you');
      }
      const approvedPaise = input.approvedPaise ?? a.approvedPaise ?? a.requestedPaise;
      if (approvedPaise > a.requestedPaise) {
        throw field('approvedPaise', 'You cannot approve more than was requested');
      }
      const status = nextAdvanceStatus(a.status, 'approve');
      const final = status === 'approved';
      const changes = { status, approvedPaise, ...(final && { decidedAt: new Date() }) };
      await bump(tx, id, changes);
      await recordAdvanceEvent(
        tx,
        event(req, {
          advanceId: id,
          type: 'approved',
          fromStatus: a.status,
          toStatus: status,
          message: input.note ?? null,
          meta: { approvedPaise, requestedPaise: a.requestedPaise },
        }),
      );
      await recordAudit(tx, audit(req, 'advance.approved', id, { status: a.status }, changes));
    });
    res.json(await detail(req, id));
  });

  for (const step of ['return', 'reject'] as const) {
    const schema = step === 'return' ? returnAdvanceSchema : rejectAdvanceSchema;
    router.post(`/:id/${step}`, async (req, res) => {
      const { id } = parseParams(idParams, req);
      const { version, message } = parseBody(schema, req);
      await db.transaction(async (tx) => {
        const a = await lock(tx, req, id, version);
        if (!advancePermissions(req.auth!, a)[step]) {
          throw a.employeeId === req.auth!.userId
            ? forbidden('You cannot review your own advance')
            : conflict('This advance is not waiting for you');
        }
        const status = nextAdvanceStatus(a.status, step);
        await bump(tx, id, { status, ...(step === 'reject' && { decidedAt: new Date() }) });
        await recordAdvanceEvent(
          tx,
          event(req, {
            advanceId: id,
            type: step === 'return' ? 'returned' : 'rejected',
            fromStatus: a.status,
            toStatus: status,
            message,
          }),
        );
        await recordAudit(
          tx,
          audit(
            req,
            `advance.${step === 'return' ? 'returned' : 'rejected'}`,
            id,
            { status: a.status },
            { status, message },
          ),
        );
      });
      res.json(await detail(req, id));
    });
  }

  // ---- Money (Accounts) ----

  /** Inserts a money movement, turning a duplicate reference into a field error. */
  async function insertTransaction(tx: Tx, values: typeof advanceTransactions.$inferInsert) {
    try {
      const [row] = await tx
        .insert(advanceTransactions)
        .values(values)
        .returning({ id: advanceTransactions.id });
      return row!.id;
    } catch (err) {
      if (pgErrorCode(err) === '23505') {
        throw field('reference', 'This reference is already recorded for another transaction');
      }
      throw err;
    }
  }

  const describe = (mode: keyof typeof PAYMENT_MODE_LABELS, reference: string | null | undefined) =>
    [PAYMENT_MODE_LABELS[mode], reference].filter(Boolean).join(' · ');

  router.post('/:id/disburse', requireRole('accounts'), async (req, res) => {
    const { id } = parseParams(idParams, req);
    const input = parseBody(disburseAdvanceSchema, req);
    await db.transaction(async (tx) => {
      const a = await lock(tx, req, id, input.version);
      if (a.employeeId === req.auth!.userId) throw forbidden('You cannot pay out your own advance');
      if (!advancePermissions(req.auth!, a).disburse) {
        throw conflict(
          a.status === 'open'
            ? 'This advance is already paid out'
            : 'Only approved advances can be paid out',
        );
      }
      if (input.amountPaise > (a.approvedPaise ?? 0)) {
        throw field('amountPaise', `Only ${formatRupees(a.approvedPaise ?? 0)} was approved`);
      }
      if (input.paidOn > todayIso()) throw field('paidOn', 'The date cannot be in the future');
      if (a.decidedAt && input.paidOn < todayIso(a.decidedAt)) {
        throw field('paidOn', 'The date cannot be before the approval');
      }
      const txId = await insertTransaction(tx, {
        advanceId: id,
        kind: 'disbursement',
        amountPaise: input.amountPaise,
        paidOn: input.paidOn,
        mode: input.mode,
        reference: input.reference ?? null,
        note: input.note ?? null,
        recordedBy: req.auth!.userId,
      });
      const changes = {
        status: 'open' as const,
        disbursedAt: new Date(),
        settleBy: settleByDate(a.expectedDate, input.paidOn),
      };
      await bump(tx, id, changes);
      await recordAdvanceEvent(
        tx,
        event(req, {
          advanceId: id,
          type: 'disbursed',
          fromStatus: a.status,
          toStatus: 'open',
          message: describe(input.mode, input.reference),
          meta: { transactionId: txId, amountPaise: input.amountPaise, paidOn: input.paidOn },
        }),
      );
      await recordAudit(
        tx,
        audit(
          req,
          'advance.disbursed',
          id,
          { status: a.status },
          { ...changes, ...input, transactionId: txId, version: undefined },
        ),
      );
    });
    res.status(201).json(await detail(req, id));
  });

  /** The employee returns unused money, or the company pays the shortfall. */
  router.post('/:id/transactions', requireRole('accounts'), async (req, res) => {
    const { id } = parseParams(idParams, req);
    const input = parseBody(settlementTransactionSchema, req);
    await db.transaction(async (tx) => {
      const a = await lock(tx, req, id, input.version);
      if (a.employeeId === req.auth!.userId) throw forbidden('You cannot settle your own advance');
      if (a.status !== 'open') throw conflict('Only an open advance can be settled');
      const { settlement } = await getSettlement(tx, id);
      const limit = input.kind === 'return' ? settlement.dueBackPaise : settlement.payablePaise;
      if (limit === 0) {
        throw field(
          'kind',
          input.kind === 'return'
            ? 'Nothing is due back from the employee'
            : 'Nothing is owed to the employee',
        );
      }
      if (input.amountPaise > limit) {
        throw field(
          'amountPaise',
          input.kind === 'return'
            ? `Only ${formatRupees(limit)} is due back`
            : `Only ${formatRupees(limit)} is owed to the employee`,
        );
      }
      if (input.paidOn > todayIso()) throw field('paidOn', 'The date cannot be in the future');
      const txId = await insertTransaction(tx, {
        advanceId: id,
        kind: input.kind,
        amountPaise: input.amountPaise,
        paidOn: input.paidOn,
        mode: input.mode,
        reference: input.reference ?? null,
        note: input.note ?? null,
        recordedBy: req.auth!.userId,
      });
      await bump(tx, id, {});
      await recordAdvanceEvent(
        tx,
        event(req, {
          advanceId: id,
          type: input.kind === 'return' ? 'return_recorded' : 'top_up_recorded',
          message: describe(input.mode, input.reference),
          meta: { transactionId: txId, amountPaise: input.amountPaise, paidOn: input.paidOn },
        }),
      );
      await recordAudit(
        tx,
        audit(req, `advance.${input.kind}_recorded`, id, settlement, {
          ...input,
          transactionId: txId,
          version: undefined,
        }),
      );
    });
    res.status(201).json(await detail(req, id));
  });

  /** Undo a mistaken money movement. Reversing the payout puts the advance back to "approved". */
  router.post('/:id/transactions/:txId/reverse', requireRole('accounts'), async (req, res) => {
    const { id, txId } = parseParams(txParams, req);
    const { version, reason } = parseBody(reverseAdvanceTransactionSchema, req);
    await db.transaction(async (tx) => {
      const a = await lock(tx, req, id, version);
      if (a.employeeId === req.auth!.userId) throw forbidden('You cannot change your own advance');
      if (a.status !== 'open') throw conflict('Only an open advance can be changed');
      const [t] = await tx
        .select()
        .from(advanceTransactions)
        .where(and(eq(advanceTransactions.id, txId), eq(advanceTransactions.advanceId, id)))
        .for('update');
      if (!t) throw notFound('Transaction');
      if (t.reversedAt) throw conflict('This is already reversed');
      const before = await getSettlement(tx, id);
      let status: AdvanceStatus = a.status;
      if (t.kind === 'disbursement') {
        const others = before.transactions.filter(
          (x) => x.kind !== 'disbursement' && !x.reversedAt,
        );
        const claims = before.vouchers.filter((v) => v.approvalStatus !== 'draft');
        if (others.length || claims.length) {
          throw conflict(
            'Claims or settlement entries already use this payout. Reverse those first, or record a return instead.',
          );
        }
        status = 'approved';
      }
      await tx
        .update(advanceTransactions)
        .set({ reversedAt: new Date(), reversedBy: req.auth!.userId, reversalReason: reason })
        .where(eq(advanceTransactions.id, txId));
      await bump(
        tx,
        id,
        status === 'approved' ? { status, disbursedAt: null, settleBy: null } : {},
      );
      await recordAdvanceEvent(
        tx,
        event(req, {
          advanceId: id,
          type: 'transaction_reversed',
          fromStatus: a.status,
          toStatus: status,
          message: reason,
          meta: {
            transactionId: txId,
            kind: t.kind,
            amountPaise: t.amountPaise,
            label: ADVANCE_TRANSACTION_LABELS[t.kind],
          },
        }),
      );
      await recordAudit(
        tx,
        audit(req, 'advance.transaction_reversed', id, before.settlement, {
          transactionId: txId,
          reason,
          status,
        }),
      );
    });
    res.json(await detail(req, id));
  });

  router.post('/:id/close', requireRole('accounts'), async (req, res) => {
    const { id } = parseParams(idParams, req);
    const { version, note } = parseBody(closeAdvanceSchema, req);
    await db.transaction(async (tx) => {
      const a = await lock(tx, req, id, version);
      if (a.employeeId === req.auth!.userId) throw forbidden('You cannot close your own advance');
      if (a.status !== 'open') throw conflict('Only an open advance can be closed');
      const { settlement } = await getSettlement(tx, id);
      if (settlement.inReviewCount > 0) {
        throw conflict(
          `${settlement.inReviewCount} claim${settlement.inReviewCount === 1 ? ' is' : 's are'} still being reviewed. Close the advance once they are decided.`,
        );
      }
      if (settlement.dueBackPaise > 0) {
        throw conflict(
          `${formatRupees(settlement.dueBackPaise)} is still due back from the employee`,
        );
      }
      if (settlement.payablePaise > 0) {
        throw conflict(`${formatRupees(settlement.payablePaise)} is still owed to the employee`);
      }
      await bump(tx, id, { status: 'closed', closedAt: new Date() });
      await recordAdvanceEvent(
        tx,
        event(req, {
          advanceId: id,
          type: 'closed',
          fromStatus: 'open',
          toStatus: 'closed',
          message: note ?? null,
          meta: { ...settlement },
        }),
      );
      await recordAudit(tx, audit(req, 'advance.closed', id, { status: 'open' }, settlement));
    });
    res.json(await detail(req, id));
  });

  return router;
}

/** Admin: the advance policy. */
export function advanceSettingsRouter({ db }: Services) {
  const router = Router();
  router.use(requireRole('admin'));
  router.put('/', async (req, res) => {
    const input = parseBody(advanceSettingsSchema, req);
    await db.transaction(async (tx) => {
      const before = await getAdvanceSettings(tx);
      await tx
        .insert(settings)
        .values({ key: ADVANCE_SETTINGS_KEY, value: input })
        .onConflictDoUpdate({ target: settings.key, set: { value: input } });
      await recordAudit(tx, {
        action: 'settings.advances_updated',
        entityType: 'settings',
        entityId: null,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        before,
        after: input,
        req,
      });
    });
    res.json(await getAdvanceSettings(db));
  });
  return router;
}
