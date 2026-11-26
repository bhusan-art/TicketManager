import { WORKER_HEARTBEAT_KEY } from '@ticketmanager/shared';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Db } from '../db/client.js';

export function createRedis(url: string) {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export const checks = {
  database: (db: Db) => async () => {
    await db.execute(sql`select 1`);
    return true;
  },
  redis: (redis: Redis) => async () => (await redis.ping()) === 'PONG',
  /** Up while the worker keeps refreshing its heartbeat (it expires two minutes after the last). */
  worker: (redis: Redis) => async () => (await redis.exists(WORKER_HEARTBEAT_KEY)) === 1,
};

export const workerLastSeen = (redis: Redis) => () => redis.get(WORKER_HEARTBEAT_KEY);
