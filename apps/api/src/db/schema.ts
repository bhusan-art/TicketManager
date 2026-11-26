import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  APPROVAL_STATUSES,
  CATEGORY_STATUSES,
  PAYMENT_MODES,
  PAYMENT_STATUSES,
  ROLES,
  USER_STATUSES,
  VOUCHER_EVENT_TYPES,
  type Role,
} from '@ticketmanager/shared';

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

/** Money columns hold integer paise. bigint so totals can't overflow; read back as JS numbers. */
const paise = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0);

/** Expense categories, managed by admins. */
export const categories = pgTable('categories', {
  id: pk(),
  name: text('name').notNull().unique(),
  description: text('description'),
  status: text('status', { enum: CATEGORY_STATUSES }).notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Gapless running numbers per document kind and year, e.g. EXP 2026 → EXP-2026-00001.
 * Taken inside the submitting transaction, so a rolled-back submit doesn't use up a number.
 */
export const documentCounters = pgTable(
  'document_counters',
  {
    kind: text('kind').notNull(),
    year: integer('year').notNull(),
    lastValue: integer('last_value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.year] })],
);

/** An expense claim. It has one or more lines; the total is the sum of the lines. */
export const vouchers = pgTable(
  'vouchers',
  {
    id: pk(),
    /** Assigned on submission. */
    number: text('number').unique(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => users.id),
    /** Department and manager as they were at submission. */
    departmentId: uuid('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    managerId: uuid('manager_id').references(() => users.id),
    purpose: text('purpose'),
    approvalStatus: text('approval_status', { enum: APPROVAL_STATUSES }).notNull().default('draft'),
    paymentStatus: text('payment_status', { enum: PAYMENT_STATUSES }).notNull().default('not_due'),
    totalPaise: paise('total_paise'),
    submittedAt: tstz('submitted_at'),
    /** Set when Accounts opens the voucher for review. After that the employee can't cancel. */
    accountsReviewStartedAt: tstz('accounts_review_started_at'),
    /** Sum of approved line amounts after the latest approval. */
    approvedTotalPaise: bigint('approved_total_paise', { mode: 'number' }),
    /** When the voucher reached a final decision (approved or rejected). */
    decidedAt: tstz('decided_at'),
    /** Sum of payments that were not reversed. Never more than approvedTotalPaise. */
    paidPaise: paise('paid_paise'),
    /** When the last instalment cleared the approved total. */
    paidAt: tstz('paid_at'),
    cancelledAt: tstz('cancelled_at'),
    cancelReason: text('cancel_reason'),
    /** Optimistic concurrency: every change bumps it, and writers must send the version they read. */
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('vouchers_employee_idx').on(t.employeeId, t.createdAt.desc()),
    index('vouchers_status_idx').on(t.approvalStatus),
    check('vouchers_total_non_negative', sql`${t.totalPaise} >= 0`),
    // The database itself refuses an overpayment.
    check(
      'vouchers_paid_within_approved',
      sql`${t.paidPaise} >= 0 and ${t.paidPaise} <= coalesce(${t.approvedTotalPaise}, 0)`,
    ),
  ],
);

export const voucherLines = pgTable(
  'voucher_lines',
  {
    id: pk(),
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => vouchers.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    categoryId: uuid('category_id').references(() => categories.id),
    expenseDate: date('expense_date', { mode: 'string' }),
    description: text('description'),
    vendorName: text('vendor_name'),
    /** What is claimed for this line, tax included. */
    amountPaise: paise('amount_paise'),
    isGst: boolean('is_gst').notNull().default(false),
    gstin: text('gstin'),
    invoiceNumber: text('invoice_number'),
    cgstPaise: paise('cgst_paise'),
    sgstPaise: paise('sgst_paise'),
    igstPaise: paise('igst_paise'),
    missingProofReason: text('missing_proof_reason'),
    /** Set by approvers. Null until the first approval; never more than amountPaise. */
    approvedPaise: bigint('approved_paise', { mode: 'number' }),
    reviewNote: text('review_note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('voucher_lines_voucher_idx').on(t.voucherId, t.position),
    check(
      'voucher_lines_approved_within_claim',
      sql`${t.approvedPaise} is null or (${t.approvedPaise} >= 0 and ${t.approvedPaise} <= ${t.amountPaise})`,
    ),
    check(
      'voucher_lines_amounts_non_negative',
      sql`${t.amountPaise} >= 0 and ${t.cgstPaise} >= 0 and ${t.sgstPaise} >= 0 and ${t.igstPaise} >= 0`,
    ),
  ],
);

/** Proof files (bills, invoices) attached to a voucher line. The bytes live in `files`. */
export const voucherAttachments = pgTable(
  'voucher_attachments',
  {
    id: pk(),
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => vouchers.id, { onDelete: 'cascade' }),
    lineId: uuid('line_id')
      .notNull()
      .references(() => voucherLines.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .unique()
      .references(() => files.id),
    createdAt: createdAt(),
  },
  (t) => [index('voucher_attachments_line_idx').on(t.lineId)],
);

/**
 * The voucher's activity timeline: every step and comment, in order. Written in the same
 * transaction as the change it describes. (The audit log keeps the full before/after record.)
 */
export const voucherEvents = pgTable(
  'voucher_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => vouchers.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid('actor_id').references(() => users.id),
    actorRole: text('actor_role', { enum: ROLES }),
    type: text('type', { enum: VOUCHER_EVENT_TYPES }).notNull(),
    fromStatus: text('from_status', { enum: APPROVAL_STATUSES }),
    toStatus: text('to_status', { enum: APPROVAL_STATUSES }),
    message: text('message'),
    meta: jsonb('meta'),
  },
  (t) => [
    index('voucher_events_voucher_idx').on(t.voucherId, t.id),
    index('voucher_events_actor_idx').on(t.actorId, t.type),
  ],
);

/**
 * Payments to employees against approved vouchers, one row per instalment. Rows are never
 * deleted; a mistaken payment is reversed (reversed_at set) and stops counting.
 */
export const payments = pgTable(
  'payments',
  {
    id: pk(),
    number: text('number').notNull().unique(),
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => vouchers.id),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    paidOn: date('paid_on', { mode: 'string' }).notNull(),
    mode: text('mode', { enum: PAYMENT_MODES }).notNull(),
    /** UTR, UPI reference or cheque number. */
    reference: text('reference'),
    note: text('note'),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    reversedAt: tstz('reversed_at'),
    reversedBy: uuid('reversed_by').references(() => users.id),
    reversalReason: text('reversal_reason'),
  },
  (t) => [
    index('payments_voucher_idx').on(t.voucherId, t.createdAt),
    index('payments_paid_on_idx').on(t.paidOn),
    // A UTR identifies one bank transfer, so it can't pay two things (unless reversed).
    uniqueIndex('payments_reference_active_key')
      .on(t.mode, t.reference)
      .where(sql`${t.reversedAt} is null and ${t.reference} is not null`),
    check('payments_amount_positive', sql`${t.amountPaise} > 0`),
    check(
      'payments_reversal_complete',
      sql`(${t.reversedAt} is null) = (${t.reversedBy} is null) and (${t.reversedAt} is null) = (${t.reversalReason} is null)`,
    ),
  ],
);
