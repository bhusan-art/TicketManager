import request from 'supertest';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { categories } from '../src/db/schema.js';
import { bearer, describeWithDb, makeUser, signIn, testServices, useTestDb } from './helpers.js';

const PDF = Buffer.from('%PDF-1.4\n%test\n');

describeWithDb('projects and employment types', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  let admin: Record<string, string>;
  let accounts: Record<string, string>;
  let rahul: Record<string, string>;
  let neha: Record<string, string>;
  let managerId: string;
  let travel: string;

  beforeAll(() => {
    ctx = testServices(t.db);
  });

  const as = (auth: Record<string, string>) => ({
    get: (path: string) => request(ctx.app).get(`/api/v1${path}`).set(auth),
    post: (path: string, body: object = {}) =>
      request(ctx.app).post(`/api/v1${path}`).set(auth).send(body),
    patch: (path: string, body: object) =>
      request(ctx.app).patch(`/api/v1${path}`).set(auth).send(body),
    upload: (path: string) =>
      request(ctx.app).post(`/api/v1${path}`).set(auth).attach('file', PDF, 'bill.pdf'),
  });

  beforeEach(async () => {
    await makeUser(t.db, { email: 'admin@company.com', roles: ['admin'] });
    await makeUser(t.db, { email: 'neha@company.com', name: 'Neha Joshi', roles: ['accounts'] });
    const amit = await makeUser(t.db, { email: 'amit@company.com', roles: ['manager'] });
    managerId = amit.id;
    await makeUser(t.db, { email: 'rahul@company.com', name: 'Rahul Das', managerId });
    await makeUser(t.db, { email: 'priya@company.com', name: 'Priya Nair' });
    admin = bearer((await signIn(ctx.app, 'admin@company.com')).token);
    accounts = bearer((await signIn(ctx.app, 'neha@company.com')).token);
    rahul = bearer((await signIn(ctx.app, 'rahul@company.com')).token);
    neha = accounts;
    [{ id: travel }] = (await t.db
      .insert(categories)
      .values({ name: 'Travel' })
      .returning({ id: categories.id })) as [{ id: string }];
  });

  async function submit(auth: Record<string, string>, projectId: string | null, amount: number) {
    const res = await as(auth).post('/vouchers', {
      purpose: 'Site visit',
      projectId,
      lines: [
        {
          categoryId: travel,
          expenseDate: '2026-11-18',
          description: 'Cab to site',
          amountPaise: amount,
        },
      ],
    });
    expect(res.status).toBe(201);
    await as(auth).upload(`/vouchers/${res.body.id}/lines/${res.body.lines[0].id}/attachments`);
    const v = (await as(auth).get(`/vouchers/${res.body.id}`)).body;
    const sent = await as(auth).post(`/vouchers/${v.id}/submit`, { version: v.version });
    expect(sent.status).toBe(200);
    return sent.body;
  }

  it('admins manage projects; everyone sees the active ones', async () => {
    const created = await as(admin).post('/projects', { name: 'Metro line', code: 'PRJ-104' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Metro line', code: 'PRJ-104', status: 'active' });
    await as(admin).post('/projects', { name: 'Metro line' }).expect(409);
    await as(admin).post('/projects', { name: 'Other', code: 'PRJ-104' }).expect(409);
    await as(rahul).post('/projects', { name: 'Mine' }).expect(403);

    const old = await as(admin).post('/projects', { name: 'Old site' });
    await as(admin).patch(`/projects/${old.body.id}`, { status: 'inactive' }).expect(200);
    expect(
      (await as(rahul).get('/projects')).body.data.map((p: { name: string }) => p.name),
    ).toEqual(['Metro line']);
    expect((await as(accounts).get('/projects?all=true')).body.data).toHaveLength(2);
  });

  it('books a voucher to a project, refuses a closed one, and totals spend per project', async () => {
    const metro = (await as(admin).post('/projects', { name: 'Metro line', code: 'PRJ-104' })).body;
    const bridge = (await as(admin).post('/projects', { name: 'Bridge' })).body;
    const closed = (await as(admin).post('/projects', { name: 'Closed', status: 'inactive' })).body;

    const bad = await as(rahul).post('/vouchers', {
      purpose: 'x',
      projectId: closed.id,
      lines: [],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0]).toMatchObject({ path: 'projectId' });

    const v1 = await submit(rahul, metro.id, 100_000);
    expect(v1.project).toEqual({ id: metro.id, name: 'PRJ-104 · Metro line' });
    const priya = bearer((await signIn(ctx.app, 'priya@company.com')).token);
    await submit(priya, metro.id, 50_000);
    await submit(priya, bridge.id, 20_000);
    await submit(rahul, null, 5_000);

    // A project closed after drafting blocks submission until another is chosen.
    const draft = (
      await as(rahul).post('/vouchers', { purpose: 'Later', projectId: bridge.id, lines: [] })
    ).body;
    await as(admin).patch(`/projects/${bridge.id}`, { status: 'inactive' });
    const blocked = await as(rahul).post(`/vouchers/${draft.id}/submit`, {
      version: draft.version,
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.details.some((d: { path: string }) => d.path === 'projectId')).toBe(
      true,
    );

    const report = (await as(neha).get('/reports')).body;
    const byName = Object.fromEntries(
      report.byProject.map((r: { key: { name: string } | null }) => [r.key?.name ?? 'none', r]),
    );
    expect(byName['Metro line']).toMatchObject({
      code: 'PRJ-104',
      vouchers: 2,
      employees: 2,
      claimedPaise: 150_000,
    });
    expect(byName.Bridge).toMatchObject({ vouchers: 1, claimedPaise: 20_000 });
    expect(byName.none).toMatchObject({ vouchers: 1, claimedPaise: 5_000 });

    const filtered = (await as(neha).get(`/reports?projectId=${metro.id}`)).body;
    expect(filtered.totals).toMatchObject({ vouchers: 2, claimedPaise: 150_000 });
    const none = (await as(neha).get('/reports?projectId=none')).body;
    expect(none.totals).toMatchObject({ vouchers: 1, claimedPaise: 5_000 });

    // Queues filter by project too. Priya has no manager, so hers wait on Accounts.
    const queue = (await as(neha).get(`/approvals?projectId=${metro.id}`)).body;
    expect(queue.data.map((v: { project: { id: string } }) => v.project.id)).toEqual([metro.id]);
    expect(queue.data[0].employee.name).toBe('Priya Nair');
  });

  it('needs a reporting manager for contractual employees only', async () => {
    const noManager = await as(admin).post('/admin/users', {
      email: 'temp@company.com',
      name: 'Temp Worker',
      roles: ['employee'],
      employmentType: 'contractual',
      sendInvite: false,
    });
    expect(noManager.status).toBe(400);
    expect(noManager.body.error.details[0]).toMatchObject({
      path: 'managerId',
      message: 'Contractual employees need a reporting manager',
    });

    const created = await as(admin).post('/admin/users', {
      email: 'temp@company.com',
      name: 'Temp Worker',
      roles: ['employee'],
      employmentType: 'contractual',
      managerId,
      sendInvite: false,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ employmentType: 'contractual' });
    // Removing the manager of a contractual employee is refused...
    await as(admin).patch(`/admin/users/${created.body.id}`, { managerId: null }).expect(400);
    // ...but fine once they are regular.
    const regular = await as(admin).patch(`/admin/users/${created.body.id}`, {
      employmentType: 'regular',
      managerId: null,
    });
    expect(regular.status).toBe(200);
    expect(regular.body).toMatchObject({ employmentType: 'regular', manager: null });
    // A regular user without a manager cannot become contractual without one.
    await as(admin)
      .patch(`/admin/users/${created.body.id}`, { employmentType: 'contractual' })
      .expect(400);
  });

  it('sends an advance from a regular employee with no manager to Accounts', async () => {
    const priya = bearer((await signIn(ctx.app, 'priya@company.com')).token);
    const a = await as(priya).post('/advances', {
      purpose: 'Site trip',
      requestedPaise: 500_000,
      expectedDate: '2099-12-10',
    });
    expect(a.status).toBe(201);
    const sent = await as(priya).post(`/advances/${a.body.id}/submit`, { version: a.body.version });
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe('pending_accounts');
  });
});
