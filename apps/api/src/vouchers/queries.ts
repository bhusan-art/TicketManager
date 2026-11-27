import {
  projectLabel,
  type VoucherAttachment,
  type VoucherDetail,
  type VoucherLine,
  type VoucherSummary,
} from '@ticketmanager/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/middleware.js';
import type { DbOrTx } from '../db/client.js';
import { getVoucherPayments, voucherMoney } from '../payments/queries.js';
import { getVoucherEvents } from './events.js';
import { permissions, waitingOn } from './workflow.js';
import {
  advances,
  categories,
  departments,
  files,
  projects,
  users,
  voucherAttachments,
  voucherLines,
  vouchers,
} from '../db/schema.js';

const employees = alias(users, 'employee');
const voucherManagers = alias(users, 'voucher_manager');
const enteredBy = alias(users, 'entered_by');
const homeDepartments = alias(departments, 'home_department');

const ref = (id: string | null, name: string | null) => (id && name ? { id, name } : null);

export async function getVoucherLines(db: DbOrTx, voucherId: string): Promise<VoucherLine[]> {
  const [lineRows, attachmentRows] = await Promise.all([
    db
      .select({ line: voucherLines, categoryName: categories.name })
      .from(voucherLines)
      .leftJoin(categories, eq(categories.id, voucherLines.categoryId))
      .where(eq(voucherLines.voucherId, voucherId))
      .orderBy(asc(voucherLines.position)),
    db
      .select({
        id: voucherAttachments.id,
        lineId: voucherAttachments.lineId,
        filename: files.filename,
        contentType: files.contentType,
        sizeBytes: files.sizeBytes,
        createdAt: voucherAttachments.createdAt,
      })
      .from(voucherAttachments)
      .innerJoin(files, eq(files.id, voucherAttachments.fileId))
      .where(eq(voucherAttachments.voucherId, voucherId))
      .orderBy(asc(voucherAttachments.createdAt)),
  ]);
  const byLine = new Map<string, VoucherAttachment[]>();
  for (const a of attachmentRows) {
    const list = byLine.get(a.lineId) ?? [];
    list.push({ ...a, createdAt: a.createdAt.toISOString() });
    byLine.set(a.lineId, list);
  }
  return lineRows.map(({ line, categoryName }) => ({
    id: line.id,
    position: line.position,
    category: ref(line.categoryId, categoryName),
    expenseDate: line.expenseDate,
    description: line.description,
    vendorName: line.vendorName,
    amountPaise: line.amountPaise,
    isGst: line.isGst,
    gstin: line.gstin,
    invoiceNumber: line.invoiceNumber,
    cgstPaise: line.cgstPaise,
    sgstPaise: line.sgstPaise,
    igstPaise: line.igstPaise,
    missingProofReason: line.missingProofReason,
    approvedPaise: line.approvedPaise,
    reviewNote: line.reviewNote,
    attachments: byLine.get(line.id) ?? [],
  }));
}

