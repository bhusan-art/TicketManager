import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { ROLES, USER_STATUSES, type Role } from '@ticketmanager/shared';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const pk = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const departments = pgTable('departments', {
  id: pk(),
  name: text('name').notNull().unique(),
  code: text('code').unique(),
  headId: uuid('head_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** People who can sign in. Only an admin creates users; nobody can sign up. */
export const users = pgTable(
  'users',
  {
    id: pk(),
    /** Always stored lowercased. */
    email: text('email').notNull(),
    name: text('name').notNull(),
    employeeCode: text('employee_code').unique(),
    designation: text('designation'),
    departmentId: uuid('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    managerId: uuid('manager_id').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    roles: text('roles', { enum: ROLES }).array().notNull().$type<Role[]>(),
    status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
    passwordHash: text('password_hash'),
    googleSub: text('google_sub').unique(),
    lastActiveRole: text('last_active_role', { enum: ROLES }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: tstz('locked_until'),
    passwordChangedAt: tstz('password_changed_at'),
    lastLoginAt: tstz('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('users_roles_not_empty', sql`cardinality(${t.roles}) > 0`),
    index('users_manager_idx').on(t.managerId),
    index('users_department_idx').on(t.departmentId),
  ],
);

/**
 * One row per refresh token. Tokens rotate on every refresh; a family groups the tokens of one
 * sign-in, so reuse of an old token revokes the whole family.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    activeRole: text('active_role', { enum: ROLES }).notNull(),
    expiresAt: tstz('expires_at').notNull(),
    replacedAt: tstz('replaced_at'),
    revokedAt: tstz('revoked_at'),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_family_idx').on(t.familyId)],
);

/** Single-use links for password reset and invites. Only a hash of the token is stored. */
export const passwordTokens = pgTable(
  'password_tokens',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    purpose: text('purpose', { enum: ['reset', 'invite'] }).notNull(),
    expiresAt: tstz('expires_at').notNull(),
    usedAt: tstz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('password_tokens_user_idx').on(t.userId)],
);

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
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    // Users are deactivated, never deleted, so this reference always resolves.
    actorId: uuid('actor_id').references(() => users.id),
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
  id: pk(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  data: bytea('data').notNull(),
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});
