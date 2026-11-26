import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { passwordTokens } from '../db/schema.js';
import { hashToken, newToken } from './crypto.js';

export type PasswordTokenPurpose = 'reset' | 'invite';

const LIFETIME_HOURS: Record<PasswordTokenPurpose, number> = { reset: 1, invite: 24 * 7 };

/** Makes a single-use link token. Earlier unused tokens for the user stop working. */
export async function createPasswordToken(
  db: Pick<Db, 'insert' | 'update'>,
  userId: string,
  purpose: PasswordTokenPurpose,
) {
  await expireOpenTokens(db, userId);
  const token = newToken();
  await db.insert(passwordTokens).values({
    userId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: sql`now() + make_interval(hours => ${LIFETIME_HOURS[purpose]})`,
  });
  return token;
}

export async function expireOpenTokens(db: Pick<Db, 'update'>, userId: string) {
  await db
    .update(passwordTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordTokens.userId, userId), isNull(passwordTokens.usedAt)));
}

export async function findUsableToken(db: Pick<Db, 'select'>, token: string) {
  const [row] = await db
    .select()
    .from(passwordTokens)
    .where(
      and(
        eq(passwordTokens.tokenHash, hashToken(token)),
        isNull(passwordTokens.usedAt),
        gt(passwordTokens.expiresAt, sql`now()`),
      ),
    );
  return row;
}

/** True when a reset link was sent to this user in the last minute (simple spam guard). */
export async function recentlySent(db: Db, userId: string) {
  const [row] = await db
    .select({ id: passwordTokens.id })
    .from(passwordTokens)
    .where(
      and(
        eq(passwordTokens.userId, userId),
        gt(passwordTokens.createdAt, sql`now() - interval '1 minute'`),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export function passwordLink(publicUrl: string, token: string, purpose: PasswordTokenPurpose) {
  const page = purpose === 'invite' ? 'set-password' : 'reset-password';
  return `${publicUrl}/${page}?token=${encodeURIComponent(token)}`;
}
