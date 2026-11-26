import type { RequestHandler } from 'express';
import { AppError } from '../errors.js';

export interface RateLimitRule {
  /** Most requests per window from one address. */
  max: number;
  windowMs: number;
}

/** Limits on the endpoints people could hammer without signing in. Per client address. */
export const DEFAULT_RATE_LIMITS = {
  login: { max: 30, windowMs: 15 * 60_000 },
  passwordForgot: { max: 5, windowMs: 15 * 60_000 },
  passwordReset: { max: 10, windowMs: 15 * 60_000 },
  google: { max: 30, windowMs: 15 * 60_000 },
  exportLink: { max: 30, windowMs: 15 * 60_000 },
} satisfies Record<string, RateLimitRule>;
export type RateLimits = Record<keyof typeof DEFAULT_RATE_LIMITS, RateLimitRule>;

/**
 * Fixed-window counter in memory. The API runs as one process, so this is exact; nginx limits
 * in front of it too. Behind nginx `req.ip` is the client address (trust proxy is 1).
 */
export function createRateLimiter(now: () => number = Date.now) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  const sweep = setInterval(() => {
    const t = now();
    for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
  }, 60_000);
  sweep.unref();

  function limit(name: string, rule: RateLimitRule): RequestHandler {
    return (req, res, next) => {
      const key = `${name}:${req.ip ?? 'unknown'}`;
      const t = now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        entry = { count: 0, resetAt: t + rule.windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      res.setHeader('RateLimit-Limit', String(rule.max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, rule.max - entry.count)));
      if (entry.count > rule.max) {
        const seconds = Math.ceil((entry.resetAt - t) / 1000);
        res.setHeader('Retry-After', String(seconds));
        const minutes = Math.ceil(seconds / 60);
        next(
          new AppError(
            'RATE_LIMITED',
            `Too many attempts from this network. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
          ),
        );
        return;
      }
      next();
    };
  }

  return { limit, reset: () => hits.clear() };
}
