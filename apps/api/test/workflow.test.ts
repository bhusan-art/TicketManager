import {
  APPROVAL_STATUSES,
  VOUCHER_ACTIONS,
  type ApprovalStatus,
  type Role,
  type VoucherAction,
} from '@ticketmanager/shared';
import { describe, expect, it } from 'vitest';
import {
  canView,
  nextStatus,
  permissions,
  type WorkflowVoucher,
} from '../src/vouchers/workflow.js';

/**
 * Every status × every caller × every action. The table below lists what is allowed;
 * everything else must be refused.
 */
const EMPLOYEE = 'employee-id';
const MANAGER = 'manager-id';

type CallerName =
  | 'owner'
  | 'managerOfRecord'
  | 'otherManager'
  | 'accounts'
  | 'director'
  | 'admin'
  | 'ownerAsAccounts'
  | 'ownerAsDirector'
  | 'managerOfRecordAsEmployee';

const CALLERS: Record<CallerName, { userId: string; activeRole: Role }> = {
  owner: { userId: EMPLOYEE, activeRole: 'employee' },
  managerOfRecord: { userId: MANAGER, activeRole: 'manager' },
  otherManager: { userId: 'other-manager', activeRole: 'manager' },
  accounts: { userId: 'accounts-id', activeRole: 'accounts' },
  director: { userId: 'director-id', activeRole: 'director' },
  admin: { userId: 'admin-id', activeRole: 'admin' },
  // The claimant holding approver roles themselves: never allowed to approve.
  ownerAsAccounts: { userId: EMPLOYEE, activeRole: 'accounts' },
  ownerAsDirector: { userId: EMPLOYEE, activeRole: 'director' },
  managerOfRecordAsEmployee: { userId: MANAGER, activeRole: 'employee' },
};

const REVIEW: VoucherAction[] = ['approve', 'query', 'return', 'reject'];
const OWNER_ALWAYS: VoucherAction[] = ['comment'];

/** Allowed actions per status and caller. Unlisted = nothing. */
const ALLOWED: Partial<Record<ApprovalStatus, Partial<Record<CallerName, VoucherAction[]>>>> = {
  draft: {
    owner: ['edit', 'submit', 'delete'],
    ownerAsAccounts: ['edit', 'submit', 'delete'],
    ownerAsDirector: ['edit', 'submit', 'delete'],
  },
  pending_manager: {
    owner: ['cancel', ...OWNER_ALWAYS],
    ownerAsAccounts: ['cancel', 'comment'],
    ownerAsDirector: ['cancel', 'comment'],
    managerOfRecord: [...REVIEW, 'comment'],
    managerOfRecordAsEmployee: ['comment'],
    accounts: ['comment'],
    director: ['comment'],
  },
  manager_query: {
    owner: ['cancel', 'answer', 'comment'],
    ownerAsAccounts: ['cancel', 'answer', 'comment'],
    ownerAsDirector: ['cancel', 'answer', 'comment'],
    managerOfRecord: ['comment'],
    managerOfRecordAsEmployee: ['comment'],
    accounts: ['comment'],
    director: ['comment'],
  },
  pending_accounts: {
    owner: ['cancel', 'comment'],
    ownerAsAccounts: ['cancel', 'comment'],
    ownerAsDirector: ['cancel', 'comment'],
    managerOfRecord: ['comment'],
    managerOfRecordAsEmployee: ['comment'],
    accounts: [...REVIEW, 'comment'],
    director: ['comment'],
  },
  accounts_query: {
    owner: ['answer', 'comment'],
    ownerAsAccounts: ['answer', 'comment'],
    ownerAsDirector: ['answer', 'comment'],
    managerOfRecord: ['comment'],
    managerOfRecordAsEmployee: ['comment'],
    accounts: ['comment'],
    director: ['comment'],
  },
  pending_director: {
    owner: ['cancel', 'comment'],
    ownerAsAccounts: ['cancel', 'comment'],
    ownerAsDirector: ['cancel', 'comment'],
    managerOfRecord: ['comment'],
    managerOfRecordAsEmployee: ['comment'],
    accounts: ['comment'],
    director: [...REVIEW, 'comment'],
  },
  director_query: {
    owner: ['answer', 'comment'],
    ownerAsAccounts: ['answer', 'comment'],
    ownerAsDirector: ['answer', 'comment'],
    managerOfRecord: ['comment'],
    managerOfRecordAsEmployee: ['comment'],
    accounts: ['comment'],
    director: ['comment'],
  },
  returned: {
    owner: ['edit', 'submit', 'cancel', 'comment'],
    ownerAsAccounts: ['edit', 'submit', 'cancel', 'comment'],
    ownerAsDirector: ['edit', 'submit', 'cancel', 'comment'],
    managerOfRecord: ['comment'],
    managerOfRecordAsEmployee: ['comment'],
    accounts: ['comment'],
    director: ['comment'],
  },
};
// Final statuses: anyone who can see the voucher may still comment, nothing else.
for (const s of [
  'approved',
  'partially_approved',
  'manager_rejected',
  'accounts_rejected',
  'director_rejected',
  'cancelled',
] as const) {
  ALLOWED[s] = {
    owner: ['comment'],
    ownerAsAccounts: ['comment'],
    ownerAsDirector: ['comment'],
    managerOfRecord: ['comment'],
    managerOfRecordAsEmployee: ['comment'],
    accounts: ['comment'],
    director: ['comment'],
  };
}

