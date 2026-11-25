import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import mongoose, { Schema } from 'mongoose';
import { AppError } from '../errors.js';

/**
 * Idempotency for unsafe requests (POST/PUT/PATCH/DELETE).
 *
 * When the client sends `Idempotency-Key: <uuid>`, the first response is stored for 24 hours and
 * replayed for any retry with the same key. A retry with the same key but a different body is
 * rejected with 422, and a retry while the first request is still running gets 409.
 * Requests without the header pass through unchanged.
 */

const TTL_SECONDS = 24 * 60 * 60;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

interface IdempotencyRecord {
  _id: string;
  requestHash: string;
  status: 'in_progress' | 'completed';
  responseStatus?: number;
  responseBody?: unknown;
  createdAt: Date;
}

const idempotencySchema = new Schema<IdempotencyRecord>(
  {
    _id: { type: String, required: true },
    requestHash: { type: String, required: true },
    status: { type: String, enum: ['in_progress', 'completed'], required: true },
    responseStatus: Number,
    responseBody: Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now, expires: TTL_SECONDS },
  },
  { collection: 'idempotency_keys', versionKey: false },
);

export const IdempotencyKey =
  (mongoose.models.IdempotencyKey as mongoose.Model<IdempotencyRecord> | undefined) ??
  mongoose.model<IdempotencyRecord>('IdempotencyKey', idempotencySchema);

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface IdempotencyOptions {
  /** Who is calling. Keys are scoped per caller so two users can't collide. */
  scope?: (req: Parameters<RequestHandler>[0]) => string;
}

export function idempotency(options: IdempotencyOptions = {}): RequestHandler {
  const scopeOf = options.scope ?? (() => 'anonymous');

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
      await IdempotencyKey.create({ _id: id, requestHash, status: 'in_progress' });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) return next(err);
      const existing = await IdempotencyKey.findById(id).lean();
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

    // Capture the JSON response so retries can replay it.
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      const done =
        status >= 500
          ? // Server errors are not cached, so the client can retry.
            IdempotencyKey.deleteOne({ _id: id })
          : IdempotencyKey.updateOne(
              { _id: id },
              { status: 'completed', responseStatus: status, responseBody: body },
            );
      done.catch((err: unknown) => req.log?.error({ err }, 'Failed to store idempotency result'));
      return originalJson(body);
    };
    next();
  };
}
