import { todayIso } from '@ticketmanager/shared';
import request from 'supertest';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { categories } from '../src/db/schema.js';
import { bearer, describeWithDb, makeUser, signIn, testServices, useTestDb } from './helpers.js';

describeWithDb('chat on a claim or advance', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  let rahul: Record<string, string>;
  let amit: Record<string, string>;
  let neha: Record<string, string>;
  let other: Record<string, string>;
  let travel: string;

  beforeAll(() => {
    ctx = testServices(t.db);
  });

  const as = (auth: Record<string, string>) => ({
    get: (path: string) => request(ctx.app).get(`/api/v1${path}`).set(auth),
    post: (path: string, body: object = {}) =>
      request(ctx.app).post(`/api/v1${path}`).set(auth).send(body),
  });

  beforeEach(async () => {
    const manager = await makeUser(t.db, {
      email: 'amit@company.com',
      name: 'Amit Verma',
      roles: ['manager'],
    });
    await makeUser(t.db, { email: 'rahul@company.com', name: 'Rahul Das', managerId: manager.id });
    await makeUser(t.db, { email: 'neha@company.com', name: 'Neha Joshi', roles: ['accounts'] });
    await makeUser(t.db, { email: 'sita@company.com', name: 'Sita Rao' });
    rahul = bearer((await signIn(ctx.app, 'rahul@company.com')).token);
    amit = bearer((await signIn(ctx.app, 'amit@company.com')).token);
    neha = bearer((await signIn(ctx.app, 'neha@company.com')).token);
    other = bearer((await signIn(ctx.app, 'sita@company.com')).token);
    [{ id: travel }] = (await t.db
      .insert(categories)
      .values({ name: 'Travel' })
      .returning({ id: categories.id })) as [{ id: string }];
  });

  async function draftClaim() {
    const res = await as(rahul).post('/vouchers', {
      purpose: 'Pune trip',
      lines: [
        {
          categoryId: travel,
          expenseDate: todayIso(),
          description: 'Cab',
          amountPaise: 45_000,
          missingProofReason: 'No receipt given',
        },
      ],
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; version: number };
  }

  const titles = async (who: Record<string, string>) =>
    (await as(who).get('/notifications?unread=true')).body.data.map(
      (n: { title: string }) => n.title,
    ) as string[];

  it('lets the employee and reviewers talk on a submitted claim', async () => {
    const draft = await draftClaim();
    // No chat until it is submitted.
    expect((await as(rahul).get(`/vouchers/${draft.id}/chat`)).body.canPost).toBe(false);
    await as(rahul).post(`/vouchers/${draft.id}/chat`, { body: 'Hi' }).expect(409);

    const v = (await as(rahul).post(`/vouchers/${draft.id}/submit`, { version: 1 })).body;
    await as(rahul).post(`/vouchers/${v.id}/chat`, { body: '   ' }).expect(400);

    // The employee asks; the manager holding it hears about it.
    const first = await as(rahul).post(`/vouchers/${v.id}/chat`, { body: 'Is the cab bill ok?' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      author: { name: 'Rahul Das' },
      authorRole: 'employee',
      body: 'Is the cab bill ok?',
    });
    expect(await titles(amit)).toContain(`New message on ${v.number}`);

    // A second message before Amit reads it does not pile up another notification.
    await as(rahul).post(`/vouchers/${v.id}/chat`, { body: 'It was a late night ride' });
    expect((await titles(amit)).filter((x) => x.startsWith('New message'))).toHaveLength(1);

    // Reading the chat clears it and shows the messages in order.
    const thread = (await as(amit).get(`/vouchers/${v.id}/chat`)).body;
    expect(thread.canPost).toBe(true);
    expect(thread.messages.map((m: { body: string }) => m.body)).toEqual([
      'Is the cab bill ok?',
      'It was a late night ride',
    ]);
    expect(await titles(amit)).not.toContain(`New message on ${v.number}`);

    await as(amit).post(`/vouchers/${v.id}/chat`, { body: 'Fine, approving' }).expect(201);
    expect(await titles(rahul)).toContain(`New message on ${v.number}`);

    // Polling for new messages only returns the newer ones.
    const after = thread.messages[1].id;
    const newer = (await as(rahul).get(`/vouchers/${v.id}/chat?after=${after}`)).body.messages;
    expect(newer.map((m: { body: string }) => m.body)).toEqual(['Fine, approving']);

    // Accounts sees it once it reaches them; outsiders never do.
    await as(neha).get(`/vouchers/${v.id}/chat`).expect(200);
    await as(other).get(`/vouchers/${v.id}/chat`).expect(404);
    await as(other).post(`/vouchers/${v.id}/chat`, { body: 'hi' }).expect(404);
  });

  it('works on an advance too', async () => {
    const draft = await as(rahul).post('/advances', {
      purpose: 'Site visit',
      requestedPaise: 500_000,
      expectedDate: todayIso(),
    });
    const a = (await as(rahul).post(`/advances/${draft.body.id}/submit`, { version: 1 })).body;
    await as(amit).post(`/advances/${a.id}/chat`, { body: 'Which site?' }).expect(201);
    expect(await titles(rahul)).toContain(`New message on ${a.number}`);
    const thread = (await as(rahul).get(`/advances/${a.id}/chat`)).body;
    expect(thread.messages).toHaveLength(1);
    await as(other).get(`/advances/${a.id}/chat`).expect(404);
  });
});
