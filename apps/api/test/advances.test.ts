import { settle, settleByDate, todayIso, type Role } from '@ticketmanager/shared';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  advancePermissions,
  canViewAdvance,
  nextAdvanceStatus,
  type WorkflowAdvance,
} from '../src/advances/workflow.js';
import { categories } from '../src/db/schema.js';
import { bearer, describeWithDb, makeUser, signIn, testServices, useTestDb } from './helpers.js';

describe('settlement arithmetic', () => {
  const tx = (
    kind: 'disbursement' | 'return' | 'top_up',
    amountPaise: number,
    reversed = false,
  ) => ({
    kind,
    amountPaise,
    reversedAt: reversed ? '2026-11-20T00:00:00Z' : null,
  });
  const v = (approved: number | null, inReview = false) => ({
    counted: approved !== null,
    inReview,
    approvedTotalPaise: approved,
    totalPaise: approved ?? 5_000,
  });

  it('owes the company the unused part', () => {
    // The worked example in the business architecture: ₹20,000 out, ₹14,000 approved.
    const s = settle({
      transactions: [tx('disbursement', 2_000_000)],
      vouchers: [v(900_000), v(500_000)],
    });
    expect(s).toMatchObject({
      disbursedPaise: 2_000_000,
      approvedExpensesPaise: 1_400_000,
      balancePaise: 600_000,
      dueBackPaise: 600_000,
      payablePaise: 0,
    });
    const after = settle({
      transactions: [tx('disbursement', 2_000_000), tx('return', 600_000)],
      vouchers: [v(900_000), v(500_000)],
    });
    expect(after.balancePaise).toBe(0);
  });

  it('owes the employee the shortfall', () => {
    const s = settle({ transactions: [tx('disbursement', 2_000_000)], vouchers: [v(2_500_000)] });
    expect(s).toMatchObject({ balancePaise: -500_000, dueBackPaise: 0, payablePaise: 500_000 });
    const paid = settle({
      transactions: [tx('disbursement', 2_000_000), tx('top_up', 500_000)],
      vouchers: [v(2_500_000)],
    });
    expect(paid.balancePaise).toBe(0);
  });

  it('is balanced when expenses equal the advance, ignoring reversed entries and undecided claims', () => {
    const s = settle({
      transactions: [tx('disbursement', 1_000_000), tx('return', 50_000, true)],
      vouchers: [v(1_000_000), v(null, true), v(null)],
    });
    expect(s).toMatchObject({
      balancePaise: 0,
      inReviewCount: 1,
      inReviewPaise: 5_000,
      returnedPaise: 0,
    });
  });

  it('gives 30 days from the later of the expected date and the payout', () => {
    expect(settleByDate('2026-11-20', '2026-11-10')).toBe('2026-12-20');
    expect(settleByDate('2026-11-01', '2026-11-10')).toBe('2026-12-10');
    expect(settleByDate('2026-12-15', '2026-12-15')).toBe('2027-01-14');
  });
});

