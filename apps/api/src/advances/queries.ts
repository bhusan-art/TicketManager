import {
  settle,
  todayIso,
  type AdvanceDetail,
  type AdvanceEvent,
  type AdvanceEventType,
  type AdvanceStatus,
  type AdvanceTransaction,
  type AdvanceVoucher,
  type ApprovalStatus,
  type Role,
} from '@ticketmanager/shared';
import { and, asc, eq, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/middleware.js';
import type { DbOrTx } from '../db/client.js';
import {
  advanceEvents,
  advanceTransactions,
  advances,
  departments,
  users,
  vouchers,
} from '../db/schema.js';
import { advancePermissions, advanceWaitingOn } from './workflow.js';

const employees = alias(users, 'employee');
const managers = alias(users, 'advance_manager');
const recorders = alias(users, 'recorder');
const reversers = alias(users, 'reverser');

const ref = (id: string | null, name: string | null) => (id && name ? { id, name } : null);

/** Claims that count toward a settlement. */
export const COUNTED_STATUSES: readonly ApprovalStatus[] = ['approved', 'partially_approved'];
/** Submitted claims not yet decided. An advance can't close while it has any. */
export const IN_REVIEW_STATUSES: readonly ApprovalStatus[] = [
  'pending_manager',
  'manager_query',
  'pending_accounts',
  'accounts_query',
  'pending_director',
  'director_query',
  'returned',
];

export const isOverdue = (
  a: { status: AdvanceStatus; settleBy: string | null },
  today = todayIso(),
) => a.status === 'open' && !!a.settleBy && a.settleBy < today;

export async function getAdvanceTransactions(
  db: DbOrTx,
  advanceId: string,
): Promise<AdvanceTransaction[]> {
  const rows = await db
    .select({
      t: advanceTransactions,
      recorderName: recorders.name,
      reverserName: reversers.name,
    })
    .from(advanceTransactions)
    .leftJoin(recorders, eq(recorders.id, advanceTransactions.recordedBy))
    .leftJoin(reversers, eq(reversers.id, advanceTransactions.reversedBy))
    .where(eq(advanceTransactions.advanceId, advanceId))
    .orderBy(asc(advanceTransactions.createdAt));
  return rows.map(({ t, recorderName, reverserName }) => ({
    id: t.id,
    kind: t.kind,
    amountPaise: t.amountPaise,
    paidOn: t.paidOn,
    mode: t.mode,
    reference: t.reference,
    note: t.note,
    recordedBy: ref(t.recordedBy, recorderName),
    createdAt: t.createdAt.toISOString(),
    reversedAt: t.reversedAt?.toISOString() ?? null,
    reversedBy: ref(t.reversedBy, reverserName),
    reversalReason: t.reversalReason,
  }));
}

/** Vouchers tagged to the advance (cancelled ones left out). */
export async function getAdvanceVouchers(db: DbOrTx, advanceId: string): Promise<AdvanceVoucher[]> {
  const rows = await db
    .select({
      id: vouchers.id,
      number: vouchers.number,
      purpose: vouchers.purpose,
      approvalStatus: vouchers.approvalStatus,
      totalPaise: vouchers.totalPaise,
      approvedTotalPaise: vouchers.approvedTotalPaise,
    })
    .from(vouchers)
    .where(and(eq(vouchers.advanceId, advanceId), ne(vouchers.approvalStatus, 'cancelled')))
    .orderBy(asc(vouchers.createdAt));
  return rows.map((v) => {
    const counted = COUNTED_STATUSES.includes(v.approvalStatus);
    return {
      ...v,
      approvedTotalPaise: counted ? v.approvedTotalPaise : null,
      counted,
      inReview: IN_REVIEW_STATUSES.includes(v.approvalStatus),
    };
  });
}

/** The settlement as it stands. Pass the transaction when the advance is locked. */
export async function getSettlement(db: DbOrTx, advanceId: string) {
  const [transactions, linked] = await Promise.all([
    getAdvanceTransactions(db, advanceId),
    getAdvanceVouchers(db, advanceId),
  ]);
  return { transactions, vouchers: linked, settlement: settle({ transactions, vouchers: linked }) };
}

export interface NewAdvanceEvent {
  advanceId: string;
  type: AdvanceEventType;
  actorId: string | null;
  actorRole?: Role | null;
  fromStatus?: AdvanceStatus | null;
  toStatus?: AdvanceStatus | null;
  message?: string | null;
  meta?: Record<string, unknown> | null;
}

export async function recordAdvanceEvent(db: Pick<DbOrTx, 'insert'>, e: NewAdvanceEvent) {
  await db.insert(advanceEvents).values({
    advanceId: e.advanceId,
    type: e.type,
    actorId: e.actorId,
    actorRole: e.actorRole ?? null,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    message: e.message ?? null,
    meta: e.meta ?? null,
  });
}

async function getAdvanceEvents(db: DbOrTx, advanceId: string): Promise<AdvanceEvent[]> {
  const rows = await db
    .select({ e: advanceEvents, actorName: users.name })
    .from(advanceEvents)
    .leftJoin(users, eq(users.id, advanceEvents.actorId))
    .where(eq(advanceEvents.advanceId, advanceId))
    .orderBy(asc(advanceEvents.id));
  return rows.map(({ e, actorName }) => ({
    id: e.id,
    type: e.type,
    at: e.at.toISOString(),
    actor: ref(e.actorId, actorName),
    actorRole: e.actorRole,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    message: e.message,
    meta: (e.meta as Record<string, unknown> | null) ?? null,
  }));
}

export async function getAdvanceDetail(
  db: DbOrTx,
  id: string,
  auth: AuthContext,
): Promise<AdvanceDetail | undefined> {
  const [row] = await db
    .select({
      a: advances,
      employee: {
        id: employees.id,
        name: employees.name,
        email: employees.email,
        employeeCode: employees.employeeCode,
        designation: employees.designation,
        departmentId: employees.departmentId,
      },
      departmentName: departments.name,
      managerName: managers.name,
    })
    .from(advances)
    .innerJoin(employees, eq(employees.id, advances.employeeId))
    .leftJoin(departments, eq(departments.id, advances.departmentId))
    .leftJoin(managers, eq(managers.id, advances.managerId))
    .where(eq(advances.id, id));
  if (!row) return undefined;
  const a = row.a;
  const [{ transactions, vouchers: linked, settlement }, events] = await Promise.all([
    getSettlement(db, a.id),
    getAdvanceEvents(db, a.id),
  ]);
  let department = ref(a.departmentId, row.departmentName);
  if (!a.submittedAt && row.employee.departmentId) {
    const [d] = await db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .where(eq(departments.id, row.employee.departmentId));
    department = d ?? null;
  }
  return {
    id: a.id,
    number: a.number,
    purpose: a.purpose,
    notes: a.notes,
    status: a.status,
    requestedPaise: a.requestedPaise,
    approvedPaise: a.approvedPaise,
    expectedDate: a.expectedDate,
    settleBy: a.settleBy,
    overdue: isOverdue(a),
    version: a.version,
    employee: {
      id: row.employee.id,
      name: row.employee.name,
      email: row.employee.email,
      employeeCode: row.employee.employeeCode,
      designation: row.employee.designation,
    },
    department,
    manager: ref(a.managerId, row.managerName),
    submittedAt: a.submittedAt?.toISOString() ?? null,
    decidedAt: a.decidedAt?.toISOString() ?? null,
    disbursedAt: a.disbursedAt?.toISOString() ?? null,
    closedAt: a.closedAt?.toISOString() ?? null,
    cancelReason: a.cancelReason,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    waitingOn: advanceWaitingOn(a, row.managerName),
    transactions,
    vouchers: linked,
    settlement,
    events,
    can: advancePermissions(auth, a, settlement),
  };
}
