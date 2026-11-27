import { Router } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { backupRuns, emailOutbox } from '../src/db/schema.js';
import { createRateLimiter } from '../src/http/middleware/rateLimit.js';
import {
  bearer,
  describeWithDb,
  makeUser,
  signIn,
  testApp,
  testServices,
  useTestDb,
} from './helpers.js';

describe('rate limiter', () => {
  it('counts per address and window, then answers 429 with Retry-After', async () => {
    let now = 0;
    const { limit } = createRateLimiter(() => now);
    const router = Router();
    router.get('/', limit('try', { max: 2, windowMs: 60_000 }), (_req, res) => {
      res.json({ ok: true });
    });
    const app = testApp({ routers: { '/try': router } });
    expect((await request(app).get('/api/v1/try')).status).toBe(200);
    expect((await request(app).get('/api/v1/try')).status).toBe(200);
    const blocked = await request(app).get('/api/v1/try');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
    expect(blocked.body.error).toMatchObject({ code: 'RATE_LIMITED' });
    expect(blocked.body.error.message).toMatch(/Try again in 1 minute/);
    now = 60_001;
    expect((await request(app).get('/api/v1/try')).status).toBe(200);
  });
});

describeWithDb('sign-in rate limit and system status', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  beforeAll(() => {
    ctx = testServices(t.db);
  });

  it('limits sign-in attempts per address, before checking the password', async () => {
    await makeUser(t.db, { email: 'rahul@company.com' });
    const app = testApp({
      services: ctx.services,
      rateLimits: {
        login: { max: 3, windowMs: 60_000 },
        passwordForgot: { max: 1, windowMs: 60_000 },
        passwordReset: { max: 1, windowMs: 60_000 },
        google: { max: 1, windowMs: 60_000 },
        exportLink: { max: 1, windowMs: 60_000 },
      },
    });
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@company.com', password: 'wrong' });
      expect(res.status).toBe(401);
    }
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'rahul@company.com', password: 'wrong' });
    expect(res.status).toBe(429);

    await request(app).post('/api/v1/auth/password/forgot').send({ email: 'a@b.com' }).expect(204);
    await request(app).post('/api/v1/auth/password/forgot').send({ email: 'a@b.com' }).expect(429);
    const link = `/api/v1/exports/download/${'x'.repeat(43)}`;
    expect((await request(app).get(link)).status).not.toBe(429);
    await request(app).get(link).expect(429);
  });

  it('shows Admins the services, worker, email backlog and backups', async () => {
    await makeUser(t.db, { email: 'admin@company.com', roles: ['admin'] });
    await makeUser(t.db, { email: 'rahul@company.com' });
    const app = testApp({
      services: ctx.services,
      healthChecks: { database: async () => true, worker: async () => false },
      workerLastSeen: async () => '2026-11-26T10:00:00.000Z',
    });
    const admin = (await signIn(app, 'admin@company.com')).token;
    const rahul = (await signIn(app, 'rahul@company.com')).token;
    await request(app).get('/api/v1/admin/system').set(bearer(rahul)).expect(403);

    let res = await request(app).get('/api/v1/admin/system').set(bearer(admin)).expect(200);
    expect(res.body).toMatchObject({
      checks: { database: 'up', worker: 'down' },
      worker: { lastSeenAt: '2026-11-26T10:00:00.000Z' },
      backups: { lastSuccessAt: null, overdue: true, recent: [] },
    });

    await t.db.insert(emailOutbox).values([
      { kind: 'notification', to: ['a@b.com'], subject: 'One', text: 'x', status: 'pending' },
      { kind: 'notification', to: ['a@b.com'], subject: 'Two', text: 'x', status: 'failed' },
    ]);
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000);
    await t.db.insert(backupRuns).values([
      {
        status: 'ok',
        file: 'ticketmanager-old.dump',
        sizeBytes: 1000,
        startedAt: old,
        finishedAt: old,
      },
      { status: 'failed', error: 'pg_dump: disk full', startedAt: new Date() },
    ]);
    res = await request(app).get('/api/v1/admin/system').set(bearer(admin)).expect(200);
    expect(res.body.email).toMatchObject({ pending: 1, failed: 1 });
    expect(res.body.backups.overdue).toBe(true);
    expect(res.body.backups.recent.map((r: { status: string }) => r.status)).toEqual([
      'failed',
      'ok',
    ]);

    await t.db.insert(backupRuns).values({
      status: 'ok',
      file: 'ticketmanager-new.dump',
      sizeBytes: 2048,
      startedAt: new Date(),
    });
    res = await request(app).get('/api/v1/admin/system').set(bearer(admin)).expect(200);
    expect(res.body.backups.overdue).toBe(false);
    expect(res.body.backups.recent[0]).toMatchObject({
      file: 'ticketmanager-new.dump',
      sizeBytes: 2048,
    });
  });
});
