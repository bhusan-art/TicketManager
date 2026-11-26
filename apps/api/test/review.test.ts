import type { Role } from '@ticketmanager/shared';
import request from 'supertest';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { categories } from '../src/db/schema.js';
import { bearer, describeWithDb, makeUser, signIn, testServices, useTestDb } from './helpers.js';

const PDF = Buffer.from('%PDF-1.4\n%test\n%%EOF\n');

describeWithDb('approval workflow', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  let travel: string;
  let ids: Record<'employee' | 'manager' | 'accounts' | 'director', string>;
  let as: Record<'employee' | 'manager' | 'accounts' | 'director', ReturnType<typeof client>>;

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
      upload: (path: string) =>
        request(ctx.app).post(`/api/v1${path}`).set(auth).attach('file', PDF, 'extra.pdf'),
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
    const accounts = await makeUser(t.db, { name: 'Neha Joshi', roles: ['accounts', 'employee'] });
    const director = await makeUser(t.db, { name: 'Dev Rao', roles: ['director'] });
    ids = {
      employee: employee.id,
      manager: manager.id,
      accounts: accounts.id,
      director: director.id,
    };
    as = {
      employee: await login(employee.email),
      manager: await login(manager.email, 'manager'),
      accounts: await login(accounts.email, 'accounts'),
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

  /** Creates and submits a voucher as `who`. Returns its id and current version. */
  async function submitted(who = as.employee, lines = [line(72_000), line(28_000, 'Metro')]) {
    const draft = await who.post('/vouchers', { purpose: 'Client visit', lines });
    const res = await who.post(`/vouchers/${draft.body.id}/submit`, {
      version: draft.body.version,
    });
    expect(res.status).toBe(200);
    return res.body as {
      id: string;
      version: number;
      lines: { id: string }[];
      approvalStatus: string;
    };
  }

  it('runs the full chain: manager approves, Accounts approves part of it', async () => {
    const v = await submitted();
    expect(v.approvalStatus).toBe('pending_manager');

    // Accounts can see it but can't act before the manager.
    const early = await as.accounts.post(`/vouchers/${v.id}/approve`, { version: v.version });
    expect(early.status).toBe(409);

    const m = await as.manager.post(`/vouchers/${v.id}/approve`, {
      version: v.version,
      note: 'Fine',
    });
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({
      approvalStatus: 'pending_accounts',
      approvedTotalPaise: 100_000,
      waitingOn: 'Accounts',
      paymentStatus: 'not_due',
    });

    // Opening it as Accounts starts review; the employee can no longer cancel.
    const opened = await as.accounts.post(`/vouchers/${v.id}/start-review`);
    expect(opened.body.accountsReviewStartedAt).toBeTruthy();
    expect((await as.employee.get(`/vouchers/${v.id}`)).body.can.cancel).toBe(false);

    const tooMuch = await as.accounts.post(`/vouchers/${v.id}/approve`, {
      version: opened.body.version,
      lines: [{ id: v.lines[0]!.id, approvedPaise: 80_000 }],
    });
    expect(tooMuch.status).toBe(400);
    const noNote = await as.accounts.post(`/vouchers/${v.id}/approve`, {
      version: opened.body.version,
      lines: [{ id: v.lines[0]!.id, approvedPaise: 50_000 }],
    });
    expect(noNote.body.error.details[0].path).toBe('lines.0.note');

    const a = await as.accounts.post(`/vouchers/${v.id}/approve`, {
      version: opened.body.version,
      lines: [{ id: v.lines[0]!.id, approvedPaise: 50_000, note: 'Cab capped at ₹500' }],
    });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({
      approvalStatus: 'partially_approved',
      paymentStatus: 'payment_pending',
      approvedTotalPaise: 78_000,
      waitingOn: null,
    });
    expect(a.body.lines[0]).toMatchObject({
      approvedPaise: 50_000,
      reviewNote: 'Cab capped at ₹500',
    });
    expect(a.body.lines[1].approvedPaise).toBe(28_000);
    expect(a.body.events.map((e: { type: string }) => e.type)).toEqual([
      'created',
      'submitted',
      'approved',
      'review_started',
      'approved',
    ]);
    // Nothing more can happen to it in this phase.
    const again = await as.accounts.post(`/vouchers/${v.id}/reject`, {
      version: a.body.version,
      message: 'Changed my mind',
    });
    expect(again.status).toBe(409);
  });

  it('refuses to approve nothing', async () => {
    const v = await submitted();
    const res = await as.manager.post(`/vouchers/${v.id}/approve`, {
      version: v.version,
      lines: v.lines.map((l) => ({ id: l.id, approvedPaise: 0, note: 'No' })),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Reject');
  });

  it('manager query: the employee answers, may add a bill, and it returns to the manager', async () => {
    const v = await submitted();
    const q = await as.manager.post(`/vouchers/${v.id}/query`, {
      version: v.version,
      message: 'Please attach the taxi bill',
    });
    expect(q.body).toMatchObject({ approvalStatus: 'manager_query', waitingOn: 'Employee' });
    expect((await as.employee.get(`/vouchers/${v.id}`)).body.can.cancel).toBe(true);

    // The employee can add a bill but not change the lines.
    const up = await as.employee.upload(`/vouchers/${v.id}/lines/${v.lines[0]!.id}/attachments`);
    expect(up.status).toBe(201);
    const edit = await as.employee.patch(`/vouchers/${v.id}`, {
      version: up.body.version,
      lines: [],
    });
    expect(edit.status).toBe(409);
    // The manager can't approve while waiting on the employee.
    expect(
      (await as.manager.post(`/vouchers/${v.id}/approve`, { version: up.body.version })).status,
    ).toBe(409);

    const ans = await as.employee.post(`/vouchers/${v.id}/answer`, {
      version: up.body.version,
      message: 'Attached now',
    });
    expect(ans.body.approvalStatus).toBe('pending_manager');
    expect(ans.body.events.map((e: { type: string }) => e.type)).toEqual([
      'created',
      'submitted',
      'queried',
      'attachment_added',
      'answered',
    ]);
  });

  it('Accounts query goes straight to the employee with the manager copied, and back to Accounts', async () => {
    const v = await submitted();
    const m = await as.manager.post(`/vouchers/${v.id}/approve`, { version: v.version });
    const q = await as.accounts.post(`/vouchers/${v.id}/query`, {
      version: m.body.version,
      message: 'Which client?',
    });
    expect(q.body.approvalStatus).toBe('accounts_query');
    const queried = q.body.events.at(-1);
    expect(queried.meta).toEqual({ cc: ids.manager });
    expect(q.body.accountsReviewStartedAt).toBeTruthy();
    // The manager still sees it.
    expect((await as.manager.get(`/vouchers/${v.id}`)).status).toBe(200);

    const ans = await as.employee.post(`/vouchers/${v.id}/answer`, {
      version: q.body.version,
      message: 'Acme Ltd',
    });
    expect(ans.body.approvalStatus).toBe('pending_accounts');
  });

  it('return: the employee edits and resubmits, and review starts over at the manager', async () => {
    const v = await submitted();
    const m = await as.manager.post(`/vouchers/${v.id}/approve`, {
      version: v.version,
      lines: [{ id: v.lines[0]!.id, approvedPaise: 60_000, note: 'Too high' }],
    });
    const r = await as.accounts.post(`/vouchers/${v.id}/return`, {
      version: m.body.version,
      message: 'Split the hotel and cab',
    });
    expect(r.body).toMatchObject({ approvalStatus: 'returned', can: { edit: false } });

    const mine = (await as.employee.get(`/vouchers/${v.id}`)).body;
    expect(mine.can).toMatchObject({ edit: true, submit: true, delete: false, cancel: false });
    const edited = await as.employee.patch(`/vouchers/${v.id}`, {
      version: mine.version,
      purpose: 'Client visit (split)',
      lines: [{ ...line(70_000), id: v.lines[0]!.id }],
    });
    expect(edited.status).toBe(200);
    const re = await as.employee.post(`/vouchers/${v.id}/submit`, { version: edited.body.version });
    expect(re.body).toMatchObject({
      approvalStatus: 'pending_manager',
      number: mine.number,
      approvedTotalPaise: null,
      totalPaise: 70_000,
    });
    expect(re.body.lines[0].approvedPaise).toBeNull();
    expect(re.body.events.at(-1).type).toBe('resubmitted');
  });

  it('reject is final', async () => {
    const v = await submitted();
    const r = await as.manager.post(`/vouchers/${v.id}/reject`, {
      version: v.version,
      message: 'Personal expense',
    });
    expect(r.body).toMatchObject({ approvalStatus: 'manager_rejected', waitingOn: null });
    const mine = (await as.employee.get(`/vouchers/${v.id}`)).body;
    expect(mine.can).toMatchObject({ edit: false, submit: false, cancel: false, answer: false });
    expect(
      (await as.employee.post(`/vouchers/${v.id}/submit`, { version: mine.version })).status,
    ).toBe(409);
  });

  it('a message is required to query, return or reject', async () => {
    const v = await submitted();
    for (const step of ['query', 'return', 'reject']) {
      const res = await as.manager.post(`/vouchers/${v.id}/${step}`, { version: v.version });
      expect(res.status).toBe(400);
    }
  });

  it('nobody approves their own claim, whatever roles they hold', async () => {
    // An Accounts user's claim goes to the Director.
    const own = await submitted(as.accounts);
    expect(own.approvalStatus).toBe('pending_director');
    // A manager's claim goes to Accounts; the manager can't approve it even as Accounts.
    const both = await makeUser(t.db, { roles: ['manager', 'accounts', 'employee'] });
    const asManager = await login(both.email, 'manager');
    const mine = await submitted(asManager);
    expect(mine.approvalStatus).toBe('pending_director');
    const asAccounts = await login(both.email, 'accounts');
    const res = await asAccounts.post(`/vouchers/${mine.id}/approve`, { version: mine.version });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('your own claim');

    // The Director approves the Accounts user's claim.
    const d = await as.director.post(`/vouchers/${own.id}/approve`, { version: own.version });
    expect(d.body).toMatchObject({ approvalStatus: 'approved', paymentStatus: 'payment_pending' });
  });

  it("only the employee's own manager reviews at the manager stage", async () => {
    const v = await submitted();
    const other = await makeUser(t.db, { roles: ['manager'] });
    const otherClient = await login(other.email);
    expect((await otherClient.get(`/vouchers/${v.id}`)).status).toBe(404);
    expect(
      (await otherClient.post(`/vouchers/${v.id}/approve`, { version: v.version })).status,
    ).toBe(404);
    // The right manager, in the employee role, can't approve either.
    const managerAsEmployee = await login(
      (await t.db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, ids.manager) }))!.email,
      'employee',
    );
    expect(
      (await managerAsEmployee.post(`/vouchers/${v.id}/approve`, { version: v.version })).status,
    ).toBe(409);
  });

  it('rejects a stale version', async () => {
    const v = await submitted();
    await as.manager.post(`/vouchers/${v.id}/comments`, { message: 'Looking at it' });
    // Comments don't bump the version.
    const ok = await as.manager.post(`/vouchers/${v.id}/query`, {
      version: v.version,
      message: 'Which client?',
    });
    expect(ok.status).toBe(200);
    const stale = await as.employee.post(`/vouchers/${v.id}/answer`, {
      version: v.version,
      message: 'Acme',
    });
    expect(stale.status).toBe(409);
  });

  it('comments appear on the timeline for everyone who can see the voucher', async () => {
    const v = await submitted();
    await as.employee.post(`/vouchers/${v.id}/comments`, { message: 'Urgent please' });
    const c = await as.manager.post(`/vouchers/${v.id}/comments`, { message: 'Will do today' });
    expect(c.status).toBe(201);
    const comments = c.body.events.filter((e: { type: string }) => e.type === 'comment');
    expect(
      comments.map((e: { actor: { name: string }; message: string }) => [e.actor.name, e.message]),
    ).toEqual([
      ['Rahul Das', 'Urgent please'],
      ['Amit Verma', 'Will do today'],
    ]);
    const stranger = await login((await makeUser(t.db)).email);
    expect(
      (await stranger.post(`/vouchers/${v.id}/comments`, { message: 'Hi there' })).status,
    ).toBe(404);
  });

  it('lists queues per approver, never including their own claims', async () => {
    const a = await submitted();
    const b = await submitted();
    await as.manager.post(`/vouchers/${a.id}/query`, {
      version: a.version,
      message: 'Which client?',
    });

    const pending = await as.manager.get('/approvals?view=pending');
    expect(pending.body.data.map((x: { id: string }) => x.id)).toEqual([b.id]);
    expect(pending.body.data[0]).toMatchObject({
      employee: { name: 'Rahul Das' },
      approvalStatus: 'pending_manager',
    });
    expect((await as.manager.get('/approvals/counts')).body).toEqual({ pending: 1, queried: 1 });
    expect(
      (await as.manager.get('/approvals?view=done')).body.data.map((x: { id: string }) => x.id),
    ).toEqual([a.id]);

    // Accounts sees only what the manager passed on, and not their own claims.
    await submitted(as.accounts);
    expect((await as.accounts.get('/approvals')).body.meta.total).toBe(0);
    await as.manager.post(`/vouchers/${b.id}/approve`, { version: b.version });
    const acc = await as.accounts.get('/approvals?search=rahul');
    expect(acc.body.data.map((x: { id: string }) => x.id)).toEqual([b.id]);
    expect((await as.director.get('/approvals')).body.meta.total).toBe(1);
    expect((await as.employee.get('/approvals')).status).toBe(403);
  });
});
