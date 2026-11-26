import type { Role } from '@ticketmanager/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import type { Db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { AppError, forbidden } from '../http/errors.js';
import type { AccessTokens } from './accessToken.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
  activeRole: Role;
  roles: Role[];
  email: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Reads the bearer token, if any, and sets `req.auth`. It never rejects a request;
 * `requireAuth` and `requireRole` do that. The user and session are checked on every request,
 * so deactivating a user or revoking a session takes effect at once.
 */
export function authenticate(db: Db, tokens: AccessTokens): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('authorization');
    if (!header?.startsWith('Bearer ')) return next();
    try {
      const claims = await tokens.verify(header.slice(7));
      if (!claims) return next();
      const [row] = await db
        .select({ roles: users.roles, email: users.email, name: users.name })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.id, claims.sessionId),
            eq(sessions.userId, claims.userId),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, sql`now()`),
            eq(users.status, 'active'),
          ),
        );
      if (row && row.roles.includes(claims.activeRole)) {
        req.auth = { ...claims, ...row };
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  next(req.auth ? undefined : new AppError('UNAUTHENTICATED', 'Please sign in'));
};

/** Allows the request only when the caller's *active* role is one of these. */
export function requireRole(...allowed: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new AppError('UNAUTHENTICATED', 'Please sign in'));
    if (!allowed.includes(req.auth.activeRole)) {
      return next(forbidden(`Switch to the ${allowed.join(' or ')} role to do this`));
    }
    next();
  };
}
