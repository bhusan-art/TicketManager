import { z } from 'zod';
import type { Ref } from './auth.js';
import { MAX_AMOUNT_PAISE } from './money.js';
import { PAYMENT_MODES, REFERENCE_LABELS, type PaymentMode } from './payments.js';
import type { Role } from './roles.js';
import { ISO_DATE, type ApprovalStatus, type VoucherEmployee } from './vouchers.js';

/**
 * Advances: money given to an employee before they spend it. An advance is not an expense. The
 * employee later tags their expense vouchers to it, and the approved amounts of those vouchers
 * settle it. Whatever is left over is returned by the employee; any shortfall is paid to them.
 *
 *   draft → pending_manager → pending_accounts → approved → open (disbursed) → closed
 *   A manager's or director's own request starts at pending_accounts; an Accounts user's own
 *   request goes to pending_director. Any approver can return (edit and resubmit) or reject.
 */
export const ADVANCE_STATUSES = [
  'draft',
  'pending_manager',
  'pending_accounts',
  'pending_director',
  'returned',
  'approved',
  'open',
  'closed',
  'manager_rejected',
  'accounts_rejected',
  'director_rejected',
  'cancelled',
] as const;
export type AdvanceStatus = (typeof ADVANCE_STATUSES)[number];

export const ADVANCE_STATUS_LABELS: Record<AdvanceStatus, string> = {
  draft: 'Draft',
  pending_manager: 'Pending manager',
  pending_accounts: 'Pending accounts',
  pending_director: 'Pending director',
  returned: 'Returned',
  approved: 'Approved, to disburse',
  open: 'Open',
  closed: 'Settled',
  manager_rejected: 'Rejected by manager',
  accounts_rejected: 'Rejected by Accounts',
  director_rejected: 'Rejected by Director',
  cancelled: 'Cancelled',
};

export const ADVANCE_REVIEW_STAGES = {
  pending_manager: { approver: 'manager', rejected: 'manager_rejected' },
  pending_accounts: { approver: 'accounts', rejected: 'accounts_rejected' },
  pending_director: { approver: 'director', rejected: 'director_rejected' },
} as const satisfies Record<string, { approver: Role; rejected: AdvanceStatus }>;
export type AdvanceReviewStage = keyof typeof ADVANCE_REVIEW_STAGES;
export const isAdvanceReviewStage = (s: AdvanceStatus): s is AdvanceReviewStage =>
  s in ADVANCE_REVIEW_STAGES;

/** A person can have only one of these at a time (decision: one active advance). */
export const ACTIVE_ADVANCE_STATUSES: readonly AdvanceStatus[] = [
  'pending_manager',
  'pending_accounts',
  'pending_director',
  'returned',
  'approved',
  'open',
];

/** Days after the expected expense date by which an open advance must be settled. */
export const SETTLEMENT_DAYS = 30;

export const ADVANCE_ACTIONS = [
  'edit',
  'submit',
  'cancel',
  'delete',
  'approve',
  'return',
  'reject',
  'disburse',
  'settle',
  'close',
] as const;
export type AdvanceAction = (typeof ADVANCE_ACTIONS)[number];
export type AdvancePermissions = Record<AdvanceAction, boolean>;

const amount = z
  .number()
  .int('Amounts are whole paise')
  .min(1, 'Enter an amount above zero')
  .max(MAX_AMOUNT_PAISE);
const version = z.number().int().min(1);
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const message = (what: string) =>
  z.string().trim().min(3, `Write ${what} (at least 3 characters)`).max(1000);

export const advanceInputSchema = z.object({
  purpose: z.string().trim().min(3, 'Enter the purpose of this advance').max(200),
  requestedPaise: amount,
  /** When the employee expects to spend the money. */
  expectedDate: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD'),
  notes: optional(1000),
});
export type AdvanceInput = z.input<typeof advanceInputSchema>;
export const updateAdvanceSchema = advanceInputSchema.extend({ version });

export const advanceActionSchema = z.object({ version });
export const cancelAdvanceSchema = z.object({ version, reason: message('the reason') });

