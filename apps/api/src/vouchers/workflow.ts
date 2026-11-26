import {
  CANCELLABLE_STATUSES,
  REVIEW_STAGES,
  isReviewStage,
  stageOfQuery,
  type ApprovalStatus,
  type VoucherAction,
  type VoucherPermissions,
} from '@ticketmanager/shared';
import type { AuthContext } from '../auth/middleware.js';

/**
 * The approval state machine, kept free of the database so every allowed and forbidden step can
 * be tested directly. Routes ask `permissions()` before they change anything.
 */

/** The fields of a voucher the rules look at. */
export interface WorkflowVoucher {
  employeeId: string;
  managerId: string | null;
  approvalStatus: ApprovalStatus;
  number: string | null;
  submittedAt: Date | string | null;
  accountsReviewStartedAt: Date | string | null;
  approvedTotalPaise?: number | null;
  paidPaise?: number;
  /** Tagged to an advance: settled there, never paid on its own. */
  advanceId?: string | null;
}

type Caller = Pick<AuthContext, 'userId' | 'activeRole'>;

/** Statuses in which the employee can change lines and proofs. */
export const EDITABLE_STATUSES: readonly ApprovalStatus[] = ['draft', 'returned'];

/**
 * Who may see a voucher: its employee, the manager it was sent to, and (once submitted) anyone
 * working as Accounts or Director.
 */
export function canView(caller: Caller, v: WorkflowVoucher): boolean {
  if (v.employeeId === caller.userId) return true;
  if (v.managerId === caller.userId) return true;
  if (!v.submittedAt) return false;
  return caller.activeRole === 'accounts' || caller.activeRole === 'director';
}

/**
 * Whether the caller is the approver for the voucher's current stage. Nobody ever approves their
 * own claim, whatever roles they hold.
 */
export function isApprover(caller: Caller, v: WorkflowVoucher): boolean {
  if (v.employeeId === caller.userId) return false;
  if (!isReviewStage(v.approvalStatus)) return false;
  const { approver } = REVIEW_STAGES[v.approvalStatus];
  if (caller.activeRole !== approver) return false;
  // A manager only reviews the claims sent to them.
  if (approver === 'manager') return v.managerId === caller.userId;
  return true;
}

export function permissions(caller: Caller, v: WorkflowVoucher): VoucherPermissions {
  const owner = v.employeeId === caller.userId;
  const editable = owner && EDITABLE_STATUSES.includes(v.approvalStatus);
  const approver = isApprover(caller, v);
  return {
    edit: editable,
    submit: editable,
    cancel: owner && CANCELLABLE_STATUSES.includes(v.approvalStatus) && !v.accountsReviewStartedAt,
    delete: owner && v.approvalStatus === 'draft' && !v.number,
    approve: approver,
    query: approver,
    return: approver,
    reject: approver,
    answer: owner && stageOfQuery(v.approvalStatus) !== null,
    comment: canView(caller, v) && v.approvalStatus !== 'draft',
    pay: canPay(caller, v),
  };
}

/**
 * Accounts pays approved claims, never their own, never more than was approved, and never a claim
 * that an advance settles.
 */
export function canPay(caller: Caller, v: WorkflowVoucher): boolean {
  return (
    caller.activeRole === 'accounts' &&
    v.employeeId !== caller.userId &&
    !v.advanceId &&
    isFinalApproval(v.approvalStatus) &&
    (v.paidPaise ?? 0) < (v.approvedTotalPaise ?? 0)
  );
}

export const can = (caller: Caller, v: WorkflowVoucher, action: VoucherAction) =>
  permissions(caller, v)[action];

/**
 * The status after an approver's or employee's step. `partial` says whether the approved total is
 * below the claim. Throws if the step is not possible from this status (callers check
 * `permissions` first, so this guards against bugs).
 */
export function nextStatus(
  status: ApprovalStatus,
  action: 'approve' | 'query' | 'return' | 'reject' | 'answer',
  partial = false,
): ApprovalStatus {
  if (action === 'answer') {
    const stage = stageOfQuery(status);
    if (!stage) throw new Error(`Cannot answer from ${status}`);
    return stage;
  }
  if (!isReviewStage(status)) throw new Error(`Cannot ${action} from ${status}`);
  const stage = REVIEW_STAGES[status];
  switch (action) {
    case 'approve':
      // The manager's approval passes the claim on to Accounts; Accounts and the Director decide.
      if (status === 'pending_manager') return 'pending_accounts';
      return partial ? 'partially_approved' : 'approved';
    case 'query':
      return stage.query;
    case 'return':
      return 'returned';
    case 'reject':
      return stage.rejected;
  }
}

/** Final approval statuses: the claim moves on to payment. */
export const isFinalApproval = (s: ApprovalStatus) =>
  s === 'approved' || s === 'partially_approved';

/** Who the voucher is waiting on, for display. */
export function waitingOn(v: WorkflowVoucher, managerName: string | null): string | null {
  switch (v.approvalStatus) {
    case 'draft':
    case 'returned':
    case 'manager_query':
    case 'accounts_query':
    case 'director_query':
      return 'Employee';
    case 'pending_manager':
      return managerName ?? 'Manager';
    case 'pending_accounts':
      return 'Accounts';
    case 'pending_director':
      return 'Director';
    default:
      return null;
  }
}
