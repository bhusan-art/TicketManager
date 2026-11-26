import {
  ADVANCE_REVIEW_STAGES,
  isAdvanceReviewStage,
  type AdvancePermissions,
  type AdvanceSettlement,
  type AdvanceStatus,
} from '@ticketmanager/shared';
import type { AuthContext } from '../auth/middleware.js';

/**
 * The advance state machine, free of the database so every step can be tested directly.
 * Routes ask `advancePermissions()` before they change anything.
 */

export interface WorkflowAdvance {
  employeeId: string;
  managerId: string | null;
  status: AdvanceStatus;
  number: string | null;
  submittedAt: Date | string | null;
}

type Caller = Pick<AuthContext, 'userId' | 'activeRole'>;

export const EDITABLE_ADVANCE_STATUSES: readonly AdvanceStatus[] = ['draft', 'returned'];
/** The employee can withdraw a request until the money is paid out. */
export const CANCELLABLE_ADVANCE_STATUSES: readonly AdvanceStatus[] = [
  'pending_manager',
  'pending_accounts',
  'pending_director',
  'returned',
  'approved',
];

/** The employee, the manager it went to, and (once submitted) Accounts and the Director. */
export function canViewAdvance(caller: Caller, a: WorkflowAdvance): boolean {
  if (a.employeeId === caller.userId) return true;
  if (a.managerId === caller.userId) return true;
  if (!a.submittedAt) return false;
  return caller.activeRole === 'accounts' || caller.activeRole === 'director';
}

/** The approver of the current stage. Never the employee themself. */
export function isAdvanceApprover(caller: Caller, a: WorkflowAdvance): boolean {
  if (a.employeeId === caller.userId) return false;
  if (!isAdvanceReviewStage(a.status)) return false;
  const { approver } = ADVANCE_REVIEW_STAGES[a.status];
  if (caller.activeRole !== approver) return false;
  if (approver === 'manager') return a.managerId === caller.userId;
  return true;
}

/** Accounts handles the money, never for their own advance. */
const isAccounts = (caller: Caller, a: WorkflowAdvance) =>
  caller.activeRole === 'accounts' && a.employeeId !== caller.userId;

/** An open advance can close once every claim is decided and the balance is zero. */
export function canClose(s: Pick<AdvanceSettlement, 'balancePaise' | 'inReviewCount'>) {
  return s.balancePaise === 0 && s.inReviewCount === 0;
}

export function advancePermissions(
  caller: Caller,
  a: WorkflowAdvance,
  settlement?: Pick<AdvanceSettlement, 'balancePaise' | 'inReviewCount'>,
): AdvancePermissions {
  const owner = a.employeeId === caller.userId;
  const editable = owner && EDITABLE_ADVANCE_STATUSES.includes(a.status);
  const approver = isAdvanceApprover(caller, a);
  const money = isAccounts(caller, a);
  return {
    edit: editable,
    submit: editable,
    cancel: owner && CANCELLABLE_ADVANCE_STATUSES.includes(a.status),
    delete: owner && a.status === 'draft' && !a.number,
    approve: approver,
    return: approver,
    reject: approver,
    disburse: money && a.status === 'approved',
    settle: money && a.status === 'open',
    close: money && a.status === 'open' && !!settlement && canClose(settlement),
  };
}

/** The status after an approver's step. */
export function nextAdvanceStatus(
  status: AdvanceStatus,
  action: 'approve' | 'return' | 'reject',
): AdvanceStatus {
  if (!isAdvanceReviewStage(status)) throw new Error(`Cannot ${action} from ${status}`);
  switch (action) {
    case 'approve':
      return status === 'pending_manager' ? 'pending_accounts' : 'approved';
    case 'return':
      return 'returned';
    case 'reject':
      return ADVANCE_REVIEW_STAGES[status].rejected;
  }
}

export function advanceWaitingOn(a: WorkflowAdvance, managerName: string | null): string | null {
  switch (a.status) {
    case 'draft':
    case 'returned':
      return 'Employee';
    case 'pending_manager':
      return managerName ?? 'Manager';
    case 'pending_accounts':
    case 'approved':
      return 'Accounts';
    case 'pending_director':
      return 'Director';
    default:
      return null;
  }
}
