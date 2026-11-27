import {
  CHAT_PAGE,
  chatQuerySchema,
  postChatMessageSchema,
  type ChatMessage,
  type ChatThread,
} from '@ticketmanager/shared';
import { and, desc, eq, gt, isNull, type SQL } from 'drizzle-orm';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { advanceHolder, voucherHolder } from '../notifications/holders.js';
import { notify, type Recipient } from '../notifications/notify.js';
import { voucherLink } from '../notifications/voucherNotices.js';
import { requireAuth } from '../auth/middleware.js';
import type { DbOrTx, Tx } from '../db/client.js';
import { advances, chatMessages, notifications, users, vouchers } from '../db/schema.js';
import { conflict, notFound } from '../http/errors.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import { canViewAdvance } from '../advances/workflow.js';
import { canView } from '../vouchers/workflow.js';
import type { Services } from '../services.js';

const idParams = z.object({ id: z.uuid() });
type Kind = 'voucher' | 'advance';

/** What the chat needs to know about the claim or advance it hangs off. */
interface Parent {
  id: string;
  number: string | null;
  employeeId: string;
  employeeName: string;
  submitted: boolean;
  /** Who it waits on now, other than the employee. */
  holders: () => Promise<Recipient[]>;
  link: (r: Recipient) => string;
  label: string;
}

async function nameOf(db: DbOrTx, id: string | null) {
  if (!id) return null;
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, id));
  return u?.name ?? null;
}

async function loadParent(db: DbOrTx, kind: Kind, req: Request, id: string): Promise<Parent> {
  const caller = req.auth!;
  if (kind === 'voucher') {
    const [v] = await db.select().from(vouchers).where(eq(vouchers.id, id));
    if (!v || !canView(caller, v)) throw notFound('Voucher');
    return {
      id,
      number: v.number,
      employeeId: v.employeeId,
      employeeName: (await nameOf(db, v.employeeId)) ?? 'The employee',
      submitted: !!v.submittedAt,
      holders: async () =>
        (await voucherHolder(db, v, await nameOf(db, v.managerId)))?.recipients ?? [],
      link: (r) => voucherLink(id, r.role),
      label: 'claim',
    };
  }
  const [a] = await db.select().from(advances).where(eq(advances.id, id));
  if (!a || !canViewAdvance(caller, a)) throw notFound('Advance');
  return {
    id,
    number: a.number,
    employeeId: a.employeeId,
    employeeName: (await nameOf(db, a.employeeId)) ?? 'The employee',
    submitted: !!a.submittedAt,
    holders: async () =>
      (await advanceHolder(db, a, await nameOf(db, a.managerId)))?.recipients ?? [],
    link: () => `/advances/${id}`,
    label: 'advance',
  };
}

const parentColumn = (kind: Kind) =>
  kind === 'voucher' ? chatMessages.voucherId : chatMessages.advanceId;

async function readMessages(
  db: DbOrTx,
  kind: Kind,
  id: string,
  after?: number,
): Promise<ChatMessage[]> {
  const where: SQL[] = [eq(parentColumn(kind), id)];
  if (after !== undefined) where.push(gt(chatMessages.id, after));
  const rows = await db
    .select({ m: chatMessages, name: users.name })
    .from(chatMessages)
    .innerJoin(users, eq(users.id, chatMessages.authorId))
    .where(and(...where))
    .orderBy(desc(chatMessages.id))
    .limit(CHAT_PAGE);
  return rows.reverse().map(({ m, name }) => ({
    id: m.id,
    author: { id: m.authorId, name },
    authorRole: m.authorRole,
    body: m.body,
    createdAt: m.createdAt.toISOString(),
  }));
}

/**
 * Who hears about a new message: the employee, everyone who wrote in the chat before, and, when
 * the employee starts the conversation, whoever the claim waits on now.
 */
async function recipients(db: DbOrTx, kind: Kind, p: Parent, authorId: string) {
  const earlier = await db
    .selectDistinct({ userId: chatMessages.authorId, role: chatMessages.authorRole })
    .from(chatMessages)
    .where(eq(parentColumn(kind), p.id));
  const list: Recipient[] = [{ userId: p.employeeId, role: 'employee' }, ...earlier];
  const othersWrote = earlier.some((r) => r.userId !== p.employeeId);
  if (authorId === p.employeeId && !othersWrote) list.push(...(await p.holders()));

  // One unread chat notification per person is enough; skip anyone who already has one.
  const waiting = await db
    .select({ userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        eq(notifications.entityId, p.id),
        eq(notifications.eventType, 'chat'),
        isNull(notifications.readAt),
      ),
    );
  const skip = new Set(waiting.map((w) => w.userId));
  return list.filter((r) => r.userId !== authorId && !skip.has(r.userId));
}

/** GET/POST /vouchers/:id/chat and /advances/:id/chat: talk about a claim or advance. */
export function chatRouter(kind: Kind, { db }: Services) {
  const router = Router();
  router.use(requireAuth);

  router.get('/:id/chat', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const { after } = parseQuery(chatQuerySchema, req);
    const p = await loadParent(db, kind, req, id);
    const messages = await readMessages(db, kind, id, after);
    // Reading the chat clears its notifications for the reader.
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, req.auth!.userId),
          eq(notifications.entityId, id),
          eq(notifications.eventType, 'chat'),
          isNull(notifications.readAt),
        ),
      );
    const thread: ChatThread = { messages, canPost: p.submitted };
    res.json(thread);
  });

  router.post('/:id/chat', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const { body } = parseBody(postChatMessageSchema, req);
    const message = await db.transaction(async (tx: Tx) => {
      const p = await loadParent(tx, kind, req, id);
      if (!p.submitted) throw conflict(`You can chat once the ${p.label} has been submitted.`);
      const auth = req.auth!;
      const to = await recipients(tx, kind, p, auth.userId);
      const [row] = await tx
        .insert(chatMessages)
        .values({
          voucherId: kind === 'voucher' ? id : null,
          advanceId: kind === 'advance' ? id : null,
          authorId: auth.userId,
          authorRole: auth.activeRole,
          body,
        })
        .returning();
      const author = (await nameOf(tx, auth.userId)) ?? 'Someone';
      const what = p.number ?? `${p.employeeName}'s ${p.label}`;
      await notify(
        tx,
        {
          title: `New message on ${what}`,
          body: `${author} wrote in the chat on ${what}.`,
          message: body.length > 200 ? `${body.slice(0, 200)}…` : body,
          entityType: kind,
          entityId: id,
          eventType: 'chat',
          actorId: auth.userId,
          link: p.link,
          email: false,
        },
        to,
      );
      return { ...row!, name: author };
    });
    const out: ChatMessage = {
      id: message.id,
      author: { id: message.authorId, name: message.name },
      authorRole: message.authorRole,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    };
    res.status(201).json(out);
  });

  return router;
}
