import { randomUUID } from 'node:crypto';
import type { Role } from '@ticketmanager/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { hashToken, newToken } from './crypto.js';

/** A refresh token replaced this recently is treated as a race between tabs, not as theft. */
const REUSE_GRACE_SECONDS = 30;

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

/**
 * How long a sign-in lasts. A remembered one runs `days` from each renewal. Any other one ends
 * `SHORT_SESSION_HOURS` after sign-in, however often it is renewed.
 */
export type SessionLength = { remember: true; days: number } | { remember: false; until: Date };

export async function createSession(
  db: DbOrTx,
  userId: string,
  activeRole: Role,
  length: SessionLength,
  meta: SessionMeta,
  familyId: string = randomUUID(),
) {
  const token = newToken();
  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      familyId,
      activeRole,
      remember: length.remember,
      tokenHash: hashToken(token),
      expiresAt: length.remember
        ? sql`now() + make_interval(days => ${length.days})`
        : length.until,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ip: meta.ip ?? null,
    })
    .returning({ id: sessions.id });
  return { token, sessionId: row!.id };
}

export type RotateResult =
  | {
      ok: true;
      token: string;
      sessionId: string;
      userId: string;
      activeRole: Role;
      remember: boolean;
    }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'reused' | 'race' };

/**
 * Exchanges a refresh token for a new one. Presenting a token that was already exchanged
 * (outside a short grace window) revokes every token from that sign-in.
 */
export async function rotateSession(
  db: Db,
  token: string,
  days: number,
  meta: SessionMeta,
): Promise<RotateResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)))
      .for('update');
    if (!current) return { ok: false, reason: 'unknown' };
    if (current.revokedAt) return { ok: false, reason: 'revoked' };
    if (current.replacedAt) {
      const ageSeconds = (Date.now() - current.replacedAt.getTime()) / 1000;
      if (ageSeconds <= REUSE_GRACE_SECONDS) return { ok: false, reason: 'race' };
      await revokeFamily(tx, current.familyId);
      return { ok: false, reason: 'reused' };
    }
    if (current.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

    await tx.update(sessions).set({ replacedAt: new Date() }).where(eq(sessions.id, current.id));
    const next = await createSession(
      tx,
      current.userId,
      current.activeRole,
      current.remember ? { remember: true, days } : { remember: false, until: current.expiresAt },
      meta,
      current.familyId,
    );
    return {
      ok: true,
      ...next,
      userId: current.userId,
      activeRole: current.activeRole,
      remember: current.remember,
    };
  });
}

/** The live session (not replaced, revoked or expired) an access token belongs to. */
export async function getLiveSession(db: Db, sessionId: string) {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, sql`now()`),
      ),
    );
  return row;
}

export async function setSessionRole(db: Db, sessionId: string, role: Role) {
  await db.update(sessions).set({ activeRole: role }).where(eq(sessions.id, sessionId));
}

export async function revokeByToken(db: Db, token: string) {
  const [row] = await db
    .select({ familyId: sessions.familyId })
    .from(sessions)
    .where(eq(sessions.tokenHash, hashToken(token)));
  if (row) await revokeFamily(db, row.familyId);
}

export async function revokeFamily(db: DbOrTx, familyId: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)));
}

/** Signs a user out everywhere, e.g. after a password reset or deactivation. */
export async function revokeAllForUser(db: Pick<Db, 'update'>, userId: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}