const voucher = (approvalStatus: ApprovalStatus): WorkflowVoucher => ({
  employeeId: EMPLOYEE,
  managerId: MANAGER,
  approvalStatus,
  number: approvalStatus === 'draft' ? null : 'EXP-2026-00001',
  submittedAt: approvalStatus === 'draft' ? null : '2026-11-26T10:00:00Z',
  accountsReviewStartedAt: null,
});

describe('approval permissions', () => {
  for (const status of APPROVAL_STATUSES) {
    for (const [name, caller] of Object.entries(CALLERS) as [
      CallerName,
      (typeof CALLERS)[CallerName],
    ][]) {
      it(`${status} / ${name}`, () => {
        const allowed = new Set(ALLOWED[status]?.[name] ?? []);
        const actual = permissions(caller, voucher(status));
        for (const action of VOUCHER_ACTIONS) {
          expect({ action, allowed: actual[action] }).toEqual({
            action,
            allowed: allowed.has(action),
          });
        }
      });
    }
  }

  it('never lets anyone review their own claim', () => {
    for (const status of APPROVAL_STATUSES) {
      for (const role of ['employee', 'manager', 'accounts', 'director', 'admin'] as Role[]) {
        // The claimant is also the manager of record: still no.
        const v = { ...voucher(status), managerId: EMPLOYEE };
        const p = permissions({ userId: EMPLOYEE, activeRole: role }, v);
        expect([p.approve, p.query, p.return, p.reject]).toEqual([false, false, false, false]);
      }
    }
  });

  it('stops cancelling once Accounts has started review', () => {
    const v = { ...voucher('pending_accounts'), accountsReviewStartedAt: '2026-11-26T11:00:00Z' };
    expect(permissions(CALLERS.owner, v).cancel).toBe(false);
    expect(permissions(CALLERS.owner, { ...v, approvalStatus: 'returned' }).cancel).toBe(false);
  });

  it('hides drafts from everyone but the owner, and other managers see nothing', () => {
    expect(canView(CALLERS.accounts, voucher('draft'))).toBe(false);
    expect(canView(CALLERS.otherManager, voucher('pending_manager'))).toBe(false);
    expect(canView(CALLERS.admin, voucher('approved'))).toBe(false);
    expect(canView(CALLERS.managerOfRecordAsEmployee, voucher('accounts_query'))).toBe(true);
  });
});

describe('status transitions', () => {
  it('moves through the stages', () => {
    expect(nextStatus('pending_manager', 'approve')).toBe('pending_accounts');
    expect(nextStatus('pending_manager', 'approve', true)).toBe('pending_accounts');
    expect(nextStatus('pending_accounts', 'approve')).toBe('approved');
    expect(nextStatus('pending_accounts', 'approve', true)).toBe('partially_approved');
    expect(nextStatus('pending_director', 'approve')).toBe('approved');
    expect(nextStatus('pending_director', 'approve', true)).toBe('partially_approved');
  });

  it('queries come back to the stage that asked', () => {
    for (const [stage, query] of [
      ['pending_manager', 'manager_query'],
      ['pending_accounts', 'accounts_query'],
      ['pending_director', 'director_query'],
    ] as const) {
      expect(nextStatus(stage, 'query')).toBe(query);
      expect(nextStatus(query, 'answer')).toBe(stage);
      expect(nextStatus(stage, 'return')).toBe('returned');
    }
    expect(nextStatus('pending_manager', 'reject')).toBe('manager_rejected');
    expect(nextStatus('pending_accounts', 'reject')).toBe('accounts_rejected');
    expect(nextStatus('pending_director', 'reject')).toBe('director_rejected');
  });

  it('refuses every step from a status that is not a review stage', () => {
    for (const status of APPROVAL_STATUSES) {
      const review = ['pending_manager', 'pending_accounts', 'pending_director'].includes(status);
      for (const action of ['approve', 'query', 'return', 'reject'] as const) {
        if (review) expect(() => nextStatus(status, action)).not.toThrow();
        else expect(() => nextStatus(status, action)).toThrow();
      }
      const query = status.endsWith('_query');
      if (query) expect(() => nextStatus(status, 'answer')).not.toThrow();
      else expect(() => nextStatus(status, 'answer')).toThrow();
    }
  });
});
