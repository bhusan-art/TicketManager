import type { Payment } from '@ticketmanager/shared';
import { asc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db/client.js';
import { payments, users } from '../db/schema.js';
import { isFinalApproval } from '../vouchers/workflow.js';

const recorders = alias(users, 'recorder');
const reversers = alias(users, 'reverser');

/** A voucher's payments, oldest first, reversed ones included. */
export async function getVoucherPayments(db: DbOrTx, voucherId: string): Promise<Payment[]> {
  const rows = await db
    .select({ p: payments, recorderName: recorders.name, reverserName: reversers.name })
    .from(payments)
    .leftJoin(recorders, eq(recorders.id, payments.recordedBy))
    .leftJoin(reversers, eq(reversers.id, payments.reversedBy))
    .where(eq(payments.voucherId, voucherId))
    .orderBy(asc(payments.createdAt));
  return rows.map(({ p, recorderName, reverserName }) => ({
    id: p.id,
    number: p.number,
    amountPaise: p.amountPaise,
    paidOn: p.paidOn,
    mode: p.mode,
    reference: p.reference,
    note: p.note,
    recordedBy: recorderName ? { id: p.recordedBy, name: recorderName } : null,
    createdAt: p.createdAt.toISOString(),
    reversedAt: p.reversedAt?.toISOString() ?? null,
    reversedBy: p.reversedBy && reverserName ? { id: p.reversedBy, name: reverserName } : null,
    reversalReason: p.reversalReason,
  }));
}

/** Approved, paid and outstanding amounts. Nothing is outstanding until final approval. */
export function voucherMoney(v: {
  approvalStatus: Parameters<typeof isFinalApproval>[0];
  approvedTotalPaise: number | null;
  paidPaise: number;
}) {
  const approvedPaise = isFinalApproval(v.approvalStatus) ? (v.approvedTotalPaise ?? 0) : 0;
  return {
    approvedPaise,
    paidPaise: v.paidPaise,
    outstandingPaise: Math.max(approvedPaise - v.paidPaise, 0),
  };
}
