import {
  emailLogQuerySchema,
  followUpSchema,
  markNotificationsReadSchema,
  notificationListQuerySchema,
  notificationSettingsSchema,
  paginationQuerySchema,
  type AppNotification,
  type EmailDelivery,
  type FollowUpState,
} from '@ticketmanager/shared';
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  isNotNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import type { DbOrTx, Tx } from '../db/client.js';
import {
  advanceEvents,
  advances,
  emailOutbox,
  notifications,
  settings,
  users,
  voucherEvents,
  vouchers,
} from '../db/schema.js';
import { AppError, forbidden, notFound } from '../http/errors.js';
import { paginate } from '../http/pagination.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import type { Services } from '../services.js';
import { recordAdvanceEvent } from '../advances/queries.js';
import { canViewAdvance } from '../advances/workflow.js';
import { recordEvent } from '../vouchers/events.js';
import { canView } from '../vouchers/workflow.js';
import { advanceHolder, voucherHolder, type Holder } from './holders.js';
import { NOTIFICATION_SETTINGS_KEY, getNotificationSettings } from './settings.js';

const idParams = z.object({ id: z.uuid() });
const actor = alias(users, 'actor');

function toNotification(
  n: typeof notifications.$inferSelect,
  actorName: string | null,
): AppNotification {
  return {
    id: n.id,
    title: n.title,
    body: n.body,
    link: n.link,
    entityType: n.entityType,
    entityId: n.entityId,
    role: n.role,
    actor: n.actorId && actorName ? { id: n.actorId, name: actorName } : null,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt?.toISOString() ?? null,
  };
}

/** The signed-in person's notification centre. */
export function notificationsRouter({ db }: Services) {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const page = parseQuery(paginationQuerySchema, req);
    const { unread } = parseQuery(notificationListQuerySchema, req);
    const where = and(
      eq(notifications.userId, req.auth!.userId),
      unread === 'true' ? isNull(notifications.readAt) : undefined,
    );
    const result = await paginate({
      query: page,
      sortable: { createdAt: notifications.createdAt },
      defaultSort: '-createdAt',
      tiebreaker: notifications.id,
      fetch: async ({ orderBy, limit, offset }) => {
        const rows = await db
          .select({ n: notifications, actorName: actor.name })
          .from(notifications)
          .leftJoin(actor, eq(actor.id, notifications.actorId))
          .where(where)
          .orderBy(...orderBy)
          .limit(limit)
          .offset(offset);
        return rows.map((r) => toNotification(r.n, r.actorName));
      },
      count: async () => (await db.select({ n: count() }).from(notifications).where(where))[0]!.n,
    });
    res.json(result);
  });

  router.get('/unread-count', async (req, res) => {
    const [row] = await db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, req.auth!.userId), isNull(notifications.readAt)));
    res.json({ unread: row!.n });
  });

  router.post('/read', async (req, res) => {
    const input = parseBody(markNotificationsReadSchema, req);
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, req.auth!.userId),
          isNull(notifications.readAt),
          'ids' in input ? inArray(notifications.id, input.ids) : undefined,
        ),
      );
    res.status(204).end();
  });

  /** Anyone signed in can see the cooldown, so the app can explain it. */
  router.get('/settings', async (_req, res) => {
    res.json(await getNotificationSettings(db));
  });

  return router;
}

// ---- Follow-ups ----

async function lastFollowUp(db: DbOrTx, kind: 'voucher' | 'advance', id: string) {
  const table = kind === 'voucher' ? voucherEvents : advanceEvents;
  const idColumn = kind === 'voucher' ? voucherEvents.voucherId : advanceEvents.advanceId;
  const [sent] = await db
    .select({ at: table.at })
    .from(table)
    .where(and(eq(idColumn, id), eq(table.type, 'followed_up')))
    .orderBy(desc(table.id))
    .limit(1);
  // The claim's latest move (submitted, approved…) starts the clock too, so nobody is chased the
  // moment it reaches them.
  const [moved] = await db
    .select({ at: table.at })
    .from(table)
    .where(and(eq(idColumn, id), isNotNull(table.toStatus)))
    .orderBy(desc(table.id))
    .limit(1);
  return { sentAt: sent?.at ?? null, movedAt: moved?.at ?? null };
}