describe('advance workflow rules', () => {
  const adv = (over: Partial<WorkflowAdvance> = {}): WorkflowAdvance => ({
    employeeId: 'emp',
    managerId: 'mgr',
    status: 'pending_manager',
    number: 'ADV-2026-00001',
    submittedAt: '2026-11-20T00:00:00Z',
    ...over,
  });
  const as = (userId: string, activeRole: Role) => ({ userId, activeRole });

  it('lets only the stage approver decide, never the employee', () => {
    expect(advancePermissions(as('mgr', 'manager'), adv()).approve).toBe(true);
    expect(advancePermissions(as('other', 'manager'), adv()).approve).toBe(false);
    expect(advancePermissions(as('acc', 'accounts'), adv()).approve).toBe(false);
    expect(
      advancePermissions(as('acc', 'accounts'), adv({ status: 'pending_accounts' })).approve,
    ).toBe(true);
    // An Accounts user's own request goes to the Director; they can't approve or pay it themself.
    const own = adv({ employeeId: 'acc', status: 'pending_director', managerId: null });
    expect(advancePermissions(as('acc', 'accounts'), own).approve).toBe(false);
    expect(advancePermissions(as('dir', 'director'), own).approve).toBe(true);
    expect(
      advancePermissions(as('acc', 'accounts'), adv({ employeeId: 'acc', status: 'approved' }))
        .disburse,
    ).toBe(false);
  });

  it('moves through the stages', () => {
    expect(nextAdvanceStatus('pending_manager', 'approve')).toBe('pending_accounts');
    expect(nextAdvanceStatus('pending_accounts', 'approve')).toBe('approved');
    expect(nextAdvanceStatus('pending_director', 'reject')).toBe('director_rejected');
    expect(nextAdvanceStatus('pending_manager', 'return')).toBe('returned');
    expect(() => nextAdvanceStatus('open', 'approve')).toThrow();
  });

  it('closes only at a zero balance with nothing in review', () => {
    const open = adv({ status: 'open' });
    const acc = as('acc', 'accounts');
    expect(advancePermissions(acc, open, { balancePaise: 0, inReviewCount: 0 }).close).toBe(true);
    expect(advancePermissions(acc, open, { balancePaise: 100, inReviewCount: 0 }).close).toBe(
      false,
    );
    expect(advancePermissions(acc, open, { balancePaise: 0, inReviewCount: 1 }).close).toBe(false);
  });

  it('hides drafts from everyone but the employee', () => {
    expect(canViewAdvance(as('acc', 'accounts'), adv({ submittedAt: null, managerId: null }))).toBe(
      false,
    );
    expect(canViewAdvance(as('acc', 'accounts'), adv())).toBe(true);
    expect(canViewAdvance(as('acc', 'employee'), adv())).toBe(false);
  });
});

