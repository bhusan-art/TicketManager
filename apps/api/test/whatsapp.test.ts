import type { Role } from '@ticketmanager/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { categories, users } from '../src/db/schema.js';
import { bearer, describeWithDb, makeUser, signIn, testServices, useTestDb } from './helpers.js';

describeWithDb('WhatsApp click-to-chat', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  let travel: string;
  let as: Record<'employee' | 'manager' | 'accounts' | 'admin', ReturnType<typeof client>>;
  let ids: Record<'employee' | 'manager' | 'accounts', string>;

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
      patch: (path: string, body: object) =>
        request(ctx.app).patch(`/api/v1${path}`).set(auth).send(body),
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
    const manager = await makeUser(t.db, {
      name: 'Amit Verma',
      roles: ['manager', 'employee'],
      whatsappNumber: '919811100001',
    });
    const employee = await makeUser(t.db, {
      name: 'Rahul Das',
      managerId: manager.id,
      whatsappNumber: '919811100002',
    });
    const accounts = await makeUser(t.db, { name: 'Neha Joshi', roles: ['accounts'] });
    const admin = await makeUser(t.db, { name: 'Admin', roles: ['admin'] });
    ids = { employee: employee.id, manager: manager.id, accounts: accounts.id };
    as = {
      employee: await login(employee.email),
      manager: await login(manager.email, 'manager'),
      accounts: await login(accounts.email),
      admin: await login(admin.email),
    };
  });

  async function submitted() {
    const draft = await as.employee.post('/vouchers', {
      purpose: 'Client visit',
      lines: [
        {
          categoryId: travel,
          expenseDate: '2026-11-18',
          description: 'Cab',
          amountPaise: 45_000,
          missingProofReason: 'No receipt',
        },
      ],
    });
    const res = await as.employee.post(`/vouchers/${draft.body.id}/submit`, { version: 1 });
    expect(res.status).toBe(200);
    return res.body as { id: string; number: string; version: number };
  }

  it('saves a WhatsApp number from the user form, read as an Indian mobile by default', async () => {
    const created = await as.admin.post('/admin/users', {
      email: 'priya@company.com',
      name: 'Priya Nair',
      roles: ['employee'],
      whatsappNumber: '98765 43210',
      sendInvite: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.whatsappNumber).toBe('919876543210');

    const bad = await as.admin.patch(`/admin/users/${created.body.id}`, {
      whatsappNumber: '12345',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('whatsappNumber');

    const cleared = await as.admin.patch(`/admin/users/${created.body.id}`, { whatsappNumber: '' });
    expect(cleared.body.whatsappNumber).toBeNull();
  });

  it('lets people update their own number', async () => {
    const res = await as.accounts.put('/auth/me/whatsapp', { whatsappNumber: '+44 7700 900123' });
    expect(res.status).toBe(200);
    expect(res.body.whatsappNumber).toBe('447700900123');
    const [u] = await t.db.select().from(users).where(eq(users.id, ids.accounts));
    expect(u!.whatsappNumber).toBe('447700900123');
    expect((await as.accounts.put('/auth/me/whatsapp', { whatsappNumber: 'nope' })).status).toBe(
      400,
    );
  });

  it('gives the approver a ready message to the employee about their question', async () => {
    const v = await submitted();
    await as.manager.post(`/vouchers/${v.id}/query`, {
      version: v.version,
      message: 'Which client was this?',
    });
    const res = await as.manager.get(`/vouchers/${v.id}/whatsapp`);
    expect(res.status).toBe(200);
    expect(res.body.missing).toEqual([]);
    const [s] = res.body.suggestions;
    expect(s).toMatchObject({
      to: { id: ids.employee, name: 'Rahul Das' },
      number: '919811100002',
    });
    expect(s.text).toBe(
      `Hi Rahul, Amit Verma has a question about your expense claim ${v.number} (Client visit, ₹450.00):\n\n“Which client was this?”\n\nPlease answer it in TicketManager.\n\nhttp://localhost:9080/expenses/${v.id}`,
    );
    expect(s.url).toBe(`https://wa.me/919811100002?text=${encodeURIComponent(s.text)}`);
  });

  it('gives the employee a reminder for whoever holds the claim, and names who has no number', async () => {
    const v = await submitted();
    const toManager = await as.employee.get(`/vouchers/${v.id}/whatsapp`);
    expect(toManager.body.suggestions).toHaveLength(1);
    expect(toManager.body.suggestions[0].text).toBe(
      `Hi Amit, a gentle reminder: my expense claim ${v.number} (Client visit, ₹450.00) is waiting for your approval.\n\nhttp://localhost:9080/approvals/${v.id}`,
    );

    await as.manager.post(`/vouchers/${v.id}/approve`, { version: v.version });
    const toAccounts = await as.employee.get(`/vouchers/${v.id}/whatsapp`);
    expect(toAccounts.body).toEqual({
      suggestions: [],
      missing: [{ id: ids.accounts, name: 'Neha Joshi' }],
    });
    // Someone who can't see the claim gets nothing.
    const stranger = await makeUser(t.db, { name: 'Stranger' });
    const s = await login(stranger.email);
    expect((await s.get(`/vouchers/${v.id}/whatsapp`)).status).toBe(404);
  });

  it('works for advances too', async () => {
    const draft = await as.employee.post('/advances', {
      purpose: 'Site visit',
      requestedPaise: 1_000_000,
      expectedDate: '2026-11-30',
    });
    const a = (await as.employee.post(`/advances/${draft.body.id}/submit`, { version: 1 })).body;
    const mine = await as.employee.get(`/advances/${a.id}/whatsapp`);
    expect(mine.body.suggestions[0].text).toContain('my advance');
    expect(mine.body.suggestions[0].to.name).toBe('Amit Verma');
    await as.manager.post(`/advances/${a.id}/return`, {
      version: a.version,
      message: 'Split hotel and travel',
    });
    const back = await as.manager.get(`/advances/${a.id}/whatsapp`);
    expect(back.body.suggestions[0].text).toContain('returned your advance request');
    expect(back.body.suggestions[0].text).toContain('“Split hotel and travel”');
  });
});
