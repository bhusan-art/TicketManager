import { formatRupees, isReviewStage, stageOfQuery, type Role } from '@ticketmanager/shared';
import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db/client.js';
import { users, voucherEvents, vouchers } from '../db/schema.js';
import type { NewVoucherEvent } from '../vouchers/events.js';
import { stageReviewers, voucherHolder } from './holders.js';
import { notify, usersWithRole, type Notice, type Recipient } from './notify.js';

const employee = alias(users, 'employee');
const manager = alias(users, 'manager');

/** Where a person opens a claim, by the role they act in. */
export function voucherLink(id: string, role: Role, payment = false): string {
  switch (role) {
    case 'employee':
      return `/expenses/${id}`;
    case 'accounts':
      return payment ? `/payments/${id}` : `/verification/${id}`;
    default:
      return `/approvals/${id}`;
  }
}

async function loadVoucher(db: DbOrTx, id: string) {
  const [row] = await db
    .select({
      v: vouchers,
      employeeName: employee.name,
      managerName: manager.name,
    })
    .from(vouchers)
    .innerJoin(employee, eq(employee.id, vouchers.employeeId))
    .leftJoin(manager, eq(manager.id, vouchers.managerId))
    .where(eq(vouchers.id, id));
  return row;
}

async function nameOf(db: DbOrTx, id: string | null) {
  if (!id) return 'Someone';
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, id));
  return u?.name ?? 'Someone';
}

/** People who acted on the claim before (approvers, commenters), in the role they acted in. */
async function participants(db: DbOrTx, voucherId: string, before: number): Promise<Recipient[]> {
  const rows = await db
    .select({ actorId: voucherEvents.actorId, actorRole: voucherEvents.actorRole })
    .from(voucherEvents)
    .where(
      and(
        eq(voucherEvents.voucherId, voucherId),
        isNotNull(voucherEvents.actorId),
        lt(voucherEvents.id, before),
      ),
    )
    .orderBy(desc(voucherEvents.id));
  return rows.map((r) => ({ userId: r.actorId!, role: r.actorRole ?? 'employee' }));
}

/**
 * Notifies the right people about a step on a claim. Runs in the step's transaction, after the
 * voucher row has its new status.
 */