async function followUpState(
  db: DbOrTx,
  kind: 'voucher' | 'advance',
  id: string,
  isOwner: boolean,
  holder: Holder | null,
): Promise<FollowUpState> {
  const { followUpCooldownHours } = await getNotificationSettings(db);
  const { sentAt, movedAt } = await lastFollowUp(db, kind, id);
  const from = Math.max(sentAt?.getTime() ?? 0, movedAt?.getTime() ?? 0);
  const next = from ? new Date(from + followUpCooldownHours * 3_600_000) : null;
  const waiting = holder && holder.recipients.length > 0 ? holder : null;
  return {
    waitingOn: waiting?.label ?? null,
    canSend: isOwner && !!waiting && (!next || next.getTime() <= Date.now()),
    nextAllowedAt: next && next.getTime() > Date.now() ? next.toISOString() : null,
    lastSentAt: sentAt?.toISOString() ?? null,
    cooldownHours: followUpCooldownHours,
  };
}

function cooling(state: FollowUpState): AppError {
  if (!state.waitingOn) {
    return new AppError('CONFLICT', 'It is not waiting on anyone, so there is nobody to remind.');
  }
  return new AppError(
    'CONFLICT',
    `You can send a reminder once every ${state.cooldownHours} hours. Try again later.`,
    { nextAllowedAt: state.nextAllowedAt },
  );
}

async function managerName(db: DbOrTx, managerId: string | null) {
  if (!managerId) return null;
  const [m] = await db.select({ name: users.name }).from(users).where(eq(users.id, managerId));
  return m?.name ?? null;
}

/** GET/POST /vouchers/:id/follow-up: the employee nudges whoever holds their claim. */
export function voucherFollowUpRouter({ db }: Services) {
  const router = Router();
  router.use(requireAuth);

  async function load(db: DbOrTx, req: Request, id: string, lock = false) {
    const q = db.select().from(vouchers).where(eq(vouchers.id, id));
    const [v] = lock ? await q.for('update') : await q;
    if (!v || !canView(req.auth!, v)) throw notFound('Voucher');
    const holder = await voucherHolder(db, v, await managerName(db, v.managerId));
    const state = await followUpState(db, 'voucher', id, v.employeeId === req.auth!.userId, holder);
    return { v, state };
  }

  router.get('/:id/follow-up', async (req, res) => {
    const { id } = parseParams(idParams, req);
    res.json((await load(db, req, id)).state);
  });

  router.post('/:id/follow-up', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const { message } = parseBody(followUpSchema, req);
    const state = await db.transaction(async (tx: Tx) => {
      const { v, state } = await load(tx, req, id, true);
      if (v.employeeId !== req.auth!.userId)
        throw forbidden('Only the employee can send a reminder');
      if (!state.canSend) throw cooling(state);
      await recordEvent(tx, {
        voucherId: id,
        type: 'followed_up',
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        message: message || null,
        meta: { waitingOn: state.waitingOn },
      });
      return (await load(tx, req, id)).state;
    });
    res.status(201).json(state);
  });

  return router;
}

/** GET/POST /advances/:id/follow-up. */
export function advanceFollowUpRouter({ db }: Services) {
  const router = Router();
  router.use(requireAuth);

  async function load(db: DbOrTx, req: Request, id: string, lock = false) {
    const q = db.select().from(advances).where(eq(advances.id, id));
    const [a] = lock ? await q.for('update') : await q;
    if (!a || !canViewAdvance(req.auth!, a)) throw notFound('Advance');
    const holder = await advanceHolder(db, a, await managerName(db, a.managerId));
    const state = await followUpState(db, 'advance', id, a.employeeId === req.auth!.userId, holder);
    return { a, state };
  }

  router.get('/:id/follow-up', async (req, res) => {
    const { id } = parseParams(idParams, req);
    res.json((await load(db, req, id)).state);
  });

  router.post('/:id/follow-up', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const { message } = parseBody(followUpSchema, req);
    const state = await db.transaction(async (tx: Tx) => {
      const { a, state } = await load(tx, req, id, true);
      if (a.employeeId !== req.auth!.userId)
        throw forbidden('Only the employee can send a reminder');
      if (!state.canSend) throw cooling(state);
      await recordAdvanceEvent(tx, {
        advanceId: id,
        type: 'followed_up',
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        message: message || null,
        meta: { waitingOn: state.waitingOn },
      });
      return (await load(tx, req, id)).state;
    });
    res.status(201).json(state);
  });

  return router;
}