/** Approve. An approver may approve less than was asked for. */
export const approveAdvanceSchema = z.object({
  version,
  approvedPaise: amount.optional(),
  note: optional(1000),
});
export const returnAdvanceSchema = z.object({ version, message: message('what needs to change') });
export const rejectAdvanceSchema = z.object({ version, message: message('the reason') });

/** Money moving for an advance, outside the app: paid out, returned, or the shortfall paid. */
export const ADVANCE_TRANSACTION_KINDS = ['disbursement', 'return', 'top_up'] as const;
export type AdvanceTransactionKind = (typeof ADVANCE_TRANSACTION_KINDS)[number];

export const ADVANCE_TRANSACTION_LABELS: Record<AdvanceTransactionKind, string> = {
  disbursement: 'Disbursed',
  return: 'Returned by employee',
  top_up: 'Shortfall paid',
};

const transactionFields = {
  version,
  amountPaise: amount,
  paidOn: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD'),
  mode: z.enum(PAYMENT_MODES),
  reference: z
    .string()
    .trim()
    .toUpperCase()
    .max(40)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  note: optional(500),
};
const needsReference = (
  p: { mode: PaymentMode; reference?: string | null },
  ctx: z.RefinementCtx,
) => {
  const label = REFERENCE_LABELS[p.mode];
  if (label && !p.reference) {
    ctx.addIssue({ code: 'custom', path: ['reference'], message: `Enter the ${label}` });
  }
};

export const disburseAdvanceSchema = z.object(transactionFields).superRefine(needsReference);
export type DisburseAdvanceInput = z.input<typeof disburseAdvanceSchema>;

export const settlementTransactionSchema = z
  .object({ ...transactionFields, kind: z.enum(['return', 'top_up']) })
  .superRefine(needsReference);
export type SettlementTransactionInput = z.input<typeof settlementTransactionSchema>;

export const reverseAdvanceTransactionSchema = z.object({
  version,
  reason: z.string().trim().min(3, 'Say why this is being reversed').max(500),
});
export const closeAdvanceSchema = z.object({ version, note: optional(1000) });

export interface AdvanceTransaction {
  id: string;
  kind: AdvanceTransactionKind;
  amountPaise: number;
  paidOn: string;
  mode: PaymentMode;
  reference: string | null;
  note: string | null;
  recordedBy: Ref | null;
  createdAt: string;
  reversedAt: string | null;
  reversedBy: Ref | null;
  reversalReason: string | null;
}

/** A voucher tagged to the advance. */
export interface AdvanceVoucher {
  id: string;
  number: string | null;
  purpose: string | null;
  approvalStatus: ApprovalStatus;
  totalPaise: number;
  /** Counted only once the voucher has its final approval. */
  approvedTotalPaise: number | null;
  /** Counts toward the settlement. */
  counted: boolean;
  /** Submitted and still being reviewed: the advance can't close yet. */
  inReview: boolean;
}

/**
 * The settlement arithmetic, in paise.
 * balance = disbursed − approved expenses − returned + shortfall paid.
 * Above zero the employee owes the company; below zero the company owes the employee.
 */
export interface AdvanceSettlement {
  disbursedPaise: number;
  approvedExpensesPaise: number;
  inReviewCount: number;
  inReviewPaise: number;
  returnedPaise: number;
  topUpPaise: number;
  balancePaise: number;
  /** What the employee still has to return. */
  dueBackPaise: number;
  /** What the company still has to pay the employee. */
  payablePaise: number;
}

