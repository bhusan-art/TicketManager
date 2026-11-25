import { createHash } from 'node:crypto';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import type { Db } from '../../db/client.js';
import { idempotencyKeys } from '../../db/schema.js';
import { AppError } from '../errors.js';

/**
 * Idempotency for unsafe requests (POST/PUT/PATCH/DELETE).
 *
 * When the client sends `Idempotency-Key: <uuid>`, the first response is stored for 24 hours and
 * replayed for any retry with the same key. A retry with the same key but a different body is
 * rejected with 422, and a retry while the first request is still running gets 409.
 * Requests without the header pass through unchanged.
 */

export const IDEMPOTENCY_TTL_HOURS = 24;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const expired = sql`now() - make_interval(hours => ${IDEMPOTENCY_TTL_HOURS})`;

export interface IdempotencyOptions {
  /** Who is calling. Keys are scoped per caller so two users can't collide. */
  scope?: (req: Parameters<RequestHandler>[0]) => string;
}

/** Deletes stored responses older than the TTL. The API runs this hourly. */
export async function pruneIdempotencyKeys(db: Db) {
  await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, expired));
}

export function idempotency(db: Db, options: IdempotencyOptions = {}): RequestHandler {
  const scopeOf = options.scope ?? (() => 'anonymous');

  async function claim(id: string, requestHash: string) {
    // An expired key counts as unused.
    await db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.id, id), lt(idempotencyKeys.createdAt, expired)));
    const inserted = await db
      .insert(idempotencyKeys)
      .values({ id, requestHash, status: 'in_progress' })
      .onConflictDoNothing()
      .returning({ id: idempotencyKeys.id });
    return inserted.length > 0;
  }

  return async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key || !UNSAFE.has(req.method)) return next();
    if (!KEY_PATTERN.test(key)) {
      return next(
        new AppError('VALIDATION_FAILED', 'Idempotency-Key must be 8-128 letters, digits, - or _'),
      );
    }

    const id = `${scopeOf(req)}:${req.method}:${req.originalUrl}:${key}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(req.body ?? null))
      .digest('hex');

    try {
      if (!(await claim(id, requestHash))) {
        const [existing] = await db
          .select()
          .from(idempotencyKeys)
          .where(eq(idempotencyKeys.id, id));
        if (!existing) return next(new AppError('CONFLICT', 'Please retry the request'));
        if (existing.requestHash !== requestHash) {
          return next(
            new AppError(
              'IDEMPOTENCY_KEY_REUSED',
              'This Idempotency-Key was already used with a different request body',
            ),
          );
        }
        if (existing.status === 'in_progress') {
          return next(new AppError('CONFLICT', 'The original request is still being processed'));
        }
        res.setHeader('Idempotent-Replayed', 'true');
        return res.status(existing.responseStatus ?? 200).json(existing.responseBody);
      }
    } catch (err) {
      return next(err);
    }

    // Capture the JSON response so retries can replay it.
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      const done =
        status >= 500
          ? // Server errors are not cached, so the client can retry.
            db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id))
          : db
              .update(idempotencyKeys)
              .set({ status: 'completed', responseStatus: status, responseBody: body ?? null })
              .where(eq(idempotencyKeys.id, id));
      Promise.resolve(done).catch((err: unknown) =>
        req.log?.error({ err }, 'Failed to store idempotency result'),
      );
      return originalJson(body);
    };
    next();
  };
}