export async function notifyVoucherEvent(db: DbOrTx, e: NewVoucherEvent, eventId: number) {
  if (e.type === 'created' || e.type === 'attachment_added') return;
  const row = await loadVoucher(db, e.voucherId);
  if (!row) return;
  const { v, employeeName, managerName } = row;
  const actor = await nameOf(db, e.actorId);
  const num = v.number ?? 'Your claim';
  const total = formatRupees(v.totalPaise);
  const purpose = v.purpose ? ` for ${v.purpose}` : '';
  const owner: Recipient = { userId: v.employeeId, role: 'employee' };
  const base = {
    entityType: 'voucher' as const,
    entityId: v.id,
    eventType: e.type,
    actorId: e.actorId,
    message: e.message ?? null,
    link: (r: Recipient) => voucherLink(v.id, r.role),
  };
  const send = (
    n: Omit<Notice, keyof typeof base> & Partial<Notice>,
    to: Recipient[],
    cc?: Recipient[],
  ) => notify(db, { ...base, ...n }, to, cc);
  const reviewers = (stage: string) => stageReviewers(db, stage, v);

  switch (e.type) {
    case 'submitted':
    case 'resubmitted': {
      const again = e.type === 'resubmitted' ? 'resubmitted' : 'submitted';
      await send(
        {
          title: `${num} needs your approval`,
          body: `${employeeName} ${again} a claim of ${total}${purpose}.`,
        },
        await reviewers(v.approvalStatus),
      );
      // A paper claim typed in by Accounts: tell the employee it is now in the app.
      if (e.type === 'submitted' && v.enteredById && v.enteredById !== v.employeeId) {
        await send(
          {
            title: `${num} was entered from your paper claim`,
            body: `${actor} typed in your paper claim of ${total}${purpose}. You can follow it here.`,
          },
          [owner],
        );
      }
      return;
    }
    case 'review_started':
      await send(
        {
          title: `Accounts is checking ${num}`,
          body: `${actor} started verifying your claim, so it can no longer be cancelled.`,
          email: false,
        },
        [owner],
      );
      return;
    case 'approved': {
      if (isReviewStage(v.approvalStatus)) {
        await send(
          {
            title: `${num} approved by ${actor}`,
            body: `${actor} approved your claim and sent it on for verification.`,
          },
          [owner],
        );
        await send(
          {
            title: `${num} needs your approval`,
            body: `${actor} approved ${employeeName}'s claim of ${total}${purpose}. It is waiting for you.`,
          },
          await reviewers(v.approvalStatus),
        );
        return;
      }
      const approved = formatRupees(v.approvedTotalPaise ?? 0);
      const partly = (v.approvedTotalPaise ?? 0) < v.totalPaise;
      await send(
        {
          title: `${num} approved`,
          body:
            `${actor} approved ${partly ? `${approved} of your ${total} claim` : `your claim of ${total}`}. ` +
            (v.advanceId ? 'It is settled against your advance.' : 'Accounts will pay it.'),
        },
        [owner],
      );
      if (!v.advanceId && e.actorRole !== 'accounts') {
        const accounts = (await usersWithRole(db, 'accounts')).filter(
          (r) => r.userId !== v.employeeId,
        );
        await send(
          {
            title: `${num} is ready to pay`,
            body: `${actor} approved ${approved} for ${employeeName}.`,
            message: null,
            link: (r) => voucherLink(v.id, r.role, true),
          },
          accounts,
        );
      }
      return;
    }
    case 'queried': {
      // An Accounts query goes to the employee with their manager copied in.
      const cc =
        typeof e.meta?.cc === 'string' ? [{ userId: e.meta.cc, role: 'manager' as const }] : [];
      await send(
        {
          title: `Question on ${num}`,
          body: (r) =>
            r.userId === v.employeeId
              ? `${actor} asked a question about your claim${purpose}. Answer it from the claim.`
              : `${actor} asked ${employeeName} a question about their claim${purpose}. You are copied.`,
        },
        [owner],
        cc,
      );
      return;
    }
    case 'answered': {
      // The answer goes back to whoever asked.
      const [asked] = await db
        .select({ actorId: voucherEvents.actorId, actorRole: voucherEvents.actorRole })
        .from(voucherEvents)
        .where(
          and(
            eq(voucherEvents.voucherId, v.id),
            eq(voucherEvents.type, 'queried'),
            lt(voucherEvents.id, eventId),
          ),
        )
        .orderBy(desc(voucherEvents.id))
        .limit(1);
      const to =
        asked?.actorId && asked.actorRole
          ? [{ userId: asked.actorId, role: asked.actorRole }]
          : await reviewers(v.approvalStatus);
      await send(
        {
          title: `${employeeName} answered your question on ${num}`,
          body: `${employeeName} answered. The claim is back with you.`,
        },
        to,
      );
      return;
    }
    case 'returned':
      await send(
        {
          title: `${num} returned for changes`,
          body: `${actor} returned your claim${purpose}. Make the changes and resubmit it.`,
        },
        [owner],
      );
      return;
    case 'rejected':
      await send(
        { title: `${num} rejected`, body: `${actor} rejected your claim of ${total}${purpose}.` },
        [owner],
      );
      return;
    case 'cancelled': {
      const from = e.fromStatus ?? null;
      const stage = from && (isReviewStage(from) ? from : stageOfQuery(from));
      if (!stage) return;
      await send(
        {
          title: `${num} was cancelled`,
          body: `${employeeName} cancelled the claim. Nothing is needed from you.`,
          email: false,
        },
        await reviewers(stage),
      );
      return;
    }
    case 'comment': {
      const others = await participants(db, v.id, eventId);
      await send({ title: `New comment on ${num}`, body: `${actor} commented on the claim.` }, [
        owner,
        ...others,
      ]);
      return;
    }
    case 'payment_recorded': {
      const amount = formatRupees(Number(e.meta?.amountPaise ?? 0));
      const full = e.meta?.status === 'paid' ? ' Your claim is now paid in full.' : '';
      await send(
        {
          title: `${num}: ${amount} paid`,
          body: `${actor} recorded a payment of ${amount}${e.message ? ` (${e.message})` : ''}.${full}`,
          message: null,
        },
        [owner],
      );
      return;
    }
    case 'payment_reversed': {
      const amount = formatRupees(Number(e.meta?.amountPaise ?? 0));
      await send(
        {
          title: `Payment on ${num} reversed`,
          body: `${actor} reversed payment ${String(e.meta?.number ?? '')} of ${amount}.`,
        },
        [owner],
      );
      return;
    }
    case 'followed_up': {
      const holder = await voucherHolder(db, v, managerName);
      if (!holder) return;
      await send(
        {
          title: `Reminder: ${num} is waiting for your ${holder.step}`,
          body: `${employeeName} sent a reminder about their claim of ${total}${purpose}.`,
          kind: 'follow_up',
          link: (r) => voucherLink(v.id, r.role, holder.step === 'payment'),
        },
        holder.recipients,
      );
      return;
    }
  }
}
