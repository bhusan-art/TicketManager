import { todayIso, type SearchResponse } from '@ticketmanager/shared';
import request from 'supertest';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { categories } from '../src/db/schema.js';
import { bearer, describeWithDb, makeUser, signIn, testServices, useTestDb } from './helpers.js';

const PDF = Buffer.from('%PDF-1.4\n%test\n');

describeWithDb('search', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  let admin: Record<string, string>;
  let neha: Record<string, string>;
  let amit: Record<string, string>;
  let rahul: Record<string, string>;
  let priya: Record<string, string>;
  let travel: string;

  beforeAll(() => {
    ctx = testServices(t.db);
  });

  const get = (auth: Record<string, string>, q: string) =>
    request(ctx.app).get('/api/v1/search').query({ q }).set(auth);
  const post = (auth: Record<string, string>, path: string, body: object = {}) =>
    request(ctx.app).post(`/api/v1${path}`).set(auth).send(body);

  beforeEach(async () => {
    await makeUser(t.db, { email: 'admin@company.com', roles: ['admin'] });
    await makeUser(t.db, { email: 'neha@company.com', name: 'Neha Joshi', roles: ['accounts'] });
    const manager = await makeUser(t.db, { email: 'amit@company.com', roles: ['manager'] });
    await makeUser(t.db, {
      email: 'rahul@company.com',
      name: 'Rahul Das',
      employeeCode: 'EMP-1024',
      managerId: manager.id,
    });
    await makeUser(t.db, { email: 'priya@company.com', name: 'Priya Nair' });
    admin = bearer((await signIn(ctx.app, 'admin@company.com')).token);
    neha = bearer((await signIn(ctx.app, 'neha@company.com')).token);
    amit = bearer((await signIn(ctx.app, 'amit@company.com')).token);
    rahul = bearer((await signIn(ctx.app, 'rahul@company.com')).token);
    priya = bearer((await signIn(ctx.app, 'priya@company.com')).token);
    [{ id: travel }] = (await t.db
      .insert(categories)
      .values({ name: 'Travel' })
      .returning({ id: categories.id })) as [{ id: string }];
  });

  async function claim(purpose: string, send: boolean) {
    const res = await post(rahul, '/vouchers', {
      purpose,
      lines: [
        { categoryId: travel, expenseDate: todayIso(), description: 'Cab', amountPaise: 45_000 },
      ],
    });
    expect(res.status).toBe(201);
    if (!send) return res.body;
    await request(ctx.app)
      .post(`/api/v1/vouchers/${res.body.id}/lines/${res.body.lines[0].id}/attachments`)
      .set(rahul)
      .attach('file', PDF, 'bill.pdf');
    const v = (await request(ctx.app).get(`/api/v1/vouchers/${res.body.id}`).set(rahul)).body;
    const sent = await post(rahul, `/vouchers/${v.id}/submit`, { version: v.version });
    expect(sent.status).toBe(200);
    return sent.body;
  }

  it('finds only what each person may open', async () => {
    const sent = await claim('Client visit to Pune', true);
    const draft = await claim('Pune hotel, not sent', false);
    const adv = await post(rahul, '/advances', {
      purpose: 'Pune trip',
      requestedPaise: 1_000_000,
      expectedDate: todayIso(),
    });
    await post(rahul, `/advances/${adv.body.id}/submit`, { version: 1 });

    // The employee finds their claims, drafts included, and opens them from My expenses.
    const own = (await get(rahul, 'pune').expect(200)).body as SearchResponse;
    expect(own.claims.map((c) => c.id).sort()).toEqual([sent.id, draft.id].sort());
    expect(own.claims.find((c) => c.id === sent.id)).toMatchObject({
      path: `/expenses/${sent.id}`,
      title: 'Client visit to Pune',
      amountPaise: 45_000,
      status: 'pending_manager',
    });
    expect(own.advances).toHaveLength(1);
    expect(own.people).toEqual([]);

    // The manager finds the submitted claim by the employee's name or code, not the draft.
    const mgr = (await get(amit, 'rahul').expect(200)).body as SearchResponse;
    expect(mgr.claims.map((c) => c.id)).toEqual([sent.id]);
    expect(mgr.claims[0]!.path).toBe(`/approvals/${sent.id}`);
    expect((await get(amit, 'emp-1024')).body.claims).toHaveLength(1);

    // Accounts sees every submitted claim and opens it from Verification.
    const acc = (await get(neha, 'pune').expect(200)).body as SearchResponse;
    expect(acc.claims.map((c) => c.path)).toEqual([`/verification/${sent.id}`]);
    expect(acc.advances).toHaveLength(1);

    // Someone else finds nothing.
    const other = (await get(priya, 'pune').expect(200)).body as SearchResponse;
    expect(other).toEqual({ claims: [], advances: [], people: [] });

    // Searching by the claim number works too.
    expect((await get(neha, sent.number)).body.claims).toHaveLength(1);
  });

  it('lets admins find people, and needs two characters', async () => {
    const res = (await get(admin, 'priya').expect(200)).body as SearchResponse;
    expect(res.people).toHaveLength(1);
    expect(res.people[0]).toMatchObject({ title: 'Priya Nair' });
    expect(res.people[0]!.path).toMatch(/^\/admin\/users\//);
    expect(res.claims).toEqual([]);
    await get(admin, 'p').expect(400);
    await get(admin, '%_').expect(200);
  });
});
