import {
  APP_TIME_ZONE,
  VOUCHER_STATUS_GROUPS,
  type ExportFilters,
  type Role,
} from '@ticketmanager/shared';
import { and, eq, ilike, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { vouchers } from '../db/schema.js';

/** Roles that can export vouchers, and what each one sees. */
export const EXPORT_ROLES: readonly Role[] = ['employee', 'manager', 'accounts', 'director'];

const TZ = sql.raw(`'${APP_TIME_ZONE}'`);

/**
 * The vouchers a person may export in a role, narrowed by the filters. Mirrors who may open a
 * voucher: employees their own, managers the claims sent to them, Accounts and Directors every
 * submitted claim. Drafts are never exported.
 */
export function exportCondition(
  caller: { userId: string; role: Role },
  f: ExportFilters,
): SQL | undefined {
  const where: (SQL | undefined)[] = [isNotNull(vouchers.submittedAt)];
  switch (caller.role) {
    case 'employee':
      where.push(eq(vouchers.employeeId, caller.userId));
      break;
    case 'manager':
      where.push(eq(vouchers.managerId, caller.userId));
      break;
    case 'accounts':
    case 'director':
      break;
    default:
      return sql`false`;
  }
  if (f.status) where.push(inArray(vouchers.approvalStatus, [...VOUCHER_STATUS_GROUPS[f.status]]));
  if (f.paymentStatus) where.push(eq(vouchers.paymentStatus, f.paymentStatus));
  if (f.departmentId) where.push(eq(vouchers.departmentId, f.departmentId));
  if (f.projectId === 'none') where.push(sql`${vouchers.projectId} is null`);
  else if (f.projectId) where.push(eq(vouchers.projectId, f.projectId));
  if (f.employeeId) where.push(eq(vouchers.employeeId, f.employeeId));
  if (f.from) where.push(sql`(${vouchers.submittedAt} at time zone ${TZ})::date >= ${f.from}`);
  if (f.to) where.push(sql`(${vouchers.submittedAt} at time zone ${TZ})::date <= ${f.to}`);
  if (f.search) {
    const term = `%${f.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(vouchers.number, term), ilike(vouchers.purpose, term)));
  }
  return and(...where);
}
