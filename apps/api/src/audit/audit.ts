import type { Request } from 'express';
import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';

/**
 * Every state-changing action in later phases calls `recordAudit`.
 * The table is append-only: a database trigger rejects UPDATE and DELETE.
 */
export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorId?: string | null;
  actorRole?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
  /** Pass the request to record its id and IP. */
  req?: Request;
}

/** Pass a transaction as `db` to write the entry atomically with the change it describes. */
export async function recordAudit(db: Pick<Db, 'insert'>, input: AuditInput) {
  const [entry] = await db
    .insert(auditLog)
    .values({
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      meta: input.meta ?? null,
      requestId: input.req?.id ? String(input.req.id) : null,
      ip: input.req?.ip ?? null,
    })
    .returning();
  return entry!;
}
