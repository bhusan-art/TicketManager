import type { ApprovalStatus, Role, VoucherEvent, VoucherEventType } from '@ticketmanager/shared';
import { asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { users, voucherEvents } from '../db/schema.js';
import { notifyVoucherEvent } from '../notifications/voucherNotices.js';

export interface NewVoucherEvent {
  voucherId: string;
  type: VoucherEventType;
  actorId: string | null;
  actorRole?: Role | null;
  fromStatus?: ApprovalStatus | null;
  toStatus?: ApprovalStatus | null;
  message?: string | null;
  meta?: Record<string, unknown> | null;
}

/**
 * Adds a timeline entry and notifies the people the step concerns. Pass the transaction that
 * makes the change, after the voucher has its new status.
 */
export async function recordEvent(db: DbOrTx, e: NewVoucherEvent) {
  const [row] = await db
    .insert(voucherEvents)
    .values({
      voucherId: e.voucherId,
      type: e.type,
      actorId: e.actorId,
      actorRole: e.actorRole ?? null,
      fromStatus: e.fromStatus ?? null,
      toStatus: e.toStatus ?? null,
      message: e.message ?? null,
      meta: e.meta ?? null,
    })
    .returning({ id: voucherEvents.id });
  await notifyVoucherEvent(db, e, row!.id);
}

export async function getVoucherEvents(db: DbOrTx, voucherId: string): Promise<VoucherEvent[]> {
  const rows = await db
    .select({ event: voucherEvents, actorName: users.name })
    .from(voucherEvents)
    .leftJoin(users, eq(users.id, voucherEvents.actorId))
    .where(eq(voucherEvents.voucherId, voucherId))
    .orderBy(asc(voucherEvents.id));
  return rows.map(({ event: e, actorName }) => ({
    id: e.id,
    type: e.type,
    at: e.at.toISOString(),
    actor: e.actorId && actorName ? { id: e.actorId, name: actorName } : null,
    actorRole: e.actorRole,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    message: e.message,
    meta: (e.meta as Record<string, unknown> | null) ?? null,
  }));
}
