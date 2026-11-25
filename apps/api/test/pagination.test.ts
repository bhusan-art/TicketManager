import { paginationQuerySchema } from '@ticketmanager/shared';
import { expect, it } from 'vitest';
import { auditLog } from '../src/db/schema.js';
import { paginate } from '../src/http/pagination.js';
import { describeWithDb, useTestDb } from './helpers.js';

describeWithDb('paginate', () => {
  const t = useTestDb();

  const list = (raw: Record<string, string>) =>
    paginate({
      query: paginationQuerySchema.parse(raw),
      sortable: { at: auditLog.at, action: auditLog.action },
      defaultSort: '-at',
      tiebreaker: auditLog.id,
      fetch: ({ orderBy, limit, offset }) =>
        t.db
          .select({ action: auditLog.action })
          .from(auditLog)
          .orderBy(...orderBy)
          .limit(limit)
          .offset(offset),
      count: () => t.db.$count(auditLog),
    });

  const seed = (n: number) =>
    t.db.insert(auditLog).values(
      Array.from({ length: n }, (_, i) => ({
        action: `a${String(i).padStart(2, '0')}`,
        entityType: 'x',
        at: new Date(Date.UTC(2026, 0, i + 1)),
      })),
    );

  it('returns a page and meta', async () => {
    await seed(25);
    const result = await list({ page: '2', pageSize: '10', sort: 'action' });
    expect(result.meta).toEqual({ page: 2, pageSize: 10, total: 25, totalPages: 3 });
    expect(result.data.map((d) => d.action)).toEqual(
      Array.from({ length: 10 }, (_, i) => `a${i + 10}`),
    );
  });

  it('uses the default sort (newest first)', async () => {
    await seed(2);
    const result = await list({});
    expect(result.data.map((d) => d.action)).toEqual(['a01', 'a00']);
  });

  it('rejects sorting on a field that is not allowed', async () => {
    await expect(list({ sort: 'ip' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