describeWithDb('advances', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  let travel: string;
  type Client = ReturnType<typeof client>;
  let as: Record<
    'employee' | 'other' | 'manager' | 'accounts' | 'accounts2' | 'director' | 'admin',
    Client
  >;

  beforeAll(() => {
    ctx = testServices(t.db);
  });

  function client(auth: { Authorization: string }) {
    return {
      get: (path: string) => request(ctx.app).get(`/api/v1${path}`).set(auth),
      post: (path: string, body: object = {}) =>
        request(ctx.app).post(`/api/v1${path}`).set(auth).send(body),
      patch: (path: string, body: object) =>
        request(ctx.app).patch(`/api/v1${path}`).set(auth).send(body),
      put: (path: string, body: object) =>
        request(ctx.app).put(`/api/v1${path}`).set(auth).send(body),
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
    const manager = await makeUser(t.db, { name: 'Amit Verma', roles: ['manager', 'employee'] });
    const employee = await makeUser(t.db, { name: 'Rahul Das', managerId: manager.id });
    const other = await makeUser(t.db, { name: 'Priya Nair', managerId: manager.id });
    const accounts = await makeUser(t.db, { name: 'Neha Joshi', roles: ['accounts', 'employee'] });
    const accounts2 = await makeUser(t.db, { name: 'Ravi Iyer', roles: ['accounts', 'employee'] });
    const director = await makeUser(t.db, { name: 'Dev Rao', roles: ['director'] });
    const admin = await makeUser(t.db, { name: 'Admin', roles: ['admin'] });
    as = {
      employee: await login(employee.email),
      other: await login(other.email),
      manager: await login(manager.email, 'manager'),
      accounts: await login(accounts.email, 'accounts'),
      accounts2: await login(accounts2.email, 'accounts'),
      director: await login(director.email),
      admin: await login(admin.email),
    };
  });

  type Adv = { id: string; version: number; status: string; settlement: Record<string, number> };

  /** Requests, approves and pays out an advance for `who` (default: the employee). */
  async function openAdvance(
    amountPaise = 2_000_000,
    who = as.employee,
    approvers = [as.manager, as.accounts],
  ) {
    const draft = await who.post('/advances', {
      purpose: 'Site visit to Pune',
      requestedPaise: amountPaise,
      expectedDate: todayIso(),
    });
    expect(draft.status).toBe(201);
    let a = (await who.post(`/advances/${draft.body.id}/submit`, { version: 1 })).body;
    for (const approver of approvers) {
      a = (await approver.post(`/advances/${a.id}/approve`, { version: a.version })).body;
    }
    expect(a.status).toBe('approved');
    const payer =
      approvers.includes(as.accounts) && who !== as.accounts ? as.accounts : as.accounts2;
    const paid = await payer.post(`/advances/${a.id}/disburse`, {
      version: a.version,
      amountPaise,
      paidOn: todayIso(),
      mode: 'bank_transfer',
      reference: `ADV${Math.random().toString(36).slice(2, 10)}`,
    });
    expect(paid.status).toBe(201);
    return paid.body as Adv;
  }

  const line = (amountPaise: number) => ({
    categoryId: travel,
    expenseDate: todayIso(),
    description: 'Cab',
    amountPaise,
    missingProofReason: 'No receipt given',
  });

  /** A voucher tagged to the advance, submitted and approved by the manager and Accounts. */
  async function claim(advanceId: string, amountPaise: number, approve = true, who = as.employee) {
    const draft = await who.post('/vouchers', {
      purpose: 'Pune trip',
      advanceId,
      lines: [line(amountPaise)],
    });
    expect(draft.status).toBe(201);
    let v = (await who.post(`/vouchers/${draft.body.id}/submit`, { version: 1 })).body;
    if (!approve) return v;
    v = (await as.manager.post(`/vouchers/${v.id}/approve`, { version: v.version })).body;
    v = (await as.accounts.post(`/vouchers/${v.id}/approve`, { version: v.version })).body;
    return v;
  }

  const get = async (id: string) =>
    (await as.accounts.get(`/advances/${id}`)).body as Adv & Record<string, unknown>;

  it('runs request → approval → payout → claims → return → close', async () => {
    const draft = await as.employee.post('/advances', {
      purpose: 'Site visit to Pune',
      requestedPaise: 2_500_000,
      expectedDate: todayIso(),
    });
    // Drafts are private.
    expect((await as.accounts.get(`/advances/${draft.body.id}`)).status).toBe(404);
    const sub = await as.employee.post(`/advances/${draft.body.id}/submit`, { version: 1 });
    expect(sub.body).toMatchObject({ status: 'pending_manager', waitingOn: 'Amit Verma' });
    expect(sub.body.number).toMatch(/^ADV-\d{4}-00001$/);

    // Accounts can't act before the manager; the manager approves less.
    expect(
      (await as.accounts.post(`/advances/${sub.body.id}/approve`, { version: sub.body.version }))
        .status,
    ).toBe(409);
    const tooMuch = await as.manager.post(`/advances/${sub.body.id}/approve`, {
      version: sub.body.version,
      approvedPaise: 3_000_000,
    });
    expect(tooMuch.status).toBe(400);
    const m = await as.manager.post(`/advances/${sub.body.id}/approve`, {
      version: sub.body.version,
      approvedPaise: 2_000_000,
    });
    expect(m.body).toMatchObject({ status: 'pending_accounts', approvedPaise: 2_000_000 });
    const a = await as.accounts.post(`/advances/${sub.body.id}/approve`, {
      version: m.body.version,
    });
    expect(a.body).toMatchObject({ status: 'approved', approvedPaise: 2_000_000 });
    expect(a.body.can.disburse).toBe(true);

    const over = await as.accounts.post(`/advances/${a.body.id}/disburse`, {
      version: a.body.version,
      amountPaise: 2_000_001,
      paidOn: todayIso(),
      mode: 'bank_transfer',
      reference: 'UTR1',
    });
    expect(over.body.error.details[0].path).toBe('amountPaise');
    const paid = await as.accounts.post(`/advances/${a.body.id}/disburse`, {
      version: a.body.version,
      amountPaise: 2_000_000,
      paidOn: todayIso(),
      mode: 'bank_transfer',
      reference: 'utr1',
    });
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({ status: 'open', overdue: false });
    expect(paid.body.settleBy).toBe(settleByDate(todayIso(), todayIso()));
    expect(paid.body.settlement).toMatchObject({
      disbursedPaise: 2_000_000,
      dueBackPaise: 2_000_000,
    });

    // The employee can tag claims to it now.
    const linkable = await as.employee.get('/advances/linkable');
    expect(linkable.body.data).toEqual([
      expect.objectContaining({ id: a.body.id, disbursedPaise: 2_000_000 }),
    ]);
    const v1 = await claim(a.body.id, 900_000);
    expect(v1).toMatchObject({ approvalStatus: 'approved', paymentStatus: 'against_advance' });
    expect(v1.advance).toMatchObject({ id: a.body.id });
    expect(v1.can.pay).toBe(false);
    const pending = await claim(a.body.id, 500_000, false);

    let s = await get(a.body.id);
    expect(s.settlement).toMatchObject({
      approvedExpensesPaise: 900_000,
      inReviewCount: 1,
      dueBackPaise: 1_100_000,
    });
    // Can't close: a claim is in review and money is due back.
    expect(
      (await as.accounts.post(`/advances/${a.body.id}/close`, { version: s.version })).status,
    ).toBe(409);

    const v2 = (
      await as.manager.post(`/vouchers/${pending.id}/approve`, { version: pending.version })
    ).body;
    const final = await as.accounts.post(`/vouchers/${v2.id}/approve`, { version: v2.version });
    expect(final.body.paymentStatus).toBe('against_advance');
    s = await get(a.body.id);
    expect(s.settlement).toMatchObject({
      approvedExpensesPaise: 1_400_000,
      dueBackPaise: 600_000,
      inReviewCount: 0,
    });

    // The employee's claims never reach the payment queue.
    expect((await as.accounts.get('/payments?view=all')).body.meta.total).toBe(0);

    const wrongWay = await as.accounts.post(`/advances/${a.body.id}/transactions`, {
      version: s.version,
      kind: 'top_up',
      amountPaise: 1_000,
      paidOn: todayIso(),
      mode: 'cash',
    });
    expect(wrongWay.body.error.details[0].path).toBe('kind');
    const tooMuchBack = await as.accounts.post(`/advances/${a.body.id}/transactions`, {
      version: s.version,
      kind: 'return',
      amountPaise: 600_001,
      paidOn: todayIso(),
      mode: 'upi',
      reference: 'R1',
    });
    expect(tooMuchBack.body.error.details[0].path).toBe('amountPaise');
    const back = await as.accounts.post(`/advances/${a.body.id}/transactions`, {
      version: s.version,
      kind: 'return',
      amountPaise: 600_000,
      paidOn: todayIso(),
      mode: 'upi',
      reference: 'R1',
    });
    expect(back.status).toBe(201);
    expect(back.body.settlement.balancePaise).toBe(0);
    expect(back.body.can.close).toBe(true);

    const closed = await as.accounts.post(`/advances/${a.body.id}/close`, {
      version: back.body.version,
    });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('closed');
    expect(closed.body.events.map((e: { type: string }) => e.type)).toEqual([
      'created',
      'submitted',
      'approved',
      'approved',
      'disbursed',
      'return_recorded',
      'closed',
    ]);

    // A closed advance takes no new claims.
    expect((await as.employee.get('/advances/linkable')).body.data).toEqual([]);
    const late = await as.employee.post('/vouchers', {
      purpose: 'x',
      advanceId: a.body.id,
      lines: [line(1_000)],
    });
    expect(late.body.error.details[0].path).toBe('advanceId');
  });

  it('pays the employee the shortfall when claims exceed the advance', async () => {
    const a = await openAdvance(1_000_000);
    await claim(a.id, 1_250_000);
    const s = await get(a.id);
    expect(s.settlement).toMatchObject({ balancePaise: -250_000, payablePaise: 250_000 });
    const over = await as.accounts.post(`/advances/${a.id}/transactions`, {
      version: s.version,
      kind: 'top_up',
      amountPaise: 250_001,
      paidOn: todayIso(),
      mode: 'cash',
    });
    expect(over.status).toBe(400);
    const top = await as.accounts.post(`/advances/${a.id}/transactions`, {
      version: s.version,
      kind: 'top_up',
      amountPaise: 250_000,
      paidOn: todayIso(),
      mode: 'cash',
    });
    expect(top.body.settlement).toMatchObject({ topUpPaise: 250_000, balancePaise: 0 });
    // A mistaken entry is reversed, not deleted, and the balance comes back.
    const tx = top.body.transactions.find((x: { kind: string }) => x.kind === 'top_up');
    const rev = await as.accounts.post(`/advances/${a.id}/transactions/${tx.id}/reverse`, {
      version: top.body.version,
      reason: 'Paid twice by mistake',
    });
    expect(rev.body.settlement.payablePaise).toBe(250_000);
    expect(rev.body.transactions).toHaveLength(2);
  });

  it('never allocates or pays a claim twice', async () => {
    const a = await openAdvance(1_000_000);
    const v = await claim(a.id, 400_000);
    // Paying it on its own is refused, by the API and by the database.
    const pay = await as.accounts.post(`/vouchers/${v.id}/payments`, {
      version: v.version,
      amountPaise: 400_000,
      paidOn: todayIso(),
      mode: 'cash',
    });
    expect(pay.status).toBe(409);
    await expect(
      t.db.execute(sql`update vouchers set paid_paise = 1 where id = ${v.id}`),
    ).rejects.toThrow();
    // A voucher holds one advance at most, and only its own employee's open one.
    const b = await openAdvance(500_000, as.other);
    const theirs = await as.employee.post('/vouchers', {
      purpose: 'x',
      advanceId: b.id,
      lines: [line(1_000)],
    });
    expect(theirs.body.error.details[0].path).toBe('advanceId');
    // Counted once in the settlement.
    expect((await get(a.id)).settlement.approvedExpensesPaise).toBe(400_000);
  });

  it('allows one active advance per person, within the admin limit', async () => {
    const first = await as.employee.post('/advances', {
      purpose: 'Trip one',
      requestedPaise: 100_000,
      expectedDate: todayIso(),
    });
    await as.employee.post(`/advances/${first.body.id}/submit`, { version: 1 });
    const second = await as.employee.post('/advances', {
      purpose: 'Trip two',
      requestedPaise: 100_000,
      expectedDate: todayIso(),
    });
    const blocked = await as.employee.post(`/advances/${second.body.id}/submit`, { version: 1 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/already have an active advance/);

    expect(
      (await as.employee.put('/admin/settings/advances', { maxAdvancePaise: 50_000 })).status,
    ).toBe(403);
    const set = await as.admin.put('/admin/settings/advances', { maxAdvancePaise: 50_000 });
    expect(set.body).toEqual({ maxAdvancePaise: 50_000 });
    expect((await as.other.get('/advances/settings')).body.maxAdvancePaise).toBe(50_000);
    const big = await as.other.post('/advances', {
      purpose: 'Big trip',
      requestedPaise: 60_000,
      expectedDate: todayIso(),
    });
    const capped = await as.other.post(`/advances/${big.body.id}/submit`, { version: 1 });
    expect(capped.body.error.details[0].path).toBe('requestedPaise');
  });

  it("routes an Accounts user's request to the Director and keeps them off their own money", async () => {
    const a = await openAdvance(300_000, as.accounts, [as.director]);
    expect(a.status).toBe('open');
    const own = await as.accounts.post(`/advances/${a.id}/transactions`, {
      version: a.version,
      kind: 'return',
      amountPaise: 1_000,
      paidOn: todayIso(),
      mode: 'cash',
    });
    expect(own.status).toBe(403);
  });

  it('returns and rejects with a reason, and lets the employee resubmit or cancel', async () => {
    const draft = await as.employee.post('/advances', {
      purpose: 'Trip',
      requestedPaise: 100_000,
      expectedDate: todayIso(),
    });
    const sub = (await as.employee.post(`/advances/${draft.body.id}/submit`, { version: 1 })).body;
    const ret = await as.manager.post(`/advances/${sub.id}/return`, {
      version: sub.version,
      message: 'Add the client name',
    });
    expect(ret.body.status).toBe('returned');
    const edit = await as.employee.patch(`/advances/${sub.id}`, {
      version: ret.body.version,
      purpose: 'Trip to Acme, Pune',
      requestedPaise: 90_000,
      expectedDate: todayIso(),
    });
    expect(edit.status).toBe(200);
    const again = await as.employee.post(`/advances/${sub.id}/submit`, {
      version: edit.body.version,
    });
    expect(again.body.status).toBe('pending_manager');
    const cancelled = await as.employee.post(`/advances/${sub.id}/cancel`, {
      version: again.body.version,
      reason: 'Trip postponed',
    });
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.events.map((e: { type: string }) => e.type)).toContain('resubmitted');

    // Self-approval is impossible: the manager's own request skips them.
    const own = await as.manager.post('/advances', {
      purpose: 'Mine',
      requestedPaise: 1_000,
      expectedDate: todayIso(),
    });
    const ownSub = await as.manager.post(`/advances/${own.body.id}/submit`, { version: 1 });
    expect(ownSub.body.status).toBe('pending_accounts');
  });

  it('reverses a payout only while nothing depends on it', async () => {
    const a = await openAdvance(500_000);
    const payout = (await get(a.id)).transactions as { id: string }[];
    await claim(a.id, 100_000, false);
    const s = await get(a.id);
    const blocked = await as.accounts.post(
      `/advances/${a.id}/transactions/${payout[0]!.id}/reverse`,
      {
        version: s.version,
        reason: 'Wrong account',
      },
    );
    expect(blocked.status).toBe(409);

    const b = await openAdvance(500_000, as.other);
    const bp = (await get(b.id)).transactions as { id: string }[];
    const ok = await as.accounts.post(`/advances/${b.id}/transactions/${bp[0]!.id}/reverse`, {
      version: b.version,
      reason: 'Bank returned it',
    });
    expect(ok.body).toMatchObject({ status: 'approved', settleBy: null });
    expect(ok.body.can.disburse).toBe(true);
  });

  it('lists advances by view, flags overdue ones, and shows them on the dashboard', async () => {
    const a = await openAdvance(500_000);
    const pending = await as.other.post('/advances', {
      purpose: 'Other trip',
      requestedPaise: 10_000,
      expectedDate: todayIso(),
    });
    await as.other.post(`/advances/${pending.body.id}/submit`, { version: 1 });

    expect((await as.manager.get('/advances?view=review')).body.meta.total).toBe(1);
    expect((await as.manager.get('/advances?view=disburse')).status).toBe(403);
    expect((await as.employee.get('/advances?view=review')).status).toBe(403);
    expect((await as.employee.get('/advances')).body.data[0]).toMatchObject({
      id: a.id,
      status: 'open',
    });
    expect((await as.other.get('/advances')).body.data).toHaveLength(1);

    await t.db.execute(sql`update advances set settle_by = '2020-01-01' where id = ${a.id}`);
    const open = await as.accounts.get('/advances?view=open');
    expect(open.body.data[0]).toMatchObject({ id: a.id, overdue: true });
    expect(open.body.data[0].settlement.disbursedPaise).toBe(500_000);
    expect((await as.accounts.get('/advances?view=all&overdue=true')).body.meta.total).toBe(1);
    expect((await as.accounts.get('/advances/counts')).body).toEqual({
      review: 0,
      disburse: 0,
      overdue: 1,
    });
    expect((await as.manager.get('/advances/counts')).body.review).toBe(1);

    const dash = await as.accounts.get('/accounts/dashboard');
    expect(dash.body.openAdvances).toEqual({ count: 1, amountPaise: 500_000, overdue: 1 });
  });
});