/** Pure settlement arithmetic, shared by the API and the web page. */
export function settle(input: {
  transactions: Pick<AdvanceTransaction, 'kind' | 'amountPaise' | 'reversedAt'>[];
  vouchers: Pick<AdvanceVoucher, 'counted' | 'inReview' | 'approvedTotalPaise' | 'totalPaise'>[];
}): AdvanceSettlement {
  const sum = (kind: AdvanceTransactionKind) =>
    input.transactions
      .filter((t) => t.kind === kind && !t.reversedAt)
      .reduce((s, t) => s + t.amountPaise, 0);
  const counted = input.vouchers.filter((v) => v.counted);
  const pending = input.vouchers.filter((v) => v.inReview);
  const disbursedPaise = sum('disbursement');
  const approvedExpensesPaise = counted.reduce((s, v) => s + (v.approvedTotalPaise ?? 0), 0);
  const returnedPaise = sum('return');
  const topUpPaise = sum('top_up');
  const balancePaise = disbursedPaise - approvedExpensesPaise - returnedPaise + topUpPaise;
  return {
    disbursedPaise,
    approvedExpensesPaise,
    inReviewCount: pending.length,
    inReviewPaise: pending.reduce((s, v) => s + v.totalPaise, 0),
    returnedPaise,
    topUpPaise,
    balancePaise,
    dueBackPaise: Math.max(balancePaise, 0),
    payablePaise: Math.max(-balancePaise, 0),
  };
}

/** The date by which an advance must be settled: 30 days after the later of the expected date and the payout. */
export function settleByDate(expectedDate: string, disbursedOn: string): string {
  const base = expectedDate > disbursedOn ? expectedDate : disbursedOn;
  const [y, m, d] = base.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + SETTLEMENT_DAYS)).toISOString().slice(0, 10);
}

export const ADVANCE_EVENT_TYPES = [
  'created',
  'submitted',
  'resubmitted',
  'approved',
  'returned',
  'rejected',
  'cancelled',
  'disbursed',
  'return_recorded',
  'top_up_recorded',
  'transaction_reversed',
  'closed',
] as const;
export type AdvanceEventType = (typeof ADVANCE_EVENT_TYPES)[number];

export interface AdvanceEvent {
  id: number;
  type: AdvanceEventType;
  at: string;
  actor: Ref | null;
  actorRole: Role | null;
  fromStatus: AdvanceStatus | null;
  toStatus: AdvanceStatus | null;
  message: string | null;
  meta: Record<string, unknown> | null;
}

export interface AdvanceDetail {
  id: string;
  /** ADV-2026-00001, once submitted. */
  number: string | null;
  purpose: string;
  notes: string | null;
  status: AdvanceStatus;
  requestedPaise: number;
  /** What the latest approver allowed. */
  approvedPaise: number | null;
  expectedDate: string;
  /** Set when the money is paid out. */
  settleBy: string | null;
  overdue: boolean;
  version: number;
  employee: VoucherEmployee;
  department: Ref | null;
  manager: Ref | null;
  submittedAt: string | null;
  decidedAt: string | null;
  disbursedAt: string | null;
  closedAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  waitingOn: string | null;
  transactions: AdvanceTransaction[];
  vouchers: AdvanceVoucher[];
  settlement: AdvanceSettlement;
  events: AdvanceEvent[];
  can: AdvancePermissions;
}

export interface AdvanceSummary {
  id: string;
  number: string | null;
  purpose: string;
  status: AdvanceStatus;
  requestedPaise: number;
  approvedPaise: number | null;
  expectedDate: string;
  settleBy: string | null;
  overdue: boolean;
  employee: Ref & { employeeCode: string | null };
  department: Ref | null;
  submittedAt: string | null;
  createdAt: string;
  /** Only for open and settled advances. */
  settlement: AdvanceSettlement | null;
}

/** Which advances a list shows. `mine` is the caller's own; the rest are for approvers. */
export const ADVANCE_VIEWS = ['mine', 'review', 'disburse', 'open', 'closed', 'all'] as const;
export type AdvanceView = (typeof ADVANCE_VIEWS)[number];

export const advanceListQuerySchema = z.object({
  view: z.enum(ADVANCE_VIEWS).default('mine'),
  search: z.string().trim().max(100).optional(),
  overdue: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

/** An open advance the employee can tag a voucher to. */
export interface LinkableAdvance {
  id: string;
  number: string;
  purpose: string;
  disbursedPaise: number;
  settleBy: string | null;
}

// ---- Settings ----

export const advanceSettingsSchema = z.object({
  /** Largest advance anyone may request. Null means no limit. */
  maxAdvancePaise: amount.nullable(),
});
export type AdvanceSettings = z.infer<typeof advanceSettingsSchema>;
