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
  ADVANCE_EVENT_TYPES,
  ADVANCE_STATUSES,
  ADVANCE_TRANSACTION_KINDS,
  APPROVAL_STATUSES,
  BACKUP_RUN_STATUSES,
  CATEGORY_STATUSES,
  EMAIL_KINDS,
  EMAIL_STATUSES,
  EMPLOYMENT_TYPES,
  EXPORT_STATUSES,
  NOTIFICATION_ENTITIES,
  PAYMENT_MODES,
  PAYMENT_STATUSES,
  PROJECT_STATUSES,
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
    /** WhatsApp mobile number as international digits (919876543210). */
    whatsappNumber: text('whatsapp_number'),
    employmentType: text('employment_type', { enum: EMPLOYMENT_TYPES })
      .notNull()
      .default('regular'),
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
    /** "Keep me signed in": renewals extend it. Otherwise it ends at the first expiry. */
    remember: boolean('remember').notNull().default(true),
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
/** Company projects that vouchers are booked to. Never deleted; made inactive instead. */
export const projects = pgTable('projects', {
  id: pk(),
  name: text('name').notNull().unique(),
  code: text('code').unique(),
  description: text('description'),
  status: text('status', { enum: PROJECT_STATUSES }).notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

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
    /** The company project the expense was for. */
    projectId: uuid('project_id').references((): AnyPgColumn => projects.id),
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
    /**
     * The advance this claim settles. One column, so a voucher can be allocated to only one
     * advance; such a voucher is never paid on its own (checked below).
     */
    advanceId: uuid('advance_id').references((): AnyPgColumn => advances.id),
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
    // A claim settled from an advance is never paid as well.
    check('vouchers_advance_not_paid', sql`${t.advanceId} is null or ${t.paidPaise} = 0`),
    index('vouchers_advance_idx').on(t.advanceId),
    index('vouchers_project_idx').on(t.projectId),
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

/** Advances: money paid to an employee before they spend it, settled by their approved claims. */
export const advances = pgTable(
  'advances',
  {
    id: pk(),
    /** ADV-2026-00001, given on submit. */
    number: text('number').unique(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => users.id),
    departmentId: uuid('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    managerId: uuid('manager_id').references(() => users.id),
    purpose: text('purpose').notNull(),
    notes: text('notes'),
    status: text('status', { enum: ADVANCE_STATUSES }).notNull().default('draft'),
    requestedPaise: bigint('requested_paise', { mode: 'number' }).notNull(),
    approvedPaise: bigint('approved_paise', { mode: 'number' }),
    expectedDate: date('expected_date', { mode: 'string' }).notNull(),
    settleBy: date('settle_by', { mode: 'string' }),
    submittedAt: tstz('submitted_at'),
    decidedAt: tstz('decided_at'),
    disbursedAt: tstz('disbursed_at'),
    closedAt: tstz('closed_at'),
    cancelReason: text('cancel_reason'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('advances_employee_idx').on(t.employeeId, t.createdAt.desc()),
    index('advances_status_idx').on(t.status),
    check('advances_requested_positive', sql`${t.requestedPaise} > 0`),
    check(
      'advances_approved_within_requested',
      sql`${t.approvedPaise} is null or (${t.approvedPaise} > 0 and ${t.approvedPaise} <= ${t.requestedPaise})`,
    ),
  ],
);

/**
 * Money moving for an advance: the payout, money the employee returns, and any shortfall the
 * company pays. Never deleted; mistakes are reversed with a reason.
 */
export const advanceTransactions = pgTable(
  'advance_transactions',
  {
    id: pk(),
    advanceId: uuid('advance_id')
      .notNull()
      .references(() => advances.id),
    kind: text('kind', { enum: ADVANCE_TRANSACTION_KINDS }).notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    paidOn: date('paid_on', { mode: 'string' }).notNull(),
    mode: text('mode', { enum: PAYMENT_MODES }).notNull(),
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
    index('advance_transactions_advance_idx').on(t.advanceId, t.createdAt),
    uniqueIndex('advance_transactions_reference_active_key')
      .on(t.mode, t.reference)
      .where(sql`${t.reversedAt} is null and ${t.reference} is not null`),
    // One payout per advance (a reversed one doesn't count).
    uniqueIndex('advance_transactions_one_disbursement')
      .on(t.advanceId)
      .where(sql`${t.kind} = 'disbursement' and ${t.reversedAt} is null`),
    check('advance_transactions_amount_positive', sql`${t.amountPaise} > 0`),
    check(
      'advance_transactions_reversal_complete',
      sql`(${t.reversedAt} is null) = (${t.reversedBy} is null) and (${t.reversedAt} is null) = (${t.reversalReason} is null)`,
    ),
  ],
);

export const advanceEvents = pgTable(
  'advance_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    advanceId: uuid('advance_id')
      .notNull()
      .references(() => advances.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid('actor_id').references(() => users.id),
    actorRole: text('actor_role', { enum: ROLES }),
    type: text('type', { enum: ADVANCE_EVENT_TYPES }).notNull(),
    fromStatus: text('from_status', { enum: ADVANCE_STATUSES }),
    toStatus: text('to_status', { enum: ADVANCE_STATUSES }),
    message: text('message'),
    meta: jsonb('meta'),
  },
  (t) => [index('advance_events_advance_idx').on(t.advanceId, t.id)],
);

/** Company-wide settings, one JSON value per key. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});

/** In-app notifications: one row per person per event. Written in the workflow's transaction. */
export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    entityType: text('entity_type', { enum: NOTIFICATION_ENTITIES }),
    entityId: uuid('entity_id'),
    /** The event that caused it, e.g. "queried". */
    eventType: text('event_type'),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** The role the person needs active to act on it; the app switches to it when opened. */
    role: text('role', { enum: ROLES }),
    createdAt: createdAt(),
    readAt: tstz('read_at'),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.createdAt.desc()),
    index('notifications_unread_idx')
      .on(t.userId)
      .where(sql`${t.readAt} is null`),
  ],
);

/**
 * Every email the app sends, written in the same transaction as the change that causes it. The
 * worker delivers due rows and retries failures with backoff; this table is the delivery log.
 */
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: pk(),
    kind: text('kind', { enum: EMAIL_KINDS }).notNull(),
    to: text('to').array().notNull(),
    cc: text('cc')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    subject: text('subject').notNull(),
    text: text('text').notNull(),
    /** App path the worker turns into a full link (it knows the public URL). */
    link: text('link'),
    status: text('status', { enum: EMAIL_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: tstz('next_attempt_at').notNull().defaultNow(),
    lastError: text('last_error'),
    messageId: text('message_id'),
    sentAt: tstz('sent_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('email_outbox_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index('email_outbox_created_idx').on(t.createdAt.desc()),
  ],
);

/**
 * Bulk ZIP exports of vouchers. The ZIP itself is a row in `files`; it is deleted when the export
 * expires, and the job row stays as history.
 */
export const exportJobs = pgTable(
  'export_jobs',
  {
    id: pk(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    /** The active role when it was requested; it decides which vouchers it may contain. */
    role: text('role', { enum: ROLES }).notNull(),
    filters: jsonb('filters').notNull(),
    includeProofs: boolean('include_proofs').notNull().default(true),
    status: text('status', { enum: EXPORT_STATUSES }).notNull().default('queued'),
    filename: text('filename').notNull(),
    voucherCount: integer('voucher_count'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    error: text('error'),
    downloads: integer('downloads').notNull().default(0),
    /** sha256 of the current shareable link's token; a new link replaces the old one. */
    linkTokenHash: text('link_token_hash').unique(),
    linkExpiresAt: tstz('link_expires_at'),
    startedAt: tstz('started_at'),
    completedAt: tstz('completed_at'),
    expiresAt: tstz('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [index('export_jobs_requested_by_idx').on(t.requestedBy, t.createdAt.desc())],
);

/**
 * Database backups. The backup service (deploy/backup) adds a row after each nightly dump, so
 * Admins can see on the dashboard that backups are running.
 */
export const backupRuns = pgTable(
  'backup_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    status: text('status', { enum: BACKUP_RUN_STATUSES }).notNull(),
    file: text('file'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('backup_runs_finished_at_idx').on(t.finishedAt.desc())],
);
