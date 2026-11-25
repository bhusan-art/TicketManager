import { sql } from 'drizzle-orm';
import {
  bigserial,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** Stored responses for Idempotency-Key retries. Rows older than 24 hours are pruned. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: text('id').primaryKey(),
    requestHash: text('request_hash').notNull(),
    status: text('status', { enum: ['in_progress', 'completed'] }).notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: createdAt(),
  },
  (t) => [index('idempotency_keys_created_at_idx').on(t.createdAt)],
);

/**
 * Append-only audit trail. A database trigger (see the migrations) rejects UPDATE and DELETE.
 * actor_id becomes a foreign key to users in Phase 1.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid('actor_id'),
    actorRole: text('actor_role'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    meta: jsonb('meta'),
    requestId: text('request_id'),
    ip: text('ip'),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.entityType, t.entityId, t.at.desc()),
    index('audit_log_actor_idx').on(t.actorId, t.at.desc()),
    index('audit_log_at_idx').on(t.at.desc()),
  ],
);

/** Uploaded files (receipts, proofs, exports) kept in the database itself. */
export const files = pgTable('files', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  data: bytea('data').notNull(),
  uploadedBy: uuid('uploaded_by'),
  createdAt: createdAt(),
});
