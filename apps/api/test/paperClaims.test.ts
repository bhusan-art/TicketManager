import { todayIso } from '@ticketmanager/shared';
import request from 'supertest';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { categories, users } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { bearer, describeWithDb, makeUser, signIn, testServices, useTestDb } from './helpers.js';

const PDF = Buffer.from('%PDF-1.4\n%test\n');

describeWithDb('paper claims typed in by Accounts', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  let neha: Record<string, string>;
  let rahul: Record<string, string>;
  let amit: Record<string, string>;
  let rahulId: string;
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
      request(ctx.app).post(`/api/v1${path}`).set(auth).attach('file', PDF, 'paper form.pdf'),
  });

  beforeEach(async () => {
    await makeUser(t.db, { email: 'neha@company.com', name: 'Neha Joshi', roles: ['accounts'] });
    const manager = await makeUser(t.db, { email: 'amit@company.com', roles: ['manager'] });
    rahulId = (
      await makeUser(t.db, {
        email: 'rahul@company.com',
        name: 'Rahul Das',
        employeeCode: 'EMP-1024',
        managerId: manager.id,
      })
    ).id;
    neha = bearer((await signIn(ctx.app, 'neha@company.com')).token);
    rahul = bearer((await signIn(ctx.app, 'rahul@company.com')).token);
    amit = bearer((await signIn(ctx.app, 'amit@company.com')).token);
    [{ id: travel }] = (await t.db
      .insert(categories)
      .values({ name: 'Travel' })
      .returning({ id: categories.id })) as [{ id: string }];
  });

  const line = () => ({
    categoryId: travel,
    expenseDate: todayIso(),
    description: 'Cab',
    amountPaise: 45_000,
  });

  it('lets Accounts type in, finish and send a claim for an employee', async () => {
    const claimants = await as(neha).get('/vouchers/claimants?search=emp-10').expect(200);
    expect(claimants.body.data).toEqual([
      expect.objectContaining({ id: rahulId, name: 'Rahul Das', employeeCode: 'EMP-1024' }),
    ]);

    const created = await as(neha).post('/vouchers', {
      employeeId: rahulId,
      purpose: 'Client visit (paper claim)',
      lines: [line()],
    });
    expect(created.status).toBe(201);
    expect(created.body.employee.id).toBe(rahulId);
    expect(created.body.enteredBy).toMatchObject({ name: 'Neha Joshi' });
    expect(created.body.can).toMatchObject({ edit: true, submit: true, delete: true });
    const id = created.body.id as string;

    // Both the employee and the person who typed it in see the draft.
    expect((await as(rahul).get('/vouchers')).body.data.map((v: { id: string }) => v.id)).toEqual([
      id,
    ]);
    expect((await as(neha).get('/vouchers?entered=true')).body.data).toHaveLength(1);
    expect((await as(neha).get('/vouchers')).body.data).toHaveLength(0);
    await as(rahul).get('/vouchers?entered=true').expect(403);

    // Accounts attaches the scanned form and sends it on.
    await as(neha)
      .upload(`/vouchers/${id}/lines/${created.body.lines[0].id}/attachments`)
      .expect(201);
    const v = (await as(neha).get(`/vouchers/${id}`)).body;
    const sent = await as(neha).post(`/vouchers/${id}/submit`, { version: v.version });
    expect(sent.status).toBe(200);
    expect(sent.body.approvalStatus).toBe('pending_manager');
    expect(sent.body.can.edit).toBe(false);

    // The manager reviews it as usual, and the employee is told it is in the app.
    expect((await as(amit).get('/approvals')).body.data).toHaveLength(1);
    const notes = (await as(rahul).get('/notifications')).body.data;
    expect(notes.map((n: { title: string }) => n.title)).toContain(
      `${sent.body.number} was entered from your paper claim`,
    );
  });

  it('keeps paper entry to Accounts and active employees', async () => {
    const body = { employeeId: rahulId, purpose: 'x', lines: [] };
    await as(amit).post('/vouchers', body).expect(403);
    await as(rahul).get('/vouchers/claimants').expect(403);

    await t.db.update(users).set({ status: 'inactive' }).where(eq(users.id, rahulId));
    const res = await as(neha).post('/vouchers', body);
    expect(res.status).toBe(400);
  });

  it('gives a returned paper claim back to the employee', async () => {
    const created = (
      await as(neha).post('/vouchers', {
        employeeId: rahulId,
        purpose: 'Paper claim',
        lines: [line()],
      })
    ).body;
    await as(neha).upload(`/vouchers/${created.id}/lines/${created.lines[0].id}/attachments`);
    let v = (await as(neha).get(`/vouchers/${created.id}`)).body;
    v = (await as(neha).post(`/vouchers/${v.id}/submit`, { version: v.version })).body;
    const back = await as(amit).post(`/vouchers/${v.id}/return`, {
      version: v.version,
      message: 'Add the hotel bill',
    });
    expect(back.body).toMatchObject({ approvalStatus: 'returned' });
    expect((await as(rahul).get(`/vouchers/${v.id}`)).body.can.edit).toBe(true);
    expect((await as(neha).get(`/vouchers/${v.id}`)).body.can.edit).toBe(false);
  });
});
