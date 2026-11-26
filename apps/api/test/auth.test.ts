import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, expect, it } from 'vitest';
import { sessions, users } from '../src/db/schema.js';
import {
  bearer,
  describeWithDb,
  fakeGoogle,
  makeUser,
  signIn,
  TEST_PASSWORD,
  testServices,
  useTestDb,
} from './helpers.js';

describeWithDb('sign-in and sessions', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  beforeAll(() => {
    ctx = testServices(t.db);
  });

  it('signs in with email and password and sets an httpOnly refresh cookie', async () => {
    const user = await makeUser(t.db, {
      email: 'rahul@company.com',
      roles: ['employee', 'manager'],
    });
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: ' Rahul@Company.com ', password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user).toMatchObject({
      id: user.id,
      activeRole: 'manager',
      roles: ['employee', 'manager'],
    });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/tm_refresh=.+HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const user = await makeUser(t.db);
    const wrong = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'Wrong#2026' });
    const unknown = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'Wrong#2026' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks the account for 15 minutes after 5 wrong passwords', async () => {
    const user = await makeUser(t.db);
    for (let i = 0; i < 5; i++) {
      await request(ctx.app)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'Nope#1234' });
    }
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD });
    expect(res.status).toBe(429);
  });

  it('refuses an inactive user', async () => {
    const user = await makeUser(t.db, { status: 'inactive' });
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD });
    expect(res.status).toBe(403);
  });

  it('returns the signed-in user from /me and 401 without a token', async () => {
    const user = await makeUser(t.db);
    const { token } = await signIn(ctx.app, user.email);
    expect((await request(ctx.app).get('/api/v1/auth/me')).status).toBe(401);
    const me = await request(ctx.app).get('/api/v1/auth/me').set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: user.email, activeRole: 'employee' });
  });

  it('rotates the refresh token, and reuse of an old one ends the whole sign-in', async () => {
    const user = await makeUser(t.db);
    const first = await signIn(ctx.app, user.email);

    const refreshed = await request(ctx.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', first.cookie);
    expect(refreshed.status).toBe(200);
    const second = String(refreshed.headers['set-cookie']).split(';')[0]!;
    expect(second).not.toBe(first.cookie);

    // Pretend the first token was replaced long ago, then present it again (a stolen copy).
    await t.db
      .update(sessions)
      .set({ replacedAt: sql`now() - interval '1 hour'` })
      .where(eq(sessions.userId, user.id));
    const reuse = await request(ctx.app).post('/api/v1/auth/refresh').set('Cookie', first.cookie);
    expect(reuse.status).toBe(401);

    const afterReuse = await request(ctx.app).post('/api/v1/auth/refresh').set('Cookie', second);
    expect(afterReuse.status).toBe(401);
  });

  it('tolerates two tabs refreshing at once', async () => {
    const user = await makeUser(t.db);
    const { cookie } = await signIn(ctx.app, user.email);
    await request(ctx.app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    const late = await request(ctx.app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(late.status).toBe(409);
    expect(late.headers['set-cookie']).toBeUndefined(); // the other tab's cookie is left alone
    const revoked = await t.db.$count(
      sessions,
      sql`${sessions.userId} = ${user.id} and ${sessions.revokedAt} is not null`,
    );
    expect(revoked).toBe(0);
  });

  it('logs out by revoking the refresh token', async () => {
    const user = await makeUser(t.db);
    const { cookie } = await signIn(ctx.app, user.email);
    expect((await request(ctx.app).post('/api/v1/auth/logout').set('Cookie', cookie)).status).toBe(
      204,
    );
    expect((await request(ctx.app).post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(
      401,
    );
  });

  it('switches only to roles the user holds', async () => {
    const user = await makeUser(t.db, { roles: ['employee', 'manager'] });
    const { token, cookie } = await signIn(ctx.app, user.email);

    const ok = await request(ctx.app)
      .post('/api/v1/auth/switch-role')
      .set(bearer(token))
      .send({ role: 'employee' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.activeRole).toBe('employee');

    const denied = await request(ctx.app)
      .post('/api/v1/auth/switch-role')
      .set(bearer(token))
      .send({ role: 'admin' });
    expect(denied.status).toBe(403);

    // The switch sticks across a refresh.
    const refreshed = await request(ctx.app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(refreshed.body.user.activeRole).toBe('employee');
  });

  it('checks the active role, not just the roles held', async () => {
    const user = await makeUser(t.db, { roles: ['employee', 'admin'] });
    const { token } = await signIn(ctx.app, user.email);
    expect((await request(ctx.app).get('/api/v1/admin/users').set(bearer(token))).status).toBe(200);

    const switched = await request(ctx.app)
      .post('/api/v1/auth/switch-role')
      .set(bearer(token))
      .send({ role: 'employee' });
    const asEmployee = await request(ctx.app)
      .get('/api/v1/admin/users')
      .set(bearer(switched.body.accessToken));
    expect(asEmployee.status).toBe(403);
  });

  it('stops accepting a deactivated user’s access token at once', async () => {
    const user = await makeUser(t.db);
    const { token } = await signIn(ctx.app, user.email);
    await t.db.update(users).set({ status: 'inactive' }).where(eq(users.id, user.id));
    expect((await request(ctx.app).get('/api/v1/auth/me').set(bearer(token))).status).toBe(401);
  });
});

describeWithDb('passwords', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  beforeAll(() => {
    ctx = testServices(t.db);
  });

  const tokenFrom = (text: string) =>
    new URL(text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;

  it('emails a reset link only to real, active accounts and always answers 204', async () => {
    const user = await makeUser(t.db);
    ctx.mailer.sent.length = 0;
    const known = await request(ctx.app)
      .post('/api/v1/auth/password/forgot')
      .send({ email: user.email });
    const unknown = await request(ctx.app)
      .post('/api/v1/auth/password/forgot')
      .send({ email: 'ghost@example.com' });
    expect(known.status).toBe(204);
    expect(unknown.status).toBe(204);
    expect(ctx.mailer.sent).toHaveLength(1);
    expect(ctx.mailer.sent[0]!.to).toBe(user.email);
    expect(ctx.mailer.sent[0]!.text).toContain('http://localhost:9080/reset-password?token=');
  });

  it('resets the password with the link once, and signs out old sessions', async () => {
    const user = await makeUser(t.db);
    const old = await signIn(ctx.app, user.email);
    ctx.mailer.sent.length = 0;
    await request(ctx.app).post('/api/v1/auth/password/forgot').send({ email: user.email });
    const token = tokenFrom(ctx.mailer.sent[0]!.text);

    const weak = await request(ctx.app)
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'weak' });
    expect(weak.status).toBe(400);

    const reset = await request(ctx.app)
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'Brand#New2026' });
    expect(reset.status).toBe(204);
    const again = await request(ctx.app)
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'Other#New2026' });
    expect(again.status).toBe(400);

    expect(
      (await request(ctx.app).post('/api/v1/auth/refresh').set('Cookie', old.cookie)).status,
    ).toBe(401);
    await signIn(ctx.app, user.email, 'Brand#New2026');
  });

  it('changes the password, keeping this device signed in and signing out others', async () => {
    const user = await makeUser(t.db);
    const here = await signIn(ctx.app, user.email);
    const elsewhere = await signIn(ctx.app, user.email);

    const wrong = await request(ctx.app)
      .post('/api/v1/auth/password/change')
      .set(bearer(here.token))
      .send({ currentPassword: 'Wrong#2026', newPassword: 'Brand#New2026' });
    expect(wrong.status).toBe(400);

    const ok = await request(ctx.app)
      .post('/api/v1/auth/password/change')
      .set(bearer(here.token))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'Brand#New2026' });
    expect(ok.status).toBe(204);
    expect(
      (await request(ctx.app).post('/api/v1/auth/refresh').set('Cookie', here.cookie)).status,
    ).toBe(200);
    expect(
      (await request(ctx.app).post('/api/v1/auth/refresh').set('Cookie', elsewhere.cookie)).status,
    ).toBe(401);
  });
});

