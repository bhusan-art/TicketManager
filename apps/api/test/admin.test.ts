import request from 'supertest';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema.js';
import { bearer, describeWithDb, makeUser, signIn, testServices, useTestDb } from './helpers.js';

describeWithDb('admin: users and departments', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  let auth: { Authorization: string };
  let adminId: string;

  beforeAll(() => {
    ctx = testServices(t.db);
  });
  beforeEach(async () => {
    const admin = await makeUser(t.db, { roles: ['admin', 'employee'] });
    adminId = admin.id;
    auth = bearer((await signIn(ctx.app, admin.email)).token);
    ctx.mailer.sent.length = 0;
  });

  const post = (path: string, body: object) =>
    request(ctx.app).post(`/api/v1/admin${path}`).set(auth).send(body);
  const patch = (path: string, body: object) =>
    request(ctx.app).patch(`/api/v1/admin${path}`).set(auth).send(body);

  it('is closed to signed-out callers and to non-admins', async () => {
    expect((await request(ctx.app).get('/api/v1/admin/users')).status).toBe(401);
    const employee = await makeUser(t.db);
    const { token } = await signIn(ctx.app, employee.email);
    expect((await request(ctx.app).get('/api/v1/admin/users').set(bearer(token))).status).toBe(403);
  });

  it('creates a user and emails an invite that lets them set a password', async () => {
    const res = await post('/users', {
      email: 'Neha@Company.com',
      name: 'Neha Joshi',
      employeeCode: 'EMP-1024',
      roles: ['employee'],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      email: 'neha@company.com',
      employeeCode: 'EMP-1024',
      hasPassword: false,
      status: 'active',
    });

    expect(ctx.mailer.sent).toHaveLength(1);
    const link = ctx.mailer.sent[0]!.text.match(/https?:\/\/\S+/)![0];
    expect(link).toContain('/set-password?token=');
    const token = new URL(link).searchParams.get('token');
    const set = await request(ctx.app)
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'Welcome#2026' });
    expect(set.status).toBe(204);
    await signIn(ctx.app, 'neha@company.com', 'Welcome#2026');

    const audit = await t.db.select().from(auditLog);
    expect(audit.map((a) => a.action)).toContain('user.created');
  });

  it('rejects a duplicate email', async () => {
    const existing = await makeUser(t.db);
    const res = await post('/users', { email: existing.email, name: 'X', roles: ['employee'] });
    expect(res.status).toBe(409);
  });

  it('only allows a reporting manager who has the Manager role', async () => {
    const notManager = await makeUser(t.db);
    const res = await post('/users', {
      email: 'a@company.com',
      name: 'A',
      roles: ['employee'],
      managerId: notManager.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('managerId');
  });

  it('prevents reporting loops and self-reporting', async () => {
    const top = await makeUser(t.db, { roles: ['employee', 'manager'] });
    const middle = await makeUser(t.db, { roles: ['employee', 'manager'], managerId: top.id });
    expect((await patch(`/users/${top.id}`, { managerId: middle.id })).status).toBe(400);
    expect((await patch(`/users/${top.id}`, { managerId: top.id })).status).toBe(400);
  });

  it('keeps the Manager role while people still report to the user', async () => {
    const manager = await makeUser(t.db, { roles: ['employee', 'manager'] });
    await makeUser(t.db, { managerId: manager.id });
    const res = await patch(`/users/${manager.id}`, { roles: ['employee'] });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ activeReports: 1 });
  });

  it('never removes the last active admin', async () => {
    expect((await patch(`/users/${adminId}`, { roles: ['employee'] })).status).toBe(409);
    expect((await patch(`/users/${adminId}`, { status: 'inactive' })).status).toBe(409);
    await makeUser(t.db, { roles: ['admin'] });
    expect(
      (await patch(`/users/${adminId}`, { roles: ['employee', 'admin', 'accounts'] })).status,
    ).toBe(200);
  });

  it('signs a user out when they are deactivated', async () => {
    const user = await makeUser(t.db);
    const { cookie } = await signIn(ctx.app, user.email);
    expect((await patch(`/users/${user.id}`, { status: 'inactive' })).status).toBe(200);
    expect((await request(ctx.app).post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(
      401,
    );
  });

  it('lists users with search, role filter and pagination', async () => {
    await makeUser(t.db, { name: 'Amit Verma', roles: ['employee', 'manager'] });
    await makeUser(t.db, { name: 'Amita Rao' });
    await makeUser(t.db, { name: 'Rohan Das' });

    const search = await request(ctx.app).get('/api/v1/admin/users?search=amit').set(auth);
    expect(search.body.data.map((u: { name: string }) => u.name)).toEqual([
      'Amit Verma',
      'Amita Rao',
    ]);

    const managers = await request(ctx.app).get('/api/v1/admin/users?role=manager').set(auth);
    expect(managers.body.data.map((u: { name: string }) => u.name)).toEqual(['Amit Verma']);

    const paged = await request(ctx.app).get('/api/v1/admin/users?pageSize=2&page=2').set(auth);
    expect(paged.body.meta).toMatchObject({ page: 2, pageSize: 2, total: 4, totalPages: 2 });
  });

  it('manages departments with a head and member count', async () => {
    const head = await makeUser(t.db, { roles: ['employee', 'manager'] });
    const created = await post('/departments', {
      name: 'Engineering',
      code: 'ENG',
      headId: head.id,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Engineering',
      head: { id: head.id },
      activeMembers: 0,
    });

    const dev = await post('/users', {
      email: 'dev@company.com',
      name: 'Dev',
      roles: ['employee'],
      departmentId: created.body.id,
      managerId: head.id,
      sendInvite: false,
    });
    expect(dev.status, JSON.stringify(dev.body)).toBe(201);
    const list = await request(ctx.app).get('/api/v1/admin/departments').set(auth);
    expect(list.body.data[0].activeMembers).toBe(1);

    expect((await post('/departments', { name: 'Engineering' })).status).toBe(409);

    const renamed = await patch(`/departments/${created.body.id}`, { name: 'Product Engineering' });
    expect(renamed.body.name).toBe('Product Engineering');
  });

  it('will not put a user in an inactive department', async () => {
    const dept = await post('/departments', { name: 'Old', status: 'inactive' });
    const res = await post('/users', {
      email: 'b@company.com',
      name: 'B',
      roles: ['employee'],
      departmentId: dept.body.id,
    });
    expect(res.status).toBe(400);
  });
});
