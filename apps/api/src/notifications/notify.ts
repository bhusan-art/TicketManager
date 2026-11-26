import type { NotificationEntity, Role } from '@ticketmanager/shared';
import { and, arrayContains, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { notifications, users } from '../db/schema.js';
import { queueEmail } from '../mail/mailer.js';
import { getNotificationSettings } from './settings.js';

/** One person to tell, and the role they act in (it decides the link and the role to switch to). */
export interface Recipient {
  userId: string;
  role: Role;
}

export interface Notice {
  /** Short line, also the email subject: "EXP-2026-00012 needs your approval". */
  title: string;
  /** A sentence or two: who did what. A function when it reads differently per recipient. */
  body: string | ((r: Recipient) => string);
  /** What the actor wrote (query, reason, comment), quoted under the body. */
  message?: string | null;
  entityType: NotificationEntity;
  entityId: string;
  eventType: string;
  actorId: string | null;
  /** App path for a recipient. */
  link: (r: Recipient) => string;
  /** Workflow emails can be turned off in Settings; in-app notifications can't. */
  kind?: 'notification' | 'follow_up';
  /** False for minor steps that only show in the app. */
  email?: boolean;
}

/** Active users holding a role, e.g. everyone working as Accounts. */
export async function usersWithRole(db: DbOrTx, role: Role): Promise<Recipient[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(arrayContains(users.roles, [role]), eq(users.status, 'active')));
  return rows.map((r) => ({ userId: r.id, role }));
}

/** Drops the actor and repeats, keeping the first role given for each person. */
function distinct(list: Recipient[], skip: Set<string>): Recipient[] {
  const seen = new Set(skip);
  const out: Recipient[] = [];
  for (const r of list) {
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    out.push(r);
  }
  return out;
}

/**
 * Tells people about a workflow step: an in-app notification for each recipient and each person
 * copied, and (when email is on) one email per recipient with the others copied. Call it inside
 * the transaction that makes the change, so nothing is sent for a change that rolls back.
 * Nobody is notified about their own action.
 */
export async function notify(
  tx: DbOrTx,
  notice: Notice,
  to: Recipient[],
  cc: Recipient[] = [],
): Promise<void> {
  const skip = new Set(notice.actorId ? [notice.actorId] : []);
  const primary = distinct(to, skip);
  const copied = distinct(cc, new Set([...skip, ...primary.map((r) => r.userId)]));
  const everyone = [...primary, ...copied];
  if (everyone.length === 0) return;

  const bodyFor = (r: Recipient) =>
    typeof notice.body === 'function' ? notice.body(r) : notice.body;
  await tx.insert(notifications).values(
    everyone.map((r) => ({
      userId: r.userId,
      role: r.role,
      title: notice.title,
      body: notice.message ? `${bodyFor(r)}\n“${notice.message}”` : bodyFor(r),
      link: notice.link(r),
      entityType: notice.entityType,
      entityId: notice.entityId,
      eventType: notice.eventType,
      actorId: notice.actorId,
    })),
  );

  if (notice.email === false) return;
  const settings = await getNotificationSettings(tx);
  if (!settings.emailEnabled) return;
  const people = await tx
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(
      and(
        inArray(
          users.id,
          everyone.map((r) => r.userId),
        ),
        eq(users.status, 'active'),
      ),
    );
  const byId = new Map(people.map((p) => [p.id, p]));
  const ccEmails = copied.flatMap((r) => byId.get(r.userId)?.email ?? []);
  for (const r of primary) {
    const person = byId.get(r.userId);
    if (!person) continue;
    const quoted = notice.message
      ? `\n\n${notice.message
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')}`
      : '';
    await queueEmail(tx, {
      kind: notice.kind ?? 'notification',
      to: person.email,
      cc: ccEmails,
      subject: notice.title,
      text: `Hi ${person.name},\n\n${bodyFor(r)}${quoted}`,
      link: notice.link(r),
    });
  }
}
