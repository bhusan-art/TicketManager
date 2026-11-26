import {
  isReviewStage,
  stageOfQuery,
  type AdvanceStatus,
  type ApprovalStatus,
  type PaymentStatus,
  type Role,
} from '@ticketmanager/shared';
import type { DbOrTx } from '../db/client.js';
import { usersWithRole, type Recipient } from './notify.js';

const REVIEWER: Record<string, Role> = {
  pending_manager: 'manager',
  pending_accounts: 'accounts',
  pending_director: 'director',
};

/** Who reviews a stage: the person's own manager, or everyone in the role (except the employee). */
export async function stageReviewers(
  db: DbOrTx,
  stage: string,
  item: { employeeId: string; managerId: string | null },
): Promise<Recipient[]> {
  const role = REVIEWER[stage];
  if (!role) return [];
  if (role === 'manager') return item.managerId ? [{ userId: item.managerId, role }] : [];
  return (await usersWithRole(db, role)).filter((r) => r.userId !== item.employeeId);
}

export interface Holder {
  /** For display: "Priya Sharma", "Accounts", "the Director". */
  label: string;
  recipients: Recipient[];
  /** The step that is due: "approval", "payment", "payout". */
  step: string;
}

const LABEL: Record<Role, string> = {
  manager: 'your manager',
  accounts: 'Accounts',
  director: 'the Director',
  employee: 'the employee',
  admin: 'the admin',
};

async function holderOfStage(
  db: DbOrTx,
  stage: string,
  item: { employeeId: string; managerId: string | null },
  managerName: string | null,
): Promise<Holder | null> {
  const role = REVIEWER[stage];
  if (!role) return null;
  return {
    label: role === 'manager' && managerName ? managerName : LABEL[role],
    recipients: await stageReviewers(db, stage, item),
    step: 'approval',
  };
}

/** Who a claim is waiting on, other than the employee. Null when it waits on nobody else. */
export async function voucherHolder(
  db: DbOrTx,
  v: {
    employeeId: string;
    managerId: string | null;
    approvalStatus: ApprovalStatus;
    paymentStatus: PaymentStatus;
  },
  managerName: string | null,
): Promise<Holder | null> {
  if (isReviewStage(v.approvalStatus)) {
    return holderOfStage(db, v.approvalStatus, v, managerName);
  }
  if (stageOfQuery(v.approvalStatus)) return null;
  if (v.paymentStatus === 'payment_pending' || v.paymentStatus === 'partially_paid') {
    const recipients = (await usersWithRole(db, 'accounts')).filter(
      (r) => r.userId !== v.employeeId,
    );
    return { label: 'Accounts', recipients, step: 'payment' };
  }
  return null;
}

/** Who an advance is waiting on, other than the employee. */
export async function advanceHolder(
  db: DbOrTx,
  a: { employeeId: string; managerId: string | null; status: AdvanceStatus },
  managerName: string | null,
): Promise<Holder | null> {
  if (a.status in REVIEWER) return holderOfStage(db, a.status, a, managerName);
  if (a.status === 'approved') {
    const recipients = (await usersWithRole(db, 'accounts')).filter(
      (r) => r.userId !== a.employeeId,
    );
    return { label: 'Accounts', recipients, step: 'payout' };
  }
  return null;
}