describeWithDb('Google sign-in', () => {
  const t = useTestDb();
  let identity: { sub: string; email: string; emailVerified: boolean } | Error;
  let ctx: ReturnType<typeof testServices>;
  beforeAll(() => {
    ctx = testServices(t.db, { google: fakeGoogle(() => identity) });
  });

  async function googleFlow() {
    const agent = request.agent(ctx.app);
    const start = await agent.get('/api/v1/auth/google/start');
    expect(start.status).toBe(302);
    const state = new URL(start.headers.location!).searchParams.get('state');
    return agent.get(`/api/v1/auth/google/callback?code=abc&state=${state}`);
  }

  it('reports whether Google sign-in is enabled', async () => {
    const res = await request(ctx.app).get('/api/v1/auth/config');
    expect(res.body).toEqual({ googleEnabled: true });
  });

  it('signs in a user the admin created, linking the Google account by email', async () => {
    const user = await makeUser(t.db, { email: 'priya@company.com', password: null });
    identity = { sub: 'google-123', email: 'priya@company.com', emailVerified: true };
    const res = await googleFlow();
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:9080/');
    expect(String(res.headers['set-cookie'])).toContain('tm_refresh=');
    const [row] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(row!.googleSub).toBe('google-123');
  });

  it('turns away a Google account nobody registered', async () => {
    identity = { sub: 'google-999', email: 'stranger@gmail.com', emailVerified: true };
    const res = await googleFlow();
    expect(res.headers.location).toBe('http://localhost:9080/login?error=google_not_registered');
  });

  it('turns away an inactive user', async () => {
    await makeUser(t.db, { email: 'gone@company.com', status: 'inactive' });
    identity = { sub: 'google-555', email: 'gone@company.com', emailVerified: true };
    const res = await googleFlow();
    expect(res.headers.location).toBe('http://localhost:9080/login?error=google_inactive');
  });

  it('rejects a callback whose state does not match', async () => {
    const agent = request.agent(ctx.app);
    await agent.get('/api/v1/auth/google/start');
    const res = await agent.get('/api/v1/auth/google/callback?code=abc&state=forged');
    expect(res.headers.location).toBe('http://localhost:9080/login?error=google_failed');
  });

  it('is off when not configured', async () => {
    const plain = testServices(t.db);
    expect((await request(plain.app).get('/api/v1/auth/config')).body).toEqual({
      googleEnabled: false,
    });
    expect((await request(plain.app).get('/api/v1/auth/google/start')).status).toBe(404);
  });
});
