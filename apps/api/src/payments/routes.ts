import {
  PAYMENT_MODE_LABELS,
  formatRupees,
  paginationQuerySchema,
  paymentQueueQuerySchema,
  recordPaymentSchema,
  reversePaymentSchema,
  todayIso,
  type PaymentQueueItem,
} from '@ticketmanager/shared';
import { and, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { requireRole } from '../auth/middleware.js';
import { pgErrorCode, type Tx } from '../db/client.js';
import { departments, payments, users, vouchers } from '../db/schema.js';
import { AppError, conflict, forbidden, notFound } from '../http/errors.js';
import { paginate } from '../http/pagination.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import type { Services } from '../services.js';
import { recordEvent } from '../vouchers/events.js';
import { nextDocumentNumber } from '../vouchers/numbering.js';
import {
  getVoucherDetail,
  projectCondition,
  toVoucherSummary,
  voucherSummaryColumns,
} from '../vouchers/queries.js';
import { canPay, canView } from '../vouchers/workflow.js';
import { voucherMoney } from './queries.js';

const idParams = z.object({ id: z.uuid() });
const paymentParams = idParams.extend({ paymentId: z.uuid() });

const field = (path: string, message: string) =>
  new AppError('VALIDATION_FAILED', message, [{ path, message }]);

/** Payment status that matches the paid amount. */
function paymentStatusFor(paid: number, approved: number) {
  if (paid <= 0) return 'payment_pending' as const;
  if (paid >= approved) return 'paid' as const;
  return 'partially_paid' as const;
}

/** Recording and reversing payments on a voucher. Accounts only. */
export function voucherPaymentsRouter({ db }: Services) {
  const router = Router();
  router.use(requireRole('accounts'));

  async function lock(tx: Tx, req: Request, id: string, version: number) {
    const [v] = await tx.select().from(vouchers).where(eq(vouchers.id, id)).for('update');
    if (!v || !canView(req.auth!, v)) throw notFound('Voucher');
    if (v.version !== version) {
      throw conflict('This voucher was changed somewhere else. Reload it and try again.', {
        currentVersion: v.version,
      });
    }
    if (v.employeeId === req.auth!.userId) throw forbidden('You cannot pay your own claim');
    return v;
  }

  router.post('/:id/payments', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const input = parseBody(recordPaymentSchema, req);
    await db.transaction(async (tx) => {
      const v = await lock(tx, req, id, input.version);
      if (!canPay(req.auth!, v)) {
        throw conflict(
          v.paymentStatus === 'paid'
            ? 'This voucher is already paid in full'
            : 'Only approved vouchers can be paid',
        );
      }
      const { approvedPaise, outstandingPaise } = voucherMoney(v);
      if (input.amountPaise > outstandingPaise) {
        throw field(
          'amountPaise',
          `Only ${formatRupees(outstandingPaise)} is outstanding on this voucher`,
        );
      }
      if (input.paidOn > todayIso())
        throw field('paidOn', 'The payment date cannot be in the future');
      const approvedOn = v.decidedAt ? todayIso(v.decidedAt) : null;
      if (approvedOn && input.paidOn < approvedOn) {
        throw field('paidOn', 'The payment date cannot be before the approval');
      }

      const number = await nextDocumentNumber(tx, 'PAY');
      let paymentId: string;
      try {
        const [row] = await tx
          .insert(payments)
          .values({
            number,
            voucherId: id,
            amountPaise: input.amountPaise,
            paidOn: input.paidOn,
            mode: input.mode,
            reference: input.reference ?? null,
            note: input.note ?? null,
            recordedBy: req.auth!.userId,
          })
          .returning({ id: payments.id });
        paymentId = row!.id;
      } catch (err) {
        if (pgErrorCode(err) === '23505') {
          throw field('reference', 'This reference is already recorded against another payment');
        }
        throw err;
      }

      const paid = v.paidPaise + input.amountPaise;
      const status = paymentStatusFor(paid, approvedPaise);
      const changes = {
        paidPaise: paid,
        paymentStatus: status,
        paidAt: status === 'paid' ? new Date() : null,
      };
      await tx
        .update(vouchers)
        .set({ ...changes, version: sql`${vouchers.version} + 1` })
        .where(eq(vouchers.id, id));
      await recordEvent(tx, {
        voucherId: id,
        type: 'payment_recorded',
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        message: [PAYMENT_MODE_LABELS[input.mode], input.reference].filter(Boolean).join(' · '),
        meta: { paymentId, number, amountPaise: input.amountPaise, paidOn: input.paidOn, status },
      });
      await recordAudit(tx, {
        action: 'payment.recorded',
        entityType: 'voucher',
        entityId: id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        before: { paidPaise: v.paidPaise, paymentStatus: v.paymentStatus },
        after: { ...changes, paymentId, number, ...input, version: undefined },
        req,
      });
    });
    res.status(201).json(await getVoucherDetail(db, id, req.auth!));
  });

  /** Undo a mistaken payment. The row stays, marked reversed, and stops counting. */
  router.post('/:id/payments/:paymentId/reverse', async (req, res) => {
    const { id, paymentId } = parseParams(paymentParams, req);
    const { version, reason } = parseBody(reversePaymentSchema, req);
    await db.transaction(async (tx) => {
      const v = await lock(tx, req, id, version);
      const [p] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.id, paymentId), eq(payments.voucherId, id)))
        .for('update');
      if (!p) throw notFound('Payment');
      if (p.reversedAt) throw conflict('This payment is already reversed');

      await tx
        .update(payments)
        .set({ reversedAt: new Date(), reversedBy: req.auth!.userId, reversalReason: reason })
        .where(eq(payments.id, paymentId));
      const paid = v.paidPaise - p.amountPaise;
      const changes = {
        paidPaise: paid,
        paymentStatus: paymentStatusFor(paid, voucherMoney(v).approvedPaise),
        paidAt: null,
      };
      await tx
        .update(vouchers)
        .set({ ...changes, version: sql`${vouchers.version} + 1` })
        .where(eq(vouchers.id, id));
      await recordEvent(tx, {
        voucherId: id,
        type: 'payment_reversed',
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        message: reason,
        meta: { paymentId, number: p.number, amountPaise: p.amountPaise },
      });
      await recordAudit(tx, {
        action: 'payment.reversed',
        entityType: 'voucher',
        entityId: id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        before: { paidPaise: v.paidPaise, paymentStatus: v.paymentStatus },
        after: { ...changes, paymentId, number: p.number, reason },
        req,
      });
    });
    res.json(await getVoucherDetail(db, id, req.auth!));
  });

  return router;
}

