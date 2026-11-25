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
};
