import { asc, desc, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { buildPageMeta, type Paginated, type PaginationQuery } from '@ticketmanager/shared';
import { AppError } from './errors.js';

export interface PageRequest {
  orderBy: SQL[];
  limit: number;
  offset: number;
}

export interface PaginateOptions<T> {
  query: PaginationQuery;
  /** Fields a caller may sort on, mapped to their columns. Anything else is rejected with 400. */
  sortable: Record<string, AnyPgColumn>;
  /** Used when the caller gives no sort, e.g. '-createdAt'. */
  defaultSort: string;
  /** Added after the chosen sort so page boundaries stay stable when values repeat. */
  tiebreaker: AnyPgColumn;
  /** Runs the page query with the given ordering, limit and offset. */
  fetch: (page: PageRequest) => Promise<T[]>;
  /** Counts all matching rows (same filter, no limit). */
  count: () => Promise<number>;
}

/** Offset pagination for list endpoints. Returns `{ data, meta }`. */
export async function paginate<T>(options: PaginateOptions<T>): Promise<Paginated<T>> {
  const { query } = options;
  const sort = query.sort ?? options.defaultSort;
  const descending = sort.startsWith('-');
  const field = descending ? sort.slice(1) : sort;
  const column = options.sortable[field];
  if (!column) {
    throw new AppError('VALIDATION_FAILED', `Cannot sort by "${field}"`, {
      sortable: Object.keys(options.sortable),
    });
  }
  const dir = descending ? desc : asc;
  const [data, total] = await Promise.all([
    options.fetch({
      orderBy: [dir(column), dir(options.tiebreaker)],
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    }),
    options.count(),
  ]);
  return { data, meta: buildPageMeta(query.page, query.pageSize, total) };
}
