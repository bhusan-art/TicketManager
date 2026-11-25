import type { Model, QueryFilter } from 'mongoose';
import { buildPageMeta, type Paginated, type PaginationQuery } from '@ticketmanager/shared';
import { AppError } from './errors.js';

export interface PaginateOptions {
  /** Fields a caller may sort on. Anything else is rejected with 400. */
  sortable: readonly string[];
  /** Used when the caller gives no sort. Defaults to newest first. */
  defaultSort?: string;
  projection?: Record<string, 0 | 1>;
}

function toMongoSort(sort: string): Record<string, 1 | -1> {
  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  // _id as a tiebreaker keeps page boundaries stable when values repeat.
  return field === '_id' ? { _id: desc ? -1 : 1 } : { [field]: desc ? -1 : 1, _id: desc ? -1 : 1 };
}

/** Offset pagination for list endpoints. Returns `{ data, meta }`. */
export async function paginate<T>(
  model: Model<T>,
  filter: QueryFilter<T>,
  query: PaginationQuery,
  options: PaginateOptions,
): Promise<Paginated<T>> {
  const sort = query.sort ?? options.defaultSort ?? '-createdAt';
  const field = sort.replace(/^-/, '');
  if (field !== '_id' && !options.sortable.includes(field)) {
    throw new AppError('VALIDATION_FAILED', `Cannot sort by "${field}"`, {
      sortable: options.sortable,
    });
  }
  const skip = (query.page - 1) * query.pageSize;
  const [data, total] = await Promise.all([
    model
      .find(filter, options.projection)
      .sort(toMongoSort(sort))
      .skip(skip)
      .limit(query.pageSize)
      .lean<T[]>()
      .exec(),
    model.countDocuments(filter).exec(),
  ]);
  return { data, meta: buildPageMeta(query.page, query.pageSize, total) };
}
