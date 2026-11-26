import {
  APP_TIME_ZONE,
  reportQuerySchema,
  todayIso,
  type AccountsDashboard,
  type LiabilityRow,
  type ReportResponse,
  type ReportRow,
} from '@ticketmanager/shared';
import { Router } from 'express';
import { sql, type SQL } from 'drizzle-orm';
import { requireRole } from '../auth/middleware.js';
import type { Db } from '../db/client.js';
import { parseQuery } from '../http/validate.js';
import type { Services } from '../services.js';

/** Statuses where the approval is final and money is owed. */
const FINAL = sql`('approved', 'partially_approved')`;
const REJECTED = sql`('manager_rejected', 'accounts_rejected', 'director_rejected')`;
const UNDECIDED = sql`('pending_manager', 'manager_query', 'pending_accounts', 'accounts_query', 'pending_director', 'director_query', 'returned')`;
const TZ = sql.raw(`'${APP_TIME_ZONE}'`);

const n = (v: unknown) => Number(v ?? 0);

async function rows<T>(db: Db, query: SQL) {
  const result = await db.execute(query);
  return result.rows as T[];
}

/** Six month keys ending with the current IST month, oldest first. */
export function lastMonths(today: string, count = 6) {
  const [y, m] = today.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

export async function getAccountsDashboard(db: Db, now = new Date()): Promise<AccountsDashboard> {
  const today = todayIso(now);
  const month = today.slice(0, 7);
  const months = lastMonths(today);

  const [head] = await rows<Record<string, string>>(
    db,
    sql`select
      count(*) filter (where approval_status = 'pending_accounts') as verify_n,
      coalesce(sum(total_paise) filter (where approval_status = 'pending_accounts'), 0) as verify_amt,
      count(*) filter (where approval_status in ${FINAL} and paid_paise < approved_total_paise) as due_n,
      coalesce(sum(approved_total_paise - paid_paise) filter (where approval_status in ${FINAL}), 0) as due_amt,
      count(*) filter (where submitted_at is not null and approval_status <> 'cancelled'
        and to_char(submitted_at at time zone ${TZ}, 'YYYY-MM') = ${month}) as claimed_n,
      coalesce(sum(total_paise) filter (where submitted_at is not null and approval_status <> 'cancelled'
        and to_char(submitted_at at time zone ${TZ}, 'YYYY-MM') = ${month}), 0) as claimed_amt
    from vouchers`,
  );
  const [paid] = await rows<Record<string, string>>(
    db,
    sql`select count(*) as n, coalesce(sum(amount_paise), 0) as amt from payments
      where reversed_at is null and to_char(paid_on, 'YYYY-MM') = ${month}`,
  );
  const aging = await rows<{ bucket: string; n: string; amt: string }>(
    db,
    sql`select case
        when age <= 7 then '0-7' when age <= 30 then '8-30' when age <= 60 then '31-60' else '60+'
      end as bucket, count(*) as n, sum(owed) as amt
      from (
        select ${today}::date - (decided_at at time zone ${TZ})::date as age,
          approved_total_paise - paid_paise as owed
        from vouchers
        where approval_status in ${FINAL} and paid_paise < approved_total_paise
      ) t group by 1`,
  );
  const approvedByMonth = await rows<{ month: string; amt: string }>(
    db,
    sql`select to_char(decided_at at time zone ${TZ}, 'YYYY-MM') as month, sum(approved_total_paise) as amt
      from vouchers where approval_status in ${FINAL} and decided_at is not null
      and to_char(decided_at at time zone ${TZ}, 'YYYY-MM') >= ${months[0]} group by 1`,
  );
  const paidByMonth = await rows<{ month: string; amt: string }>(
    db,
    sql`select to_char(paid_on, 'YYYY-MM') as month, sum(amount_paise) as amt from payments
      where reversed_at is null and to_char(paid_on, 'YYYY-MM') >= ${months[0]} group by 1`,
  );

  const lookup = (list: { month: string; amt: string }[], m: string) =>
    n(list.find((r) => r.month === m)?.amt);
  return {
    toVerify: { count: n(head!.verify_n), amountPaise: n(head!.verify_amt) },
    awaitingPayment: { count: n(head!.due_n), amountPaise: n(head!.due_amt) },
    paidThisMonth: { count: n(paid!.n), amountPaise: n(paid!.amt) },
    claimedThisMonth: { count: n(head!.claimed_n), amountPaise: n(head!.claimed_amt) },
    liabilityAging: (['0-7', '8-30', '31-60', '60+'] as const).map((bucket) => {
      const r = aging.find((a) => a.bucket === bucket);
      return { bucket, count: n(r?.n), amountPaise: n(r?.amt) };
    }),
    monthly: months.map((m) => ({
      month: m,
      approvedPaise: lookup(approvedByMonth, m),
      paidPaise: lookup(paidByMonth, m),
    })),
  };
}

type Filter = { from?: string; to?: string; departmentId?: string };

/** Submitted, not cancelled, inside the date range (IST submission date). */
function reportWhere(f: Filter) {
  const parts: SQL[] = [sql`v.submitted_at is not null`, sql`v.approval_status <> 'cancelled'`];
  if (f.from) parts.push(sql`(v.submitted_at at time zone ${TZ})::date >= ${f.from}::date`);
  if (f.to) parts.push(sql`(v.submitted_at at time zone ${TZ})::date <= ${f.to}::date`);
  if (f.departmentId) parts.push(sql`v.department_id = ${f.departmentId}`);
  return sql.join(parts, sql` and `);
}

const MONEY = sql`
  count(*) as vouchers,
  coalesce(sum(v.total_paise), 0) as claimed,
  coalesce(sum(v.approved_total_paise) filter (where v.approval_status in ${FINAL}), 0) as approved,
  coalesce(sum(v.paid_paise) filter (where v.approval_status in ${FINAL}), 0) as paid,
  coalesce(sum(v.total_paise) filter (where v.approval_status in ${UNDECIDED}), 0) as in_review,
  coalesce(sum(v.total_paise) filter (where v.approval_status in ${REJECTED}), 0) as rejected`;

type MoneyRow = Record<
  'vouchers' | 'claimed' | 'approved' | 'paid' | 'in_review' | 'rejected',
  string
>;

function toRow(r: MoneyRow): Omit<ReportRow, 'key'> {
  const approvedPaise = n(r.approved);
  const paidPaise = n(r.paid);
  return {
    vouchers: n(r.vouchers),
    claimedPaise: n(r.claimed),
    approvedPaise,
    paidPaise,
    outstandingPaise: approvedPaise - paidPaise,
    inReviewPaise: n(r.in_review),
    rejectedPaise: n(r.rejected),
  };
}

export async function getReport(db: Db, f: Filter): Promise<ReportResponse> {
  const where = reportWhere(f);
  const [totals] = await rows<MoneyRow>(db, sql`select ${MONEY} from vouchers v where ${where}`);
  const byDepartment = await rows<MoneyRow & { id: string | null; name: string | null }>(
    db,
    sql`select d.id, d.name, ${MONEY} from vouchers v
      left join departments d on d.id = v.department_id
      where ${where} group by d.id, d.name order by claimed desc, d.name`,
  );
  const byEmployee = await rows<
    MoneyRow & { id: string; name: string; code: string | null; dept: string | null }
  >(
    db,
    sql`select u.id, u.name, u.employee_code as code, d.name as dept, ${MONEY} from vouchers v
      join users u on u.id = v.employee_id
      left join departments d on d.id = v.department_id
      where ${where} group by u.id, u.name, u.employee_code, d.name order by claimed desc, u.name`,
  );
  const byCategory = await rows<{
    id: string | null;
    name: string | null;
    vouchers: string;
    claimed: string;
    approved: string;
  }>(
    db,
    sql`select c.id, c.name, count(distinct v.id) as vouchers,
        coalesce(sum(l.amount_paise), 0) as claimed,
        coalesce(sum(coalesce(l.approved_paise, l.amount_paise)) filter (where v.approval_status in ${FINAL}), 0) as approved
      from voucher_lines l join vouchers v on v.id = l.voucher_id
      left join categories c on c.id = l.category_id
      where ${where} group by c.id, c.name order by claimed desc, c.name`,
  );
  const ref = (id: string | null, name: string | null) => (id && name ? { id, name } : null);
  return {
    totals: toRow(totals!),
    byDepartment: byDepartment.map((r) => ({ key: ref(r.id, r.name), ...toRow(r) })),
    byEmployee: byEmployee.map((r) => ({
      key: { id: r.id, name: r.name },
      employeeCode: r.code,
      department: r.dept,
      ...toRow(r),
    })),
    byCategory: byCategory.map((r) => ({
      key: ref(r.id, r.name),
      vouchers: n(r.vouchers),
      claimedPaise: n(r.claimed),
      approvedPaise: n(r.approved),
    })),
  };
}

export async function getLiability(
  db: Db,
  f: { departmentId?: string },
  now = new Date(),
): Promise<LiabilityRow[]> {
  const today = todayIso(now);
  const list = await rows<{
    id: string;
    number: string;
    employee_id: string;
    employee_name: string;
    department_id: string | null;
    department_name: string | null;
    approval_status: LiabilityRow['approvalStatus'];
    payment_status: LiabilityRow['paymentStatus'];
    decided_at: Date | null;
    age: number | null;
    approved: string;
    paid: string;
  }>(
    db,
    sql`select v.id, v.number, u.id as employee_id, u.name as employee_name,
        d.id as department_id, d.name as department_name,
        v.approval_status, v.payment_status, v.decided_at,
        ${today}::date - (v.decided_at at time zone ${TZ})::date as age,
        v.approved_total_paise as approved, v.paid_paise as paid
      from vouchers v join users u on u.id = v.employee_id
      left join departments d on d.id = v.department_id
      where v.approval_status in ${FINAL} and v.paid_paise < v.approved_total_paise
      ${f.departmentId ? sql`and v.department_id = ${f.departmentId}` : sql``}
      order by v.decided_at asc nulls first, v.id`,
  );
  return list.map((r) => ({
    id: r.id,
    number: r.number,
    employee: { id: r.employee_id, name: r.employee_name },
    department:
      r.department_id && r.department_name
        ? { id: r.department_id, name: r.department_name }
        : null,
    approvalStatus: r.approval_status,
    paymentStatus: r.payment_status,
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    ageDays: n(r.age),
    approvedPaise: n(r.approved),
    paidPaise: n(r.paid),
    outstandingPaise: n(r.approved) - n(r.paid),
  }));
}

/** Accounts' dashboard numbers. */
export function accountsRouter({ db }: Services) {
  const router = Router();
  router.use(requireRole('accounts', 'director', 'admin'));
  router.get('/dashboard', async (_req, res) => {
    res.json(await getAccountsDashboard(db));
  });
  return router;
}

/** Spend reports. Accounts, the Director and admins see the whole company. */
export function reportsRouter({ db }: Services) {
  const router = Router();
  router.use(requireRole('accounts', 'director', 'admin'));
  router.get('/', async (req, res) => {
    res.json(await getReport(db, parseQuery(reportQuerySchema, req)));
  });
  router.get('/liability', async (req, res) => {
    const { departmentId } = parseQuery(reportQuerySchema, req);
    res.json({ data: await getLiability(db, { departmentId }) });
  });
  /** For the department filter. */
  router.get('/departments', async (_req, res) => {
    const data = await rows<{ id: string; name: string }>(
      db,
      sql`select id, name from departments order by name`,
    );
    res.json({ data });
  });
  return router;
}