const employees = alias(users, 'employee');

/** Accounts' payment queue: approved claims waiting for money, and what was paid. */
export function paymentQueueRouter({ db }: Services) {
  const router = Router();
  router.use(requireRole('accounts'));

  router.get('/', async (req, res) => {
    const page = parseQuery(paginationQuerySchema, req);
    const { view, search, projectId } = parseQuery(paymentQueueQuerySchema, req);
    const where: SQL[] = [
      inArray(vouchers.approvalStatus, ['approved', 'partially_approved']),
      // Claims tagged to an advance are settled there, never paid here.
      sql`${vouchers.advanceId} is null`,
    ];
    if (view === 'due') {
      where.push(inArray(vouchers.paymentStatus, ['payment_pending', 'partially_paid']));
    }
    if (view === 'paid') where.push(eq(vouchers.paymentStatus, 'paid'));
    if (projectId) where.push(projectCondition(projectId));
    if (search) {
      const term = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        or(
          ilike(vouchers.number, term),
          ilike(employees.name, term),
          ilike(employees.employeeCode, term),
          sql`exists (select 1 from payments p where p.voucher_id = "vouchers"."id" and p.reference ilike ${term})`,
        )!,
      );
    }
    const filter = and(...where);
    const result = await paginate({
      query: page,
      sortable: {
        decidedAt: vouchers.decidedAt,
        paidAt: vouchers.paidAt,
        approvedTotalPaise: vouchers.approvedTotalPaise,
        number: vouchers.number,
      },
      // Pay the oldest approvals first.
      defaultSort: view === 'paid' ? '-paidAt' : 'decidedAt',
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
            approvedTotalPaise: vouchers.approvedTotalPaise,
            paidPaise: vouchers.paidPaise,
            decidedAt: vouchers.decidedAt,
            paidAt: vouchers.paidAt,
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
    const data: PaymentQueueItem[] = result.data.map((r) => {
      const {
        employeeId,
        employeeName,
        employeeCode,
        departmentId,
        departmentName,
        approvedTotalPaise,
        paidPaise,
        decidedAt,
        paidAt,
        ...summary
      } = r;
      return {
        ...toVoucherSummary(summary),
        ...voucherMoney({ approvalStatus: summary.approvalStatus, approvedTotalPaise, paidPaise }),
        employee: { id: employeeId, name: employeeName, employeeCode },
        department:
          departmentId && departmentName ? { id: departmentId, name: departmentName } : null,
        decidedAt: decidedAt?.toISOString() ?? null,
        paidAt: paidAt?.toISOString() ?? null,
      };
    });
    res.json({ data, meta: result.meta });
  });

  return router;
}
