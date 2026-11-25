import { describe, expect, it } from 'vitest';
import { buildPageMeta, paginationQuerySchema, PAGE_SIZE_MAX } from './pagination.js';

describe('paginationQuerySchema', () => {
  it('applies defaults', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
  });

  it('coerces query-string numbers', () => {
    expect(paginationQuerySchema.parse({ page: '3', pageSize: '50' })).toMatchObject({
      page: 3,
      pageSize: 50,
    });
  });

  it('rejects oversize pages and bad sort fields', () => {
    expect(paginationQuerySchema.safeParse({ pageSize: PAGE_SIZE_MAX + 1 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ sort: '$where' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ sort: '-createdAt' }).success).toBe(true);
  });
});

describe('buildPageMeta', () => {
  it('computes total pages', () => {
    expect(buildPageMeta(1, 20, 41)).toEqual({ page: 1, pageSize: 20, total: 41, totalPages: 3 });
    expect(buildPageMeta(1, 20, 0).totalPages).toBe(0);
  });
});
