import type { Role } from '@ticketmanager/shared';
import { todayIso } from '@ticketmanager/shared';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { categories, emailOutbox, notifications, settings } from '../src/db/schema.js';
import {
  bearer,
  describeWithDb,
  makeUser,
  outbox,
  signIn,
  testServices,
  useTestDb,
} from './helpers.js';

type Who = 'employee' | 'manager' | 'accounts' | 'accounts2' | 'director' | 'admin';

describeWithDb('notifications, emails and follow-ups', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  let travel: string;
  let ids: Record<Who, string>;
  let emails: Record<Who, string>;
  let as: Record<Who, ReturnType<typeof client>>;

  beforeAll(() => {
    ctx = testServices(t.db);
  });

  function client(auth: { Authorization: string }) {
    return {
      get: (path: string) => request(ctx.app).get(`/api/v1${path}`).set(auth),
      post: (path: string, body: object = {}) =>
        request(ctx.app).post(`/api/v1${path}`).set(auth).send(body),
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
    const accounts = await makeUser(t.db, { name: 'Neha Joshi', roles: ['accounts', 'employee'] });
    const accounts2 = await makeUser(t.db, { name: 'Ravi Iyer', roles: ['accounts'] });
    const director = await makeUser(t.db, { name: 'Dev Rao', roles: ['director'] });
    const admin = await makeUser(t.db, { name: 'Admin', roles: ['admin'] });
    const all = { employee, manager, accounts, accounts2, director, admin };
    ids = Object.fromEntries(Object.entries(all).map(([k, u]) => [k, u.id])) as typeof ids;
    emails = Object.fromEntries(Object.entries(all).map(([k, u]) => [k, u.email])) as typeof ids;
    as = {
      employee: await login(employee.email),
      manager: await login(manager.email, 'manager'),
      accounts: await login(accounts.email, 'accounts'),
      accounts2: await login(accounts2.email),
      director: await login(director.email),
      admin: await login(admin.email),
    };
    // Signing in sends nothing, but start every test from an empty outbox anyway.
    await t.db.delete(emailOutbox);
  });

  const line = (amountPaise: number) => ({
    categoryId: travel,
    expenseDate: '2026-11-18',
    description: 'Cab',
    amountPaise,
    missingProofReason: 'No receipt given',
  });

  async function submitted() {
    const draft = await as.employee.post('/vouchers', {
      purpose: 'Client visit',
      lines: [line(100_000)],
    });
    const res = await as.employee.post(`/vouchers/${draft.body.id}/submit`, {
      version: draft.body.version,
    });
    expect(res.status).toBe(200);
    return res.body as { id: string; version: number; number: string };
  }

  const inbox = async (who: Who) =>
    t.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, ids[who]))
      .orderBy(notifications.createdAt, notifications.id);

  /** Moves every event back in time, as if `hours` had passed. */
  const age = async (hours: number) => {
    await t.db.execute(sql`update voucher_events set at = at - make_interval(hours => ${hours})`);
    await t.db.execute(sql`update advance_events set at = at - make_interval(hours => ${hours})`);
  };

  it('tells the manager about a new claim, in the app and by email, and never the actor', async () => {
    const v = await submitted();
    const [n] = await inbox('manager');
    expect(n).toMatchObject({
      title: `${v.number} needs your approval`,
      body: 'Rahul Das submitted a claim of ₹1,000.00 for Client visit.',
      link: `/approvals/${v.id}`,
      role: 'manager',
      entityType: 'voucher',
      entityId: v.id,
    });
    expect(await inbox('employee')).toHaveLength(0);
    expect(await inbox('accounts')).toHaveLength(0);

    const mail = await outbox(t.db);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      kind: 'notification',
      to: [emails.manager],
      cc: [],
      subject: `${v.number} needs your approval`,
      link: `/approvals/${v.id}`,
      status: 'pending',
    });
    expect(mail[0]!.text).toMatch(/^Hi Amit Verma,/);
    // The worker is woken once the change has gone through.
    expect(ctx.mailer.wakes()).toBeGreaterThan(0);
  });

  it('after the manager approves, the employee hears and every Accounts user is asked', async () => {
    const v = await submitted();
    await as.manager.post(`/vouchers/${v.id}/approve`, { version: v.version });
    expect((await inbox('employee')).map((n) => n.title)).toEqual([
      `${v.number} approved by Amit Verma`,
    ]);
    for (const who of ['accounts', 'accounts2'] as const) {
      const [n] = await inbox(who);
      expect(n).toMatchObject({ link: `/verification/${v.id}`, role: 'accounts' });
    }
    expect(await inbox('director')).toHaveLength(0);
  });

  it('an Accounts query goes to the employee with the manager copied, and the answer back to the asker', async () => {
    const v = await submitted();
    const m = await as.manager.post(`/vouchers/${v.id}/approve`, { version: v.version });
    await t.db.delete(emailOutbox);
    const q = await as.accounts.post(`/vouchers/${v.id}/query`, {
      version: m.body.version,
      message: 'Which client?',
    });
    expect(q.status).toBe(200);

    const mail = await outbox(t.db);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      to: [emails.employee],
      cc: [emails.manager],
      subject: `Question on ${v.number}`,
    });
    expect(mail[0]!.text).toContain('> Which client?');
    expect(mail[0]!.text).toContain(
      'Neha Joshi asked a question about your claim for Client visit.',
    );
    expect((await inbox('manager')).at(-1)).toMatchObject({
      title: `Question on ${v.number}`,
      link: `/approvals/${v.id}`,
    });
    expect((await inbox('manager')).at(-1)!.body).toContain(
      'Neha Joshi asked Rahul Das a question about their claim for Client visit. You are copied.',
    );
    expect((await inbox('employee')).at(-1)!.body).toContain('“Which client?”');

    await as.employee.post(`/vouchers/${v.id}/answer`, {
      version: q.body.version,
      message: 'Acme Ltd',
    });
    // Only the person who asked hears the answer, not every Accounts user.
    expect((await inbox('accounts')).at(-1)!.title).toBe(
      `Rahul Das answered your question on ${v.number}`,
    );
    expect((await inbox('accounts2')).map((n) => n.title)).not.toContain(
      `Rahul Das answered your question on ${v.number}`,
    );
  });

  it('tells the employee about approval and payment, and Accounts when a Director approves', async () => {
    const v = await submitted();
    const m = await as.manager.post(`/vouchers/${v.id}/approve`, { version: v.version });
    const a = await as.accounts.post(`/vouchers/${v.id}/approve`, { version: m.body.version });
    expect(a.body.paymentStatus).toBe('payment_pending');
    expect((await inbox('employee')).at(-1)).toMatchObject({
      title: `${v.number} approved`,
      body: 'Neha Joshi approved your claim of ₹1,000.00. Accounts will pay it.',
    });
    // Accounts approved it themselves, so no "ready to pay" for Accounts.
    expect((await inbox('accounts2')).map((n) => n.title)).not.toContain(
      `${v.number} is ready to pay`,
    );

    const paid = await as.accounts2.post(`/vouchers/${v.id}/payments`, {
      version: a.body.version,
      paidOn: todayIso(),
      mode: 'bank_transfer',
      reference: 'UTR123456',
      amountPaise: 100_000,
    });
    expect(paid.status).toBe(201);
    expect((await inbox('employee')).at(-1)).toMatchObject({
      title: `${v.number}: ₹1,000.00 paid`,
    });
    expect((await inbox('employee')).at(-1)!.body).toContain('paid in full');
  });

  it('comments reach the people on the claim; cancelling tells the reviewer in the app only', async () => {
    const v = await submitted();
    await as.manager.post(`/vouchers/${v.id}/comments`, { message: 'Looking at it' });
    expect((await inbox('employee')).at(-1)).toMatchObject({
      title: `New comment on ${v.number}`,
    });
    await as.employee.post(`/vouchers/${v.id}/comments`, { message: 'Thanks' });
    expect((await inbox('manager')).at(-1)!.title).toBe(`New comment on ${v.number}`);

    await t.db.delete(emailOutbox);
    const detail = await as.employee.get(`/vouchers/${v.id}`);
    const c = await as.employee.post(`/vouchers/${v.id}/cancel`, {
      version: detail.body.version,
      reason: 'Trip was called off',
    });
    expect(c.status).toBe(200);
    expect((await inbox('manager')).at(-1)!.title).toBe(`${v.number} was cancelled`);
    expect(await outbox(t.db)).toHaveLength(0);
  });

  it('sends no workflow email when email is turned off, but still notifies in the app', async () => {
    const off = await as.admin.put('/admin/settings/notifications', {
      emailEnabled: false,
      followUpCooldownHours: 12,
    });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ emailEnabled: false, followUpCooldownHours: 12 });
    expect((await as.employee.get('/notifications/settings')).body.followUpCooldownHours).toBe(12);
    expect((await as.employee.put('/admin/settings/notifications', off.body)).status).toBe(403);

    await submitted();
    expect(await inbox('manager')).toHaveLength(1);
    expect(await outbox(t.db)).toHaveLength(0);
  });

  it('lists notifications, counts unread and marks them read, only for their owner', async () => {
    const v1 = await submitted();
    const v2 = await submitted();
    const list = await as.manager.get('/notifications');
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBe(2);
    expect(list.body.data[0]).toMatchObject({
      title: `${v2.number} needs your approval`,
      actor: { id: ids.employee, name: 'Rahul Das' },
      readAt: null,
      role: 'manager',
    });
    expect((await as.manager.get('/notifications/unread-count')).body).toEqual({ unread: 2 });

    // Someone else's ids change nothing.
    await as.employee.post('/notifications/read', { ids: [list.body.data[0].id] });
    expect((await as.manager.get('/notifications/unread-count')).body.unread).toBe(2);

    expect(
      (await as.manager.post('/notifications/read', { ids: [list.body.data[0].id] })).status,
    ).toBe(204);
    const unread = await as.manager.get('/notifications?unread=true');
    expect(unread.body.data.map((n: { entityId: string }) => n.entityId)).toEqual([v1.id]);

    await as.manager.post('/notifications/read', { all: true });
    expect((await as.manager.get('/notifications/unread-count')).body.unread).toBe(0);
    expect((await as.manager.post('/notifications/read', { ids: [] })).status).toBe(400);
  });

  it('lets the employee remind whoever holds the claim, once per cooldown', async () => {
    const v = await submitted();
    const early = await as.employee.get(`/vouchers/${v.id}/follow-up`);
    expect(early.body).toMatchObject({
      waitingOn: 'Amit Verma',
      canSend: false,
      cooldownHours: 24,
    });
    expect(early.body.nextAllowedAt).toBeTruthy();
    expect((await as.employee.post(`/vouchers/${v.id}/follow-up`)).status).toBe(409);

    await age(25);
    const state = await as.employee.get(`/vouchers/${v.id}/follow-up`);
    expect(state.body).toMatchObject({ canSend: true, nextAllowedAt: null });
    // Only the employee may send it.
    expect((await as.manager.post(`/vouchers/${v.id}/follow-up`)).status).toBe(403);

    await t.db.delete(emailOutbox);
    const sent = await as.employee.post(`/vouchers/${v.id}/follow-up`, {
      message: 'Need this before month end',
    });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ canSend: false, waitingOn: 'Amit Verma' });
    expect(sent.body.lastSentAt).toBeTruthy();
    expect((await inbox('manager')).at(-1)).toMatchObject({
      title: `Reminder: ${v.number} is waiting for your approval`,
      body: 'Rahul Das sent a reminder about their claim of ₹1,000.00 for Client visit.\n“Need this before month end”',
    });
    const mail = await outbox(t.db);
    expect(mail).toMatchObject([{ kind: 'follow_up', to: [emails.manager] }]);

    // Straight away again: refused.
    const again = await as.employee.post(`/vouchers/${v.id}/follow-up`);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('once every 24 hours');
    const events = (await as.employee.get(`/vouchers/${v.id}`)).body.events;
    expect(events.at(-1)).toMatchObject({ type: 'followed_up', meta: { waitingOn: 'Amit Verma' } });
  });

  it('follow-ups go to Accounts for an approved claim awaiting payment, and nowhere for a draft', async () => {
    const v = await submitted();
    const m = await as.manager.post(`/vouchers/${v.id}/approve`, { version: v.version });
    await as.accounts.post(`/vouchers/${v.id}/approve`, { version: m.body.version });
    await age(25);
    const sent = await as.employee.post(`/vouchers/${v.id}/follow-up`);
    expect(sent.status).toBe(201);
    for (const who of ['accounts', 'accounts2'] as const) {
      expect((await inbox(who)).at(-1)).toMatchObject({
        title: `Reminder: ${v.number} is waiting for your payment`,
        link: `/payments/${v.id}`,
      });
    }

    const draft = await as.employee.post('/vouchers', { purpose: 'Later', lines: [line(5_000)] });
    const state = await as.employee.get(`/vouchers/${draft.body.id}/follow-up`);
    expect(state.body).toMatchObject({ waitingOn: null, canSend: false });
    expect((await as.employee.post(`/vouchers/${draft.body.id}/follow-up`)).status).toBe(409);
    // Someone who can't see the claim gets 404.
    expect((await as.accounts.get(`/vouchers/${draft.body.id}/follow-up`)).status).toBe(404);
  });

  it('notifies along an advance: approval, payout and follow-up', async () => {
    const draft = await as.employee.post('/advances', {
      purpose: 'Site visit to Pune',
      requestedPaise: 2_000_000,
      expectedDate: todayIso(),
    });
    let a = (await as.employee.post(`/advances/${draft.body.id}/submit`, { version: 1 })).body;
    expect((await inbox('manager')).at(-1)).toMatchObject({
      title: `${a.number} needs your approval`,
      link: `/advances/${a.id}`,
      entityType: 'advance',
    });

    await age(25);
    const nudge = await as.employee.post(`/advances/${a.id}/follow-up`);
    expect(nudge.status).toBe(201);
    expect((await inbox('manager')).at(-1)!.title).toBe(
      `Reminder: ${a.number} is waiting for your approval`,
    );

    a = (await as.manager.post(`/advances/${a.id}/approve`, { version: a.version })).body;
    expect((await inbox('accounts')).at(-1)!.title).toBe(`${a.number} needs your approval`);
    a = (await as.accounts.post(`/advances/${a.id}/approve`, { version: a.version })).body;
    expect((await inbox('employee')).at(-1)).toMatchObject({ title: `${a.number} approved` });

    const paid = await as.accounts2.post(`/advances/${a.id}/disburse`, {
      version: a.version,
      amountPaise: 2_000_000,
      paidOn: todayIso(),
      mode: 'bank_transfer',
      reference: 'ADVUTR1',
    });
    expect(paid.status).toBe(201);
    const last = (await inbox('employee')).at(-1)!;
    expect(last.title).toBe(`${a.number}: ₹20,000.00 paid out`);
    expect(last.body).toMatch(/settle it by \d+ \w+ \d{4}\./);
  });

  it('shows Admins the delivery log and retries only failed emails', async () => {
    await submitted();
    await as.admin.post('/admin/users', {
      email: 'new.joiner@example.com',
      name: 'New Joiner',
      roles: ['employee'],
    });
    const log = await as.admin.get('/admin/emails');
    expect(log.status).toBe(200);
    expect(log.body.meta.total).toBe(2);
    expect(log.body.counts).toEqual({ pending: 2, failed: 0 });
    expect(log.body.data.map((e: { kind: string }) => e.kind).sort()).toEqual([
      'invite',
      'notification',
    ]);
    const search = await as.admin.get('/admin/emails?search=joiner');
    expect(search.body.data).toHaveLength(1);
    expect((await as.manager.get('/admin/emails')).status).toBe(403);

    const invite = search.body.data[0];
    expect((await as.admin.post(`/admin/emails/${invite.id}/retry`)).status).toBe(409);
    await t.db
      .update(emailOutbox)
      .set({ status: 'failed', attempts: 6, lastError: 'Connection refused' })
      .where(eq(emailOutbox.id, invite.id));
    expect((await as.admin.get('/admin/emails?status=failed')).body.data).toMatchObject([
      { id: invite.id, lastError: 'Connection refused' },
    ]);
    const wakes = ctx.mailer.wakes();
    const retry = await as.admin.post(`/admin/emails/${invite.id}/retry`);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ status: 'pending', attempts: 0 });
    expect(ctx.mailer.wakes()).toBeGreaterThan(wakes);
  });

  it('keeps no notification or email when the step fails', async () => {
    const v = await submitted();
    await t.db.delete(emailOutbox);
    await t.db.delete(notifications);
    const stale = await as.manager.post(`/vouchers/${v.id}/approve`, { version: v.version - 1 });
    expect(stale.status).toBe(409);
    expect(await outbox(t.db)).toHaveLength(0);
    expect(await inbox('employee')).toHaveLength(0);
    // Settings rows from other tests never leak in.
    expect(await t.db.select().from(settings)).toHaveLength(0);
  });
});