/** The full voucher as the API returns it, or undefined if it doesn't exist. */
export async function getVoucherDetail(
  db: DbOrTx,
  id: string,
  auth: AuthContext,
): Promise<VoucherDetail | undefined> {
  const [row] = await db
    .select({
      voucher: vouchers,
      employee: {
        id: employees.id,
        name: employees.name,
        email: employees.email,
        employeeCode: employees.employeeCode,
        designation: employees.designation,
        departmentId: employees.departmentId,
      },
      departmentName: departments.name,
      homeDepartmentId: homeDepartments.id,
      homeDepartmentName: homeDepartments.name,
      managerId: voucherManagers.id,
      managerName: voucherManagers.name,
      projectName: projects.name,
      projectCode: projects.code,
      enteredByName: enteredBy.name,
    })
    .from(vouchers)
    .innerJoin(employees, eq(employees.id, vouchers.employeeId))
    .leftJoin(enteredBy, eq(enteredBy.id, vouchers.enteredById))
    .leftJoin(departments, eq(departments.id, vouchers.departmentId))
    .leftJoin(homeDepartments, eq(homeDepartments.id, employees.departmentId))
    .leftJoin(voucherManagers, eq(voucherManagers.id, vouchers.managerId))
    .leftJoin(projects, eq(projects.id, vouchers.projectId))
    .where(eq(vouchers.id, id));
  if (!row) return undefined;
  const v = row.voucher;
  // Until submission the department is the employee's current one.
  const department = v.submittedAt
    ? ref(v.departmentId, row.departmentName)
    : ref(row.homeDepartmentId, row.homeDepartmentName);
  return {
    id: v.id,
    number: v.number,
    purpose: v.purpose,
    approvalStatus: v.approvalStatus,
    paymentStatus: v.paymentStatus,
    totalPaise: v.totalPaise,
    version: v.version,
    employee: {
      id: row.employee.id,
      name: row.employee.name,
      email: row.employee.email,
      employeeCode: row.employee.employeeCode,
      designation: row.employee.designation,
    },
    department,
    project:
      v.projectId && row.projectName
        ? { id: v.projectId, name: projectLabel({ name: row.projectName, code: row.projectCode }) }
        : null,
    manager: ref(row.managerId, row.managerName),
    submittedAt: v.submittedAt?.toISOString() ?? null,
    cancelledAt: v.cancelledAt?.toISOString() ?? null,
    cancelReason: v.cancelReason,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
    approvedTotalPaise: v.approvedTotalPaise,
    accountsReviewStartedAt: v.accountsReviewStartedAt?.toISOString() ?? null,
    waitingOn: waitingOn(v, row.managerName),
    lines: await getVoucherLines(db, v.id),
    events: await getVoucherEvents(db, v.id),
    payments: await getVoucherPayments(db, v.id),
    paidPaise: v.paidPaise,
    outstandingPaise: voucherMoney(v).outstandingPaise,
    paidAt: v.paidAt?.toISOString() ?? null,
    advance: v.advanceId ? await getAdvanceRef(db, v.advanceId) : null,
    enteredBy: ref(v.enteredById, row.enteredByName),
    can: permissions(auth, v),
  };
}

async function getAdvanceRef(db: DbOrTx, id: string) {
  const [a] = await db
    .select({ id: advances.id, number: advances.number })
    .from(advances)
    .where(eq(advances.id, id));
  return a ?? null;
}

/** Columns for list screens. Subqueries name "vouchers"."id" in full so it isn't shadowed. */
export const voucherSummaryColumns = {
  id: vouchers.id,
  number: vouchers.number,
  purpose: vouchers.purpose,
  approvalStatus: vouchers.approvalStatus,
  paymentStatus: vouchers.paymentStatus,
  totalPaise: vouchers.totalPaise,
  submittedAt: vouchers.submittedAt,
  createdAt: vouchers.createdAt,
  updatedAt: vouchers.updatedAt,
  lineCount: sql<number>`(select count(*)::int from voucher_lines l where l.voucher_id = "vouchers"."id")`,
  expenseDate: sql<
    string | null
  >`(select min(l.expense_date)::text from voucher_lines l where l.voucher_id = "vouchers"."id")`,
  categories: sql<string[]>`(select coalesce(array_agg(distinct c.name order by c.name), '{}')
    from voucher_lines l join categories c on c.id = l.category_id
    where l.voucher_id = "vouchers"."id")`,
  employeeName: sql<string>`(select u.name from users u where u.id = "vouchers"."employee_id")`,
  projectId: vouchers.projectId,
  projectName: sql<string | null>`(select case when p.code is null then p.name
    else p.code || ' · ' || p.name end from projects p where p.id = "vouchers"."project_id")`,
};

export function selectVoucherSummaries(db: DbOrTx) {
  return db.select(voucherSummaryColumns).from(vouchers);
}

type SummaryRow = Awaited<ReturnType<ReturnType<typeof selectVoucherSummaries>['execute']>>[number];

export function toVoucherSummary({
  projectId,
  projectName,
  ...row
}: Omit<SummaryRow, 'employeeName'> & { employeeName?: string }): VoucherSummary {
  return {
    ...row,
    project: projectId && projectName ? { id: projectId, name: projectName } : null,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Filter by a project's id, or "none" for vouchers booked to no project. */
export const projectCondition = (projectId: string) =>
  projectId === 'none' ? sql`${vouchers.projectId} is null` : eq(vouchers.projectId, projectId);
