import { paginationQuerySchema } from '@ticketmanager/shared';
import mongoose, { Schema } from 'mongoose';
import { expect, it } from 'vitest';
import { paginate } from '../src/http/pagination.js';
import { describeWithDb, useTestDb } from './helpers.js';

interface Item {
  n: number;
  createdAt: Date;
}
const Item =
  (mongoose.models.TestItem as mongoose.Model<Item> | undefined) ??
  mongoose.model<Item>('TestItem', new Schema<Item>({ n: Number, createdAt: Date }));

describeWithDb('paginate', () => {
  useTestDb();

  it('returns a page and meta', async () => {
    await Item.insertMany(
      Array.from({ length: 25 }, (_, i) => ({ n: i, createdAt: new Date(2026, 0, i + 1) })),
    );
    const query = paginationQuerySchema.parse({ page: '2', pageSize: '10', sort: 'n' });
    const result = await paginate(Item, {}, query, { sortable: ['n', 'createdAt'] });

    expect(result.meta).toEqual({ page: 2, pageSize: 10, total: 25, totalPages: 3 });
    expect(result.data.map((d) => d.n)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('defaults to newest first', async () => {
    await Item.insertMany([
      { n: 1, createdAt: new Date(2026, 0, 1) },
      { n: 2, createdAt: new Date(2026, 0, 2) },
    ]);
    const result = await paginate(Item, {}, paginationQuerySchema.parse({}), {
      sortable: ['createdAt'],
    });
    expect(result.data.map((d) => d.n)).toEqual([2, 1]);
  });

  it('rejects sorting on a field that is not allowed', async () => {
    const query = paginationQuerySchema.parse({ sort: 'secret' });
    await expect(paginate(Item, {}, query, { sortable: ['n'] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
