import { todayIso, type Role } from '@ticketmanager/shared';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { categories, departments } from '../src/db/schema.js';
import { lastMonths } from '../src/reports/routes.js';
import { bearer, describeWithDb, makeUser, signIn, testServices, useTestDb } from './helpers.js';

describe('lastMonths', () => {
  it('walks back across a year boundary', () => {
    expect(lastMonths('2026-02-14')).toEqual([
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });
});

describeWithDb('payments', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  let travel: string;
  let sales: string;
  type Client = ReturnType<typeof client>;
  let as: Record<'employee' | 'manager' | 'accounts' | 'accounts2' | 'director', Client>;

  beforeAll(() => {
    ctx = testServices(t.db);
  });

  function client(auth: { Authorization: string }) {
    return {
      get: (path: string) => request(ctx.app).get(`/api/v1${path}`).set(auth),
      post: (path: string, body: object = {}) =>
        request(ctx.app).post(`/api/v1${path}`).set(auth).send(body),
    };
  }

  async function login(email: string, role?: Role) {
    const { token } = await signIn(ctx.app, email);
    if (!role) return client(bearer(token));
    const res = await request(ctx.app)
      .post('/api/v1/auth/switch-role')
      .set(bearer(token))
      .send({ role });
    return client(bearer(res.body.accessToken));
  }

  beforeEach(async () => {
    const [cat] = await t.db.insert(categories).values({ name: 'Travel' }).returning();
    travel = cat!.id;
    const [dept] = await t.db.insert(departments).values({ name: 'Sales' }).returning();
    sales = dept!.id;
    const manager = await makeUser(t.db, { name: 'Amit Verma', roles: ['manager', 'employee'] });
    const employee = await makeUser(t.db, {
      name: 'Rahul Das',
      managerId: manager.id,
      departmentId: sales,
      employeeCode: 'E-101',
    });
    const accounts = await makeUser(t.db, { name: 'Neha Joshi', roles: ['accounts', 'employee'] });
    const accounts2 = await makeUser(t.db, { name: 'Ravi Iyer', roles: ['accounts', 'employee'] });
    const director = await makeUser(t.db, { name: 'Dev Rao', roles: ['director'] });
    as = {
      employee: await login(employee.email),
      manager: await login(manager.email, 'manager'),
      accounts: await login(accounts.email, 'accounts'),
      accounts2: await login(accounts2.email, 'accounts'),
      director: await login(director.email),
    };
  });

  const line = (amountPaise: number, description = 'Cab') => ({
    categoryId: travel,
    expenseDate: '2026-11-18',
    description,
    amountPaise,
    missingProofReason: 'No receipt given',
  });

  /** Submits as the employee, then the manager and Accounts approve. Optionally lowers line 1. */
  async function approved(cut?: number) {
    const draft = await as.employee.post('/vouchers', {
      purpose: 'Client visit',
      lines: [line(72_000), line(28_000, 'Metro')],
    });
    let v = (await as.employee.post(`/vouchers/${draft.body.id}/submit`, { version: 1 })).body;
    v = (await as.manager.post(`/vouchers/${v.id}/approve`, { version: v.version })).body;
    v = (
      await as.accounts.post(`/vouchers/${v.id}/approve`, {
        version: v.version,
        lines: cut ? [{ id: v.lines[0].id, approvedPaise: cut, note: 'Capped' }] : undefined,
      })
    ).body;
    expect(v.paymentStatus).toBe('payment_pending');
    return v as { id: string; version: number; approvedTotalPaise: number };
  }

  const pay = (who: Client, v: { id: string; version: number }, body: object) =>
    who.post(`/vouchers/${v.id}/payments`, {
      version: v.version,
      paidOn: todayIso(),
      mode: 'bank_transfer',
      ...body,
    });

  it('pays in instalments and blocks overpayment', async () => {
    const v = await approved();
    expect((await as.accounts.get(`/vouchers/${v.id}`)).body.can.pay).toBe(true);

    const over = await pay(as.accounts, v, { amountPaise: 100_001, reference: 'UTR1' });
    expect(over.status).toBe(400);
    expect(over.body.error.details[0].path).toBe('amountPaise');

    const first = await pay(as.accounts, v, { amountPaise: 40_000, reference: 'utr1' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      paymentStatus: 'partially_paid',
      paidPaise: 40_000,
      outstandingPaise: 60_000,
      paidAt: null,
    });
    expect(first.body.payments[0]).toMatchObject({ reference: 'UTR1', amountPaise: 40_000 });
    expect(first.body.payments[0].number).toMatch(/^PAY-/);

    // Stale version.
    const stale = await pay(as.accounts, v, { amountPaise: 1_000, reference: 'UTR2' });
    expect(stale.status).toBe(409);

    // Same UTR twice is refused.
    const dup = await pay(as.accounts, first.body, { amountPaise: 1_000, reference: 'UTR1' });
    expect(dup.status).toBe(400);
    expect(dup.body.error.details[0].path).toBe('reference');

    const more = await pay(as.accounts, first.body, { amountPaise: 60_001, reference: 'UTR2' });
    expect(more.status).toBe(400);

    const rest = await pay(as.accounts, first.body, { amountPaise: 60_000, reference: 'UTR2' });
    expect(rest.status).toBe(201);
    expect(rest.body).toMatchObject({ paymentStatus: 'paid', outstandingPaise: 0 });
    expect(rest.body.paidAt).toBeTruthy();
    expect(rest.body.can.pay).toBe(false);

    const extra = await pay(as.accounts, rest.body, { amountPaise: 1, reference: 'UTR3' });
    expect(extra.status).toBe(409);

    const types = rest.body.events.map((e: { type: string }) => e.type);
    expect(types.filter((x: string) => x === 'payment_recorded')).toHaveLength(2);

    // The employee sees the payments on their voucher.
    const mine = await as.employee.get(`/vouchers/${v.id}`);
    expect(mine.body.payments).toHaveLength(2);
    expect(mine.body.can.pay).toBe(false);
  });

  it('pays only the approved amount on a partial approval', async () => {
    const v = await approved(50_000);
    expect(v.approvedTotalPaise).toBe(78_000);
    const over = await pay(as.accounts, v, { amountPaise: 100_000, reference: 'UTR9' });
    expect(over.status).toBe(400);
    const ok = await pay(as.accounts, v, { amountPaise: 78_000, reference: 'UTR9' });
    expect(ok.body).toMatchObject({ paymentStatus: 'paid', paidPaise: 78_000 });
  });

  it('checks the date, the reference and who is paying', async () => {
    const v = await approved();
    const future = await pay(as.accounts, v, {
      amountPaise: 1_000,
      reference: 'UTR1',
      paidOn: '2999-01-01',
    });
    expect(future.body.error.details[0].path).toBe('paidOn');
    const early = await pay(as.accounts, v, {
      amountPaise: 1_000,
      reference: 'UTR1',
      paidOn: '2020-01-01',
    });
    expect(early.body.error.details[0].path).toBe('paidOn');
    const noRef = await pay(as.accounts, v, { amountPaise: 1_000 });
    expect(noRef.body.error.details[0].path).toBe('reference');
    const cash = await pay(as.accounts, v, { amountPaise: 1_000, mode: 'cash' });
    expect(cash.status).toBe(201);

    expect((await pay(as.manager, cash.body, { amountPaise: 1, mode: 'cash' })).status).toBe(403);
    expect((await pay(as.employee, cash.body, { amountPaise: 1, mode: 'cash' })).status).toBe(403);
  });

  it('refuses to pay a voucher that is not approved yet', async () => {
    const draft = await as.employee.post('/vouchers', { purpose: 'x', lines: [line(1_000)] });
    const v = (await as.employee.post(`/vouchers/${draft.body.id}/submit`, { version: 1 })).body;
    const res = await pay(as.accounts, v, { amountPaise: 1_000, reference: 'UTR1' });
    expect(res.status).toBe(409);
  });

  it('does not let Accounts pay their own claim', async () => {
    // An Accounts user's own claim goes to the Director.
    const draft = await as.accounts.post('/vouchers', { purpose: 'x', lines: [line(5_000)] });
    let v = (await as.accounts.post(`/vouchers/${draft.body.id}/submit`, { version: 1 })).body;
    expect(v.approvalStatus).toBe('pending_director');
    v = (await as.director.post(`/vouchers/${v.id}/approve`, { version: v.version })).body;
    expect(v.paymentStatus).toBe('payment_pending');
    const own = await pay(as.accounts, v, { amountPaise: 5_000, reference: 'UTR1' });
    expect(own.status).toBe(403);
    const other = await pay(as.accounts2, v, { amountPaise: 5_000, reference: 'UTR1' });
    expect(other.status).toBe(201);
  });

  it('reverses a payment, frees its reference, and keeps the row', async () => {
    const v = await approved();
    const all = await pay(as.accounts, v, { amountPaise: 100_000, reference: 'UTR1' });
    const p = all.body.payments[0];
    const short = await as.accounts.post(`/vouchers/${v.id}/payments/${p.id}/reverse`, {
      version: all.body.version,
      reason: 'x',
    });
    expect(short.status).toBe(400);
    const r = await as.accounts.post(`/vouchers/${v.id}/payments/${p.id}/reverse`, {
      version: all.body.version,
      reason: 'Wrong account',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      paymentStatus: 'payment_pending',
      paidPaise: 0,
      outstandingPaise: 100_000,
      paidAt: null,
    });
    expect(r.body.payments[0]).toMatchObject({ reversalReason: 'Wrong account' });
    expect(r.body.payments[0].reversedAt).toBeTruthy();

    const again = await as.accounts.post(`/vouchers/${v.id}/payments/${p.id}/reverse`, {
      version: r.body.version,
      reason: 'Again',
    });
    expect(again.status).toBe(409);

    // The reference can be used again once its payment is reversed.
    const redo = await pay(as.accounts, r.body, { amountPaise: 100_000, reference: 'UTR1' });
    expect(redo.status).toBe(201);
    expect(redo.body.payments).toHaveLength(2);
  });

  it('keeps paid totals equal to the payments recorded', async () => {
    const a = await approved();
    const b = await approved(50_000);
    const a1 = await pay(as.accounts, a, { amountPaise: 30_000, reference: 'A1' });
    await pay(as.accounts, a1.body, { amountPaise: 20_000, reference: 'A2' });
    const b1 = await pay(as.accounts, b, { amountPaise: 78_000, reference: 'B1' });
    await as.accounts.post(`/vouchers/${b.id}/payments/${b1.body.payments[0].id}/reverse`, {
      version: b1.body.version,
      reason: 'Bounced',
    });
    const { rows } = await t.db.execute(sql`
      select v.id, v.paid_paise, v.approved_total_paise,
        coalesce((select sum(amount_paise) from payments p
          where p.voucher_id = v.id and p.reversed_at is null), 0) as sum
      from vouchers v`);
    for (const r of rows as { paid_paise: string; sum: string; approved_total_paise: string }[]) {
      expect(Number(r.paid_paise)).toBe(Number(r.sum));
      expect(Number(r.paid_paise)).toBeLessThanOrEqual(Number(r.approved_total_paise));
    }

    // The database itself refuses an overpayment.
    await expect(
      t.db.execute(sql`update vouchers set paid_paise = approved_total_paise + 1`),
    ).rejects.toThrow();
  });

  it('lists the payment queue, dashboard and reports', async () => {
    const a = await approved();
    const b = await approved(50_000);
    await pay(as.accounts, b, { amountPaise: 78_000, reference: 'B1' });
    const half = await pay(as.accounts, a, { amountPaise: 40_000, reference: 'A1' });
    expect(half.status).toBe(201);
    const pending = await as.employee.post('/vouchers', { purpose: 'x', lines: [line(9_000)] });
    await as.employee.post(`/vouchers/${pending.body.id}/submit`, { version: 1 });

    const due = await as.accounts.get('/payments?view=due');
    expect(due.status).toBe(200);
    expect(due.body.data).toHaveLength(1);
    expect(due.body.data[0]).toMatchObject({
      id: a.id,
      outstandingPaise: 60_000,
      employee: { name: 'Rahul Das', employeeCode: 'E-101' },
      department: { name: 'Sales' },
    });
    expect((await as.accounts.get('/payments?view=paid')).body.data[0].id).toBe(b.id);
    expect((await as.accounts.get('/payments?view=all')).body.meta.total).toBe(2);
    expect((await as.accounts.get('/payments?view=all&search=b1')).body.data[0].id).toBe(b.id);
    expect((await as.accounts.get('/payments?view=all&search=e-101')).body.meta.total).toBe(2);
    expect((await as.manager.get('/payments')).status).toBe(403);

    const dash = await as.accounts.get('/accounts/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body).toMatchObject({
      toVerify: { count: 0 },
      awaitingPayment: { count: 1, amountPaise: 60_000 },
      paidThisMonth: { count: 2, amountPaise: 118_000 },
    });
    expect(dash.body.claimedThisMonth.count).toBe(3);
    expect(dash.body.liabilityAging[0]).toEqual({ bucket: '0-7', count: 1, amountPaise: 60_000 });
    expect(dash.body.monthly).toHaveLength(6);
    expect(dash.body.monthly[5]).toMatchObject({ approvedPaise: 178_000, paidPaise: 118_000 });
    expect((await as.employee.get('/accounts/dashboard')).status).toBe(403);

    const report = await as.director.get('/reports');
    expect(report.status).toBe(200);
    expect(report.body.totals).toEqual({
      vouchers: 3,
      claimedPaise: 209_000,
      approvedPaise: 178_000,
      paidPaise: 118_000,
      outstandingPaise: 60_000,
      inReviewPaise: 9_000,
      rejectedPaise: 0,
    });
    expect(report.body.byDepartment[0]).toMatchObject({ key: { name: 'Sales' }, vouchers: 3 });
    expect(report.body.byEmployee[0]).toMatchObject({
      key: { name: 'Rahul Das' },
      employeeCode: 'E-101',
      department: 'Sales',
    });
    expect(report.body.byCategory[0]).toMatchObject({
      key: { name: 'Travel' },
      claimedPaise: 209_000,
      approvedPaise: 178_000,
    });
    const empty = await as.accounts.get('/reports?to=2020-01-01');
    expect(empty.body.totals.vouchers).toBe(0);

    const depts = await as.accounts.get('/reports/departments');
    expect(depts.body.data).toEqual([{ id: sales, name: 'Sales' }]);

    const liability = await as.accounts.get(`/reports/liability?departmentId=${sales}`);
    expect(liability.body.data).toHaveLength(1);
    expect(liability.body.data[0]).toMatchObject({
      id: a.id,
      ageDays: 0,
      outstandingPaise: 60_000,
    });
  });
});
