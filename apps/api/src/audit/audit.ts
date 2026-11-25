import type { Request } from 'express';
import mongoose, { Schema, type Types } from 'mongoose';

/**
 * Append-only audit trail. Every state-changing action in later phases calls `recordAudit`.
 * The model blocks updates and deletes so entries can't be edited after the fact.
 */

export interface AuditEntry {
  at: Date;
  actorId?: Types.ObjectId | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
  requestId?: string | null;
  ip?: string | null;
}

const auditSchema = new Schema<AuditEntry>(
  {
    at: { type: Date, default: Date.now, required: true },
    actorId: { type: Schema.Types.ObjectId, default: null },
    actorRole: { type: String, default: null },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, default: null },
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    meta: Schema.Types.Mixed,
    requestId: { type: String, default: null },
    ip: { type: String, default: null },
  },
  { collection: 'audit_log', versionKey: false },
);

auditSchema.index({ entityType: 1, entityId: 1, at: -1 });
auditSchema.index({ actorId: 1, at: -1 });
auditSchema.index({ at: -1 });

const blockMutation = function () {
  throw new Error('Audit log entries are append-only');
};
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const) {
  auditSchema.pre(op, blockMutation);
}

export const AuditLog =
  (mongoose.models.AuditLog as mongoose.Model<AuditEntry> | undefined) ??
  mongoose.model<AuditEntry>('AuditLog', auditSchema);

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | Types.ObjectId | null;
  actorId?: string | Types.ObjectId | null;
  actorRole?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
  /** Pass the request to record its id and IP. */
  req?: Request;
  /** Pass a session to write the entry in the same transaction as the change. */
  session?: mongoose.ClientSession;
}

export async function recordAudit(input: AuditInput) {
  const [entry] = await AuditLog.create(
    [
      {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ? String(input.entityId) : null,
        actorId: input.actorId ?? null,
        actorRole: input.actorRole ?? null,
        before: input.before,
        after: input.after,
        meta: input.meta,
        requestId: input.req?.id ? String(input.req.id) : null,
        ip: input.req?.ip ?? null,
      },
    ],
    { session: input.session },
  );
  return entry!;
}
