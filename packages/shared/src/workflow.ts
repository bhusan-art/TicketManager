import { z } from 'zod';
import type { Ref } from './auth.js';
import type { Role } from './roles.js';
import type { ApprovalStatus } from './vouchers.js';
import type { VoucherSummary } from './vouchers.js';

/**
 * The approval chain. Each review stage has one kind of approver, a "query" status where it waits
 * for the employee's answer, and a rejected status.
 *
 *   Employee's claim:  pending_manager → pending_accounts → approved / partially approved
 *   Manager's or director's own claim:   pending_accounts → approved
 *   Accounts user's own claim:           pending_director → approved
 *
 * At any stage the approver can also query (ask the employee; the answer comes back to the same
 * stage), return (send back for changes; the employee edits and resubmits from the start) or
 * reject (final).
 */
export const REVIEW_STAGES = {
  pending_manager: { approver: 'manager', query: 'manager_query', rejected: 'manager_rejected' },
  pending_accounts: {
    approver: 'accounts',
    query: 'accounts_query',
    rejected: 'accounts_rejected',
  },
  pending_director: {
    approver: 'director',
    query: 'director_query',
    rejected: 'director_rejected',
  },
} as const satisfies Record<
  string,
  { approver: Role; query: ApprovalStatus; rejected: ApprovalStatus }
>;
export type ReviewStage = keyof typeof REVIEW_STAGES;
export const REVIEW_STAGE_NAMES = Object.keys(REVIEW_STAGES) as ReviewStage[];

export const isReviewStage = (s: ApprovalStatus): s is ReviewStage => s in REVIEW_STAGES;

/** The stage a query status returns to once the employee answers. */
export function stageOfQuery(status: ApprovalStatus): ReviewStage | null {
  return REVIEW_STAGE_NAMES.find((s) => REVIEW_STAGES[s].query === status) ?? null;
}

export const QUERY_STATUSES = REVIEW_STAGE_NAMES.map((s) => REVIEW_STAGES[s].query);

/** Every step a person can take on a voucher. */
export const VOUCHER_ACTIONS = [
  'edit',
  'submit',
  'cancel',
  'delete',
  'approve',
  'query',
  'return',
  'reject',
  'answer',
  'comment',
  'pay',
] as const;
export type VoucherAction = (typeof VOUCHER_ACTIONS)[number];
export type VoucherPermissions = Record<VoucherAction, boolean>;

const message = (what: string) =>
  z.string().trim().min(3, `Write ${what} (at least 3 characters)`).max(1000);

const version = z.number().int().min(1);

/** Approve, optionally allowing less than claimed on some lines. */
export const approveVoucherSchema = z.object({
  version,
  note: z
    .string()
    .trim()
    .max(1000)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  lines: z
    .array(
      z.object({
        id: z.uuid(),
        approvedPaise: z.number().int().min(0),
        note: z
          .string()
          .trim()
          .max(500)
          .transform((v) => (v === '' ? null : v))
          .nullable()
          .optional(),
      }),
    )
    .max(50)
    .default([]),
});
export type ApproveVoucherInput = z.input<typeof approveVoucherSchema>;

export const queryVoucherSchema = z.object({ version, message: message('your question') });
export const returnVoucherSchema = z.object({ version, message: message('what needs to change') });
export const rejectVoucherSchema = z.object({ version, message: message('the reason') });
export const answerQuerySchema = z.object({ version, message: message('your answer') });
export const commentSchema = z.object({ message: message('a comment') });

export const VOUCHER_EVENT_TYPES = [
  'created',
  'submitted',
  'resubmitted',
  'review_started',
  'approved',
  'queried',
  'answered',
  'returned',
  'rejected',
  'cancelled',
  'comment',
  'attachment_added',
  'payment_recorded',
  'payment_reversed',
  'followed_up',
] as const;
export type VoucherEventType = (typeof VOUCHER_EVENT_TYPES)[number];

/** One entry on a voucher's activity timeline. Comments are events too. */
export interface VoucherEvent {
  id: number;
  type: VoucherEventType;
  at: string;
  actor: Ref | null;
  actorRole: Role | null;
  fromStatus: ApprovalStatus | null;
  toStatus: ApprovalStatus | null;
  message: string | null;
  meta: Record<string, unknown> | null;
}

// ---- Approval queues ----

export const APPROVAL_VIEWS = ['pending', 'queried', 'done'] as const;
export type ApprovalView = (typeof APPROVAL_VIEWS)[number];

export const approvalQueueQuerySchema = z.object({
  view: z.enum(APPROVAL_VIEWS).default('pending'),
  search: z.string().trim().max(100).optional(),
  /** A project's id, or "none" for vouchers without a project. */
  projectId: z.union([z.uuid(), z.literal('none')]).optional(),
});

export interface ApprovalQueueItem extends VoucherSummary {
  employee: Ref & { employeeCode: string | null };
  department: Ref | null;
  /** Accounts has opened it. */
  reviewStarted: boolean;
}
