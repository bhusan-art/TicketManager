import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  switchRoleSchema,
  type AuthConfigResponse,
  type GoogleLoginError,
  type Role,
  type SessionResponse,
} from '@ticketmanager/shared';
import { and, eq, ne } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { recordAudit } from '../audit/audit.js';
import type { Db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { parseBody } from '../http/validate.js';
import { resetEmail } from '../mail/templates.js';
import type { Services } from '../services.js';
import { defaultRole, getAuthUser } from '../users/queries.js';
import { burnPasswordCheck, hashPassword, newToken, verifyPassword } from './crypto.js';
import { newPkce } from './google.js';
import { requireAuth } from './middleware.js';
import {
  createPasswordToken,
  expireOpenTokens,
  findUsableToken,
  passwordLink,
  recentlySent,
} from './passwordTokens.js';
import {
  createSession,
  revokeAllForUser,
  revokeByToken,
  rotateSession,
  setSessionRole,
} from './sessions.js';

export const REFRESH_COOKIE = 'tm_refresh';
const OAUTH_COOKIE = 'tm_oauth';
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

const invalidLogin = () => new AppError('UNAUTHENTICATED', 'Email or password is incorrect');

export function authRouter(services: Services) {
  const { db, config, tokens, mailer, google } = services;
  const router = Router();
  const secure = config.PUBLIC_URL.startsWith('https://');
  const cookieBase = { httpOnly: true, secure, path: '/api/v1/auth' } as const;

  function setRefreshCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      ...cookieBase,
      sameSite: 'strict',
      maxAge: config.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
    });
  }

  const meta = (req: Request) => ({ userAgent: req.get('user-agent'), ip: req.ip });

  async function sessionResponse(
    userId: string,
    sessionId: string,
    role: Role,
  ): Promise<SessionResponse> {
    return {
      accessToken: await tokens.sign({ userId, sessionId, activeRole: role }),
      expiresIn: tokens.ttlSeconds,
      user: await getAuthUser(db, userId, role),
    };
  }

  /** Shared by password and Google sign-in once the user is known and allowed in. */
  async function signIn(
    req: Request,
    res: Response,
    user: typeof users.$inferSelect,
    method: string,
  ) {
    const role = defaultRole(user.roles, user.lastActiveRole);
    await db
      .update(users)
      .set({
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastActiveRole: role,
      })
      .where(eq(users.id, user.id));
    const { token, sessionId } = await createSession(
      db,
      user.id,
      role,
      config.REFRESH_TOKEN_DAYS,
      meta(req),
    );
    setRefreshCookie(res, token);
    await recordAudit(db, {
      action: 'auth.signed_in',
      entityType: 'user',
      entityId: user.id,
      actorId: user.id,
      meta: { method },
      req,
    });
    return sessionResponse(user.id, sessionId, role);
  }

  router.get('/config', (_req, res) => {
    const body: AuthConfigResponse = { googleEnabled: Boolean(google) };
    res.json(body);
  });

  router.post('/login', async (req, res) => {
    const { email, password } = parseBody(loginSchema, req);
    const [user] = await db.select().from(users).where(eq(users.email, email));

    if (!user?.passwordHash) {
      await burnPasswordCheck(password);
      throw invalidLogin();
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(
        'RATE_LIMITED',
        `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes or reset your password.`,
      );
    }
    if (!(await verifyPassword(user.passwordHash, password))) {
      const failures = user.failedLoginCount + 1;
      const lock = failures >= MAX_FAILED_LOGINS;
      await db
        .update(users)
        .set({
          failedLoginCount: lock ? 0 : failures,
          lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.lockedUntil,
        })
        .where(eq(users.id, user.id));
      await recordAudit(db, {
        action: lock ? 'auth.locked' : 'auth.sign_in_failed',
        entityType: 'user',
        entityId: user.id,
        req,
      });
      throw invalidLogin();
    }
    if (user.status !== 'active') {
      throw new AppError('FORBIDDEN', 'Your account is inactive. Contact your admin.');
    }
    res.json(await signIn(req, res, user, 'password'));
  });

  router.post('/refresh', async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!token) throw new AppError('UNAUTHENTICATED', 'Please sign in');
    const result = await rotateSession(db, token, config.REFRESH_TOKEN_DAYS, meta(req));
    if (!result.ok) {
      // In a race between tabs the other tab already holds the new cookie: leave it alone and
      // tell the client to retry, which will send the new cookie.
      if (result.reason === 'race') {
        throw new AppError('CONFLICT', 'The session was just refreshed. Retry the request.');
      }
      res.clearCookie(REFRESH_COOKIE, cookieBase);
      throw new AppError('UNAUTHENTICATED', 'Your session has ended. Please sign in again.');
    }
    const [user] = await db
      .select({ status: users.status, roles: users.roles })
      .from(users)
      .where(eq(users.id, result.userId));
    if (!user || user.status !== 'active') {
      await revokeAllForUser(db, result.userId);
      res.clearCookie(REFRESH_COOKIE, cookieBase);
      throw new AppError('UNAUTHENTICATED', 'Your account is inactive. Contact your admin.');
    }
    // Roles may have changed since sign-in.
    let role = result.activeRole;
    if (!user.roles.includes(role)) {
      role = defaultRole(user.roles, null);
      await setSessionRole(db, result.sessionId, role);
    }
    setRefreshCookie(res, result.token);
    res.json(await sessionResponse(result.userId, result.sessionId, role));
  });

  router.post('/logout', async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (token) await revokeByToken(db, token);
    res.clearCookie(REFRESH_COOKIE, cookieBase);
    res.status(204).end();
  });

  router.get('/me', requireAuth, async (req, res) => {
    res.json(await getAuthUser(db, req.auth!.userId, req.auth!.activeRole));
  });

  router.post('/switch-role', requireAuth, async (req, res) => {
    const { role } = parseBody(switchRoleSchema, req);
    const auth = req.auth!;
    if (!auth.roles.includes(role)) throw new AppError('FORBIDDEN', 'You do not have that role');
    await setSessionRole(db, auth.sessionId, role);
    await db.update(users).set({ lastActiveRole: role }).where(eq(users.id, auth.userId));
    res.json(await sessionResponse(auth.userId, auth.sessionId, role));
  });

  router.post('/password/forgot', async (req, res) => {
    const { email } = parseBody(forgotPasswordSchema, req);
    const [user] = await db.select().from(users).where(eq(users.email, email));
    // Same answer whether or not the account exists, so this can't be used to find accounts.
    if (user && user.status === 'active' && !(await recentlySent(db, user.id))) {
      const token = await createPasswordToken(db, user.id, 'reset');
      await mailer.send(
        resetEmail(user.email, user.name, passwordLink(config.PUBLIC_URL, token, 'reset')),
      );
      await recordAudit(db, {
        action: 'auth.password_reset_requested',
        entityType: 'user',
        entityId: user.id,
        req,
      });
    }
    res.status(204).end();
  });

  router.post('/password/reset', async (req, res) => {
    const { token, password } = parseBody(resetPasswordSchema, req);
    const passwordHash = await hashPassword(password);
    await db.transaction(async (tx) => {
      const row = await findUsableToken(tx, token);
      const [user] = row ? await tx.select().from(users).where(eq(users.id, row.userId)) : [];
      if (!row || !user || user.status !== 'active') {
        throw new AppError(
          'VALIDATION_FAILED',
          'This link is invalid or has expired. Ask for a new one.',
        );
      }
      await tx
        .update(users)
        .set({
          passwordHash,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
        })
        .where(eq(users.id, user.id));
      await expireOpenTokens(tx, user.id);
      await revokeAllForUser(tx, user.id);
      await recordAudit(tx, {
        action: row.purpose === 'invite' ? 'auth.password_set' : 'auth.password_reset',
        entityType: 'user',
        entityId: user.id,
        actorId: user.id,
        req,
      });
    });
    res.status(204).end();
  });

  router.post('/password/change', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = parseBody(changePasswordSchema, req);
    const auth = req.auth!;
    const [user] = await db.select().from(users).where(eq(users.id, auth.userId));
    if (user!.passwordHash && !(await verifyPassword(user!.passwordHash, currentPassword ?? ''))) {
      throw new AppError('VALIDATION_FAILED', 'Your current password is incorrect', [
        { path: 'currentPassword', message: 'Your current password is incorrect' },
      ]);
    }
    const passwordHash = await hashPassword(newPassword);
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash, passwordChangedAt: new Date() })
        .where(eq(users.id, auth.userId));
      // Sign out every other device, keep this one.
      const [current] = await tx
        .select({ familyId: sessions.familyId })
        .from(sessions)
        .where(eq(sessions.id, auth.sessionId));
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, auth.userId), ne(sessions.familyId, current!.familyId)));
      await recordAudit(tx, {
        action: 'auth.password_changed',
        entityType: 'user',
        entityId: auth.userId,
        actorId: auth.userId,
        req,
      });
    });
    res.status(204).end();
  });

  // ---- Google sign-in ----

  const loginRedirect = (res: Response, error: GoogleLoginError) =>
    res.redirect(`${config.PUBLIC_URL}/login?error=${error}`);

  router.get('/google/start', (_req, res) => {
    if (!google) throw new AppError('NOT_FOUND', 'Google sign-in is not set up');
    const state = newToken();
    const nonce = newToken();
    const pkce = newPkce();
    res.cookie(OAUTH_COOKIE, JSON.stringify({ state, nonce, verifier: pkce.verifier }), {
      httpOnly: true,
      secure,
      signed: true,
      sameSite: 'lax',
      path: '/api/v1/auth/google',
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(google.authUrl({ state, nonce, codeChallenge: pkce.challenge }));
  });

  router.get('/google/callback', async (req, res) => {
    if (!google) throw new AppError('NOT_FOUND', 'Google sign-in is not set up');
    const raw = req.signedCookies?.[OAUTH_COOKIE] as string | undefined;
    res.clearCookie(OAUTH_COOKIE, { path: '/api/v1/auth/google' });
    let saved: { state: string; nonce: string; verifier: string } | undefined;
    try {
      saved = raw ? JSON.parse(raw) : undefined;
    } catch {
      saved = undefined;
    }
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    if (!saved || !code || req.query.state !== saved.state) {
      return loginRedirect(res, 'google_failed');
    }

    let identity;
    try {
      identity = await google.exchange({ code, codeVerifier: saved.verifier, nonce: saved.nonce });
    } catch (err) {
      req.log?.warn({ err }, 'Google sign-in failed');
      return loginRedirect(res, 'google_failed');
    }
    if (!identity.emailVerified) return loginRedirect(res, 'google_failed');

    const user = await findGoogleUser(db, identity);
    if (!user) return loginRedirect(res, 'google_not_registered');
    if (user.status !== 'active') return loginRedirect(res, 'google_inactive');

    await signIn(req, res, user, 'google');
    res.redirect(`${config.PUBLIC_URL}/`);
  });

  return router;
}

/** Finds the user by their linked Google account, or links it the first time by email. */
async function findGoogleUser(db: Db, identity: { sub: string; email: string }) {
  const [linked] = await db.select().from(users).where(eq(users.googleSub, identity.sub));
  if (linked) return linked;
  const [byEmail] = await db.select().from(users).where(eq(users.email, identity.email));
  if (!byEmail || byEmail.googleSub) return undefined;
  const [updated] = await db
    .update(users)
    .set({ googleSub: identity.sub })
    .where(eq(users.id, byEmail.id))
    .returning();
  await recordAudit(db, {
    action: 'auth.google_linked',
    entityType: 'user',
    entityId: byEmail.id,
    actorId: byEmail.id,
  });
  return updated;
}
