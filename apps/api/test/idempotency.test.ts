import { sql } from 'drizzle-orm';
import { Router } from 'express';
import request from 'supertest';
import { beforeAll, expect, it } from 'vitest';
import { idempotencyKeys } from '../src/db/schema.js';
import { pruneIdempotencyKeys } from '../src/http/middleware/idempotency.js';
import { describeWithDb, testApp, useTestDb } from './helpers.js';

let created = 0;
const router = Router();
router.post('/things', (req, res) => {
  created += 1;
  res.status(201).json({ id: created, ...req.body });
});
router.post('/fails', (_req, res) => {
  res.status(500).json({ error: { code: 'INTERNAL', message: 'x' } });
});

describeWithDb('idempotency', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>;
  beforeAll(() => {
    app = testApp({ db: t.db, routers: { '/t': router } });
  });

  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('replays the first response for a retry with the same key', async () => {
    created = 0;
    const first = await request(app)
      .post('/api/v1/t/things')
      .set('Idempotency-Key', 'key-aaaaaaaa')
      .send({ name: 'Taxi' });
    await settle();
    const retry = await request(app)
      .post('/api/v1/t/things')
      .set('Idempotency-Key', 'key-aaaaaaaa')
      .send({ name: 'Taxi' });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(created).toBe(1);
  });

  it('rejects the same key with a different body', async () => {
    await request(app)
      .post('/api/v1/t/things')
      .set('Idempotency-Key', 'key-bbbbbbbb')
      .send({ name: 'Taxi' });
    await settle();
    const res = await request(app)
      .post('/api/v1/t/things')
      .set('Idempotency-Key', 'key-bbbbbbbb')
      .send({ name: 'Hotel' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('does not cache server errors, so a retry runs again', async () => {
    await request(app).post('/api/v1/t/fails').set('Idempotency-Key', 'key-cccccccc').send({});
    await settle();
    const res = await request(app)
      .post('/api/v1/t/fails')
      .set('Idempotency-Key', 'key-cccccccc')
      .send({});
    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });

  it('treats an expired key as new', async () => {
    created = 0;
    await request(app).post('/api/v1/t/things').set('Idempotency-Key', 'key-dddddddd').send({});
    await settle();
    await t.db.update(idempotencyKeys).set({ createdAt: sql`now() - interval '25 hours'` });
    await request(app).post('/api/v1/t/things').set('Idempotency-Key', 'key-dddddddd').send({});
    expect(created).toBe(2);
  });

  it('prunes expired keys', async () => {
    await t.db.insert(idempotencyKeys).values([
      {
        id: 'old',
        requestHash: 'h',
        status: 'completed',
        createdAt: sql`now() - interval '2 days'`,
      },
      { id: 'new', requestHash: 'h', status: 'completed' },
    ]);
    await pruneIdempotencyKeys(t.db);
    const rows = await t.db.select({ id: idempotencyKeys.id }).from(idempotencyKeys);
    expect(rows).toEqual([{ id: 'new' }]);
  });

  it('passes requests without a key straight through', async () => {
    created = 0;
    await request(app).post('/api/v1/t/things').send({});
    await request(app).post('/api/v1/t/things').send({});
    expect(created).toBe(2);
  });

  it('rejects a malformed key', async () => {
    const res = await request(app).post('/api/v1/t/things').set('Idempotency-Key', 'x').send({});
    expect(res.status).toBe(400);
  });
});