// ---- Admin: delivery log and settings ----

function toDelivery(e: typeof emailOutbox.$inferSelect): EmailDelivery {
  return {
    id: e.id,
    kind: e.kind,
    to: e.to,
    cc: e.cc,
    subject: e.subject,
    status: e.status,
    attempts: e.attempts,
    lastError: e.lastError,
    createdAt: e.createdAt.toISOString(),
    sentAt: e.sentAt?.toISOString() ?? null,
    nextAttemptAt: e.status === 'pending' ? e.nextAttemptAt.toISOString() : null,
  };
}

/** /admin/emails: every email the app sent or tried to send, and a retry for failed ones. */
export function emailLogRouter({ db, mailer }: Services) {
  const router = Router();
  router.use(requireRole('admin'));

  router.get('/', async (req, res) => {
    const page = parseQuery(paginationQuerySchema, req);
    const filters = parseQuery(emailLogQuerySchema, req);
    const where: SQL[] = [];
    if (filters.status) where.push(eq(emailOutbox.status, filters.status));
    if (filters.search) {
      const term = `%${filters.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        or(
          ilike(emailOutbox.subject, term),
          sql`array_to_string(${emailOutbox.to}, ',') ilike ${term}`,
        )!,
      );
    }
    const condition = where.length ? and(...where) : undefined;
    const result = await paginate({
      query: page,
      sortable: { createdAt: emailOutbox.createdAt, status: emailOutbox.status },
      defaultSort: '-createdAt',
      tiebreaker: emailOutbox.id,
      fetch: async ({ orderBy, limit, offset }) =>
        (
          await db
            .select()
            .from(emailOutbox)
            .where(condition)
            .orderBy(...orderBy)
            .limit(limit)
            .offset(offset)
        ).map(toDelivery),
      count: async () => (await db.select({ n: count() }).from(emailOutbox).where(condition))[0]!.n,
    });
    const [counts] = await db
      .select({
        pending: sql<number>`count(*) filter (where ${emailOutbox.status} = 'pending')::int`,
        failed: sql<number>`count(*) filter (where ${emailOutbox.status} = 'failed')::int`,
      })
      .from(emailOutbox);
    res.json({ ...result, counts });
  });

  router.post('/:id/retry', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const row = await db.transaction(async (tx) => {
      const [e] = await tx.select().from(emailOutbox).where(eq(emailOutbox.id, id)).for('update');
      if (!e) throw notFound('Email');
      if (e.status !== 'failed')
        throw new AppError('CONFLICT', 'Only a failed email can be retried');
      const [updated] = await tx
        .update(emailOutbox)
        .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date() })
        .where(eq(emailOutbox.id, id))
        .returning();
      await recordAudit(tx, {
        action: 'email.retried',
        entityType: 'email',
        entityId: id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        before: { status: e.status, attempts: e.attempts, lastError: e.lastError },
        after: { status: 'pending' },
        req,
      });
      return updated!;
    });
    mailer.wake();
    res.json(toDelivery(row));
  });

  return router;
}

/** PUT /admin/settings/notifications. */
export function notificationSettingsRouter({ db }: Services) {
  const router = Router();
  router.use(requireRole('admin'));
  router.put('/', async (req, res) => {
    const input = parseBody(notificationSettingsSchema, req);
    await db.transaction(async (tx) => {
      const before = await getNotificationSettings(tx);
      await tx
        .insert(settings)
        .values({ key: NOTIFICATION_SETTINGS_KEY, value: input })
        .onConflictDoUpdate({ target: settings.key, set: { value: input } });
      await recordAudit(tx, {
        action: 'settings.notifications_updated',
        entityType: 'settings',
        entityId: null,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        before,
        after: input,
        req,
      });
    });
    res.json(await getNotificationSettings(db));
  });
  return router;
}
