import { formatRupees, isAdvanceReviewStage } from '@ticketmanager/shared';
import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db/client.js';
import { advances, users } from '../db/schema.js';
import type { NewAdvanceEvent } from '../advances/queries.js';
import { advanceHolder, stageReviewers } from './holders.js';
import { notify, usersWithRole, type Notice, type Recipient } from './notify.js';

const employee = alias(users, 'employee');
const manager = alias(users, 'manager');

const day = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`));

/** Notifies the right people about a step on an advance, in the step's transaction. */
export async function notifyAdvanceEvent(db: DbOrTx, e: NewAdvanceEvent) {
  if (e.type === 'created') return;
  const [row] = await db
    .select({ a: advances, employeeName: employee.name, managerName: manager.name })
    .from(advances)
    .innerJoin(employee, eq(employee.id, advances.employeeId))
    .leftJoin(manager, eq(manager.id, advances.managerId))
    .where(eq(advances.id, e.advanceId));
  if (!row) return;
  const { a, employeeName, managerName } = row;
  const [actorRow] = e.actorId
    ? await db.select({ name: users.name }).from(users).where(eq(users.id, e.actorId))
    : [];
  const actor = actorRow?.name ?? 'Someone';
  const num = a.number ?? 'Your advance';
  const owner: Recipient = { userId: a.employeeId, role: 'employee' };
  const amount = (key: string) => formatRupees(Number(e.meta?.[key] ?? 0));
  const base = {
    entityType: 'advance' as const,
    entityId: a.id,
    eventType: e.type,
    actorId: e.actorId,
    message: e.message ?? null,
    link: () => `/advances/${a.id}`,
  };
  const send = (n: Omit<Notice, keyof typeof base> & Partial<Notice>, to: Recipient[]) =>
    notify(db, { ...base, ...n }, to);
  const reviewers = (stage: string) => stageReviewers(db, stage, a);
  const accounts = async () =>
    (await usersWithRole(db, 'accounts')).filter((r) => r.userId !== a.employeeId);

  switch (e.type) {
    case 'submitted':
    case 'resubmitted':
      await send(
        {
          title: `${num} needs your approval`,
          body: `${employeeName} asked for an advance of ${formatRupees(a.requestedPaise)} for ${a.purpose}.`,
        },
        await reviewers(a.status),
      );
      return;
    case 'approved': {
      if (isAdvanceReviewStage(a.status)) {
        await send(
          {
            title: `${num} approved by ${actor}`,
            body: `${actor} approved ${amount('approvedPaise')} and sent your advance on for approval.`,
          },
          [owner],
        );
        await send(
          {
            title: `${num} needs your approval`,
            body: `${actor} approved an advance of ${amount('approvedPaise')} for ${employeeName} (${a.purpose}). It is waiting for you.`,
          },
          await reviewers(a.status),
        );
        return;
      }
      await send(
        {
          title: `${num} approved`,
          body: `${actor} approved your advance of ${amount('approvedPaise')}. Accounts will pay it out.`,
        },
        [owner],
      );
      if (e.actorRole !== 'accounts') {
        await send(
          {
            title: `${num} is ready to pay out`,
            body: `${actor} approved ${amount('approvedPaise')} for ${employeeName}.`,
            message: null,
          },
          await accounts(),
        );
      }
      return;
    }
    case 'returned':
      await send(
        {
          title: `${num} returned for changes`,
          body: `${actor} returned your advance request. Make the changes and resubmit it.`,
        },
        [owner],
      );
      return;
    case 'rejected':
      await send({ title: `${num} rejected`, body: `${actor} rejected your advance request.` }, [
        owner,
      ]);
      return;
    case 'cancelled':
      if (!e.fromStatus || !isAdvanceReviewStage(e.fromStatus)) return;
      await send(
        {
          title: `${num} was cancelled`,
          body: `${employeeName} cancelled the advance request. Nothing is needed from you.`,
          email: false,
        },
        await reviewers(e.fromStatus),
      );
      return;
    case 'disbursed':
      await send(
        {
          title: `${num}: ${amount('amountPaise')} paid out`,
          body:
            `${actor} paid out your advance of ${amount('amountPaise')}. Tag your expense claims to it` +
            (a.settleBy ? ` and settle it by ${day(a.settleBy)}.` : '.'),
        },
        [owner],
      );
      return;
    case 'return_recorded':
      await send(
        {
          title: `${num}: return of ${amount('amountPaise')} recorded`,
          body: `${actor} recorded ${amount('amountPaise')} you returned.`,
        },
        [owner],
      );
      return;
    case 'top_up_recorded':
      await send(
        {
          title: `${num}: shortfall of ${amount('amountPaise')} paid`,
          body: `${actor} paid you ${amount('amountPaise')} to cover what you spent beyond the advance.`,
        },
        [owner],
      );
      return;
    case 'transaction_reversed':
      await send(
        {
          title: `${num}: an entry was reversed`,
          body: `${actor} reversed ${String(e.meta?.label ?? 'an entry').toLowerCase()} of ${amount('amountPaise')}.`,
        },
        [owner],
      );
      return;
    case 'closed':
      await send(
        { title: `${num} settled`, body: `${actor} closed the settlement of your advance.` },
        [owner],
      );
      return;
    case 'followed_up': {
      const holder = await advanceHolder(db, a, managerName);
      if (!holder) return;
      await send(
        {
          title: `Reminder: ${num} is waiting for your ${holder.step}`,
          body: `${employeeName} sent a reminder about their advance of ${formatRupees(a.approvedPaise ?? a.requestedPaise)} for ${a.purpose}.`,
          kind: 'follow_up',
        },
        holder.recipients,
      );
      return;
    }
  }
}
