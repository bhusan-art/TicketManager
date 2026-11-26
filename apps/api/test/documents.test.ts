import type { Role } from '@ticketmanager/shared';
import { and, eq } from 'drizzle-orm';
import { unzipSync, strFromU8 } from 'fflate';
import request from 'supertest';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { auditLog, categories, exportJobs, files, users } from '../src/db/schema.js';
import { bearer, describeWithDb, makeUser, signIn, testServices, useTestDb } from './helpers.js';

const PDF = Buffer.from('%PDF-1.4\n%taxi bill\n%%EOF\n');

type Who = 'employee' | 'other' | 'manager' | 'accounts' | 'director' | 'admin';

/** Collects a binary response body. */
function binary(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

describeWithDb('document centre and audit log', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  let travel: string;
  let ids: Record<Who, string>;
  let as: Record<Who, ReturnType<typeof client>>;

  beforeAll(() => {
    ctx = testServices(t.db);
  });

  function client(auth: { Authorization: string }) {
    return {
      get: (path: string) => request(ctx.app).get(`/api/v1${path}`).set(auth),
      file: (path: string) =>
        request(ctx.app).get(`/api/v1${path}`).set(auth).buffer(true).parse(binary),
      post: (path: string, body: object = {}) =>
        request(ctx.app).post(`/api/v1${path}`).set(auth).send(body),
      upload: (path: string, name = 'Taxi bill.pdf') =>
        request(ctx.app).post(`/api/v1${path}`).set(auth).attach('file', PDF, name),
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
    const manager2 = await makeUser(t.db, { name: 'Sara Khan', roles: ['manager'] });
    const other = await makeUser(t.db, { name: 'Priya Nair', managerId: manager2.id });
    const accounts = await makeUser(t.db, { name: 'Neha Joshi', roles: ['accounts', 'employee'] });
    const director = await makeUser(t.db, { name: 'Dev Rao', roles: ['director'] });
    const admin = await makeUser(t.db, { name: 'Admin', roles: ['admin'] });
    ids = {
      employee: employee.id,
      other: other.id,
      manager: manager.id,
      accounts: accounts.id,
      director: director.id,
      admin: admin.id,
    };
    as = {
      employee: await login(employee.email),
      other: await login(other.email),
      manager: await login(manager.email, 'manager'),
      accounts: await login(accounts.email, 'accounts'),
      director: await login(director.email),
      admin: await login(admin.email),
    };
  });

  /** A submitted voucher with one line and (optionally) a bill. */
  async function submitted(who = as.employee, purpose = 'Client visit', withBill = true) {
    const draft = await who.post('/vouchers', {
      purpose,
      lines: [
        {
          categoryId: travel,
          expenseDate: '2026-11-18',
          description: 'Cab',
          amountPaise: 45_000,
          ...(withBill ? {} : { missingProofReason: 'No receipt' }),
        },
      ],
    });
    expect(draft.status).toBe(201);
    let version = draft.body.version;
    if (withBill) {
      const up = await who.upload(
        `/vouchers/${draft.body.id}/lines/${draft.body.lines[0].id}/attachments`,
      );
      expect(up.status).toBe(201);
      version = up.body.version;
    }
    const res = await who.post(`/vouchers/${draft.body.id}/submit`, { version });
    expect(res.status).toBe(200);
    return res.body as { id: string; number: string };
  }

  async function exportNow(who: ReturnType<typeof client>, body: object = { filters: {} }) {
    const res = await who.post('/exports', body);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('queued');
    await ctx.services.exports.idle();
    return (await who.get(`/exports/${res.body.id}`)).body;
  }

  it('Accounts exports every submitted voucher as a ZIP with PDFs, bills and a manifest', async () => {
    const a = await submitted();
    const b = await submitted(as.other, 'Office supplies', false);
    // Drafts never go in.
    await as.employee.post('/vouchers', { purpose: 'Draft', lines: [] });

    const preview = await as.accounts.get('/exports/preview');
    expect(preview.body).toMatchObject({
      vouchers: 2,
      totalPaise: 90_000,
      proofs: 1,
      tooMany: false,
    });

    const job = await exportNow(as.accounts);
    expect(job).toMatchObject({ status: 'ready', vouchers: 2, role: 'accounts', downloads: 0 });
    expect(job.filename).toMatch(/^vouchers-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);
    expect(new Date(job.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    const dl = await as.accounts.file(`/exports/${job.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    const zip = unzipSync(new Uint8Array(dl.body));
    const names = Object.keys(zip).sort();
    expect(names).toEqual(
      [
        'manifest.csv',
        `${a.number} Rahul Das/${a.number}.pdf`,
        `${a.number} Rahul Das/proofs/line-1-Taxi bill.pdf`,
        `${b.number} Priya Nair/${b.number}.pdf`,
      ].sort(),
    );
    expect(Buffer.from(zip[`${a.number} Rahul Das/proofs/line-1-Taxi bill.pdf`]!)).toEqual(PDF);
    const manifest = strFromU8(zip['manifest.csv']!)
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(manifest[0]).toContain('Voucher,Employee,Employee code');
    expect(manifest).toHaveLength(3);
    expect(manifest[1]).toContain(`${a.number},Rahul Das`);
    expect(manifest[1]).toContain('450.00');
    expect(manifest[1]).toContain(`${a.number}.pdf; proofs/line-1-Taxi bill.pdf`);

    expect((await as.accounts.get(`/exports/${job.id}`)).body.downloads).toBe(1);
    const actions = (await t.db.select().from(auditLog).where(eq(auditLog.entityId, job.id))).map(
      (e) => e.action,
    );
    expect(actions).toEqual(['export.requested', 'export.completed', 'export.downloaded']);
  });

  it('exports only what the role may see, and only the requester can fetch it', async () => {
    await submitted();
    await submitted(as.other, 'Not on Amit’s team', false);

    expect((await as.employee.get('/exports/preview')).body.vouchers).toBe(1);
    expect((await as.manager.get('/exports/preview')).body.vouchers).toBe(1);
    expect((await as.director.get('/exports/preview')).body.vouchers).toBe(2);
    expect((await as.admin.get('/exports/preview')).status).toBe(403);
    expect((await as.admin.post('/exports', { filters: {} })).status).toBe(403);

    const job = await exportNow(as.manager);
    expect(job.vouchers).toBe(1);
    // Someone else can't see it, download it, or make a link for it.
    expect((await as.accounts.get(`/exports/${job.id}`)).status).toBe(404);
    expect((await as.accounts.get(`/exports/${job.id}/download`)).status).toBe(404);
    expect((await as.accounts.post(`/exports/${job.id}/link`)).status).toBe(404);
    expect((await as.accounts.get('/exports')).body.meta.total).toBe(0);
    expect((await as.manager.get('/exports')).body.data[0].id).toBe(job.id);
  });

  it('filters by status, search and dates, and refuses an empty export', async () => {
    const a = await submitted(as.employee, 'Client visit');
    await submitted(as.employee, 'Team lunch', false);
    expect((await as.accounts.get('/exports/preview?search=lunch')).body.vouchers).toBe(1);
    expect((await as.accounts.get('/exports/preview?status=approved')).body.vouchers).toBe(0);
    expect((await as.accounts.get('/exports/preview?status=pending')).body.vouchers).toBe(2);
    expect((await as.accounts.get('/exports/preview?from=2099-01-01')).body.vouchers).toBe(0);
    expect((await as.accounts.get('/exports/preview?status=draft')).status).toBe(400);
    expect((await as.accounts.get('/exports/preview?from=2026-12-01&to=2026-11-01')).status).toBe(
      400,
    );

    const none = await as.accounts.post('/exports', { filters: { search: 'nothing-like-this' } });
    expect(none.status).toBe(400);
    expect(none.body.error.message).toBe('No vouchers match these filters');

    const job = await exportNow(as.accounts, {
      filters: { search: 'Client' },
      includeProofs: false,
    });
    const zip = unzipSync(
      new Uint8Array((await as.accounts.file(`/exports/${job.id}/download`)).body),
    );
    expect(Object.keys(zip).sort()).toEqual(
      ['manifest.csv', `${a.number} Rahul Das/${a.number}.pdf`].sort(),
    );
  });

  it('makes an expiring download link that works without signing in', async () => {
    await submitted();
    const job = await exportNow(as.accounts);
    const link = await as.accounts.post(`/exports/${job.id}/link`);
    expect(link.status).toBe(201);
    expect(link.body.url).toMatch(
      /^http:\/\/localhost:9080\/api\/v1\/exports\/download\/[\w-]{40,}$/,
    );
    const hours = (new Date(link.body.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    const path = new URL(link.body.url).pathname;
    const anon = await request(ctx.app).get(path).buffer(true).parse(binary);
    expect(anon.status).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(anon.body)))).toContain('manifest.csv');
    const [logged] = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'export.downloaded'), eq(auditLog.entityId, job.id)));
    expect(logged).toMatchObject({ actorId: null, meta: { via: 'link' } });

    // A new link replaces the old one.
    const second = await as.accounts.post(`/exports/${job.id}/link`);
    expect((await request(ctx.app).get(path)).status).toBe(404);
    const path2 = new URL(second.body.url).pathname;
    expect((await request(ctx.app).get(path2)).status).toBe(200);

    // Once the link's time is up, it stops working.
    await t.db
      .update(exportJobs)
      .set({ linkExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(exportJobs.id, job.id));
    const gone = await request(ctx.app).get(path2);
    expect(gone.status).toBe(404);
    expect(gone.body.error.message).toBe('This download link has expired. Ask for a new one.');
    expect(
      (await request(ctx.app).get('/api/v1/exports/download/not-a-real-token-at-all-xx')).status,
    ).toBe(404);
  });

  it('deletes the ZIP when the export expires, keeping the history', async () => {
    await submitted();
    const job = await exportNow(as.accounts);
    const [row] = await t.db.select().from(exportJobs).where(eq(exportJobs.id, job.id));
    await t.db
      .update(exportJobs)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(exportJobs.id, job.id));
    expect(await ctx.services.exports.prune()).toBe(1);
    expect((await t.db.select().from(files).where(eq(files.id, row!.fileId!))).length).toBe(0);
    expect((await as.accounts.get(`/exports/${job.id}`)).body.status).toBe('expired');
    const dl = await as.accounts.get(`/exports/${job.id}/download`);
    expect(dl.status).toBe(409);
    expect(dl.body.error.message).toBe('This export has expired');
  });

  it('fails an export cleanly when the requester lost the role meanwhile', async () => {
    await submitted();
    const res = await as.accounts.post('/exports', { filters: {} });
    await t.db
      .update(users)
      .set({ roles: ['employee'] })
      .where(eq(users.id, ids.accounts));
    await ctx.services.exports.idle();
    const [job] = await t.db.select().from(exportJobs).where(eq(exportJobs.id, res.body.id));
    expect(job).toMatchObject({ status: 'failed', fileId: null });
    expect(job!.error).toContain('can no longer export');
  });

  it('downloads one voucher as a ZIP for anyone who can open it, and logs it', async () => {
    const v = await submitted();
    const own = await as.employee.file(`/vouchers/${v.id}/zip`);
    expect(own.status).toBe(200);
    expect(own.headers['content-disposition']).toContain(`${v.number}.zip`);
    expect(Object.keys(unzipSync(new Uint8Array(own.body))).sort()).toEqual(
      [
        `${v.number} Rahul Das/${v.number}.pdf`,
        `${v.number} Rahul Das/proofs/line-1-Taxi bill.pdf`,
        'manifest.csv',
      ].sort(),
    );
    expect((await as.manager.file(`/vouchers/${v.id}/zip`)).status).toBe(200);
    expect((await as.other.get(`/vouchers/${v.id}/zip`)).status).toBe(404);
    const logged = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'voucher.zip_downloaded'));
    expect(logged.map((l) => l.actorId).sort()).toEqual([ids.employee, ids.manager].sort());
  });

  it('shows the audit log to Admins, Directors and Accounts, with filters and names', async () => {
    const v = await submitted();
    expect((await as.employee.get('/audit')).status).toBe(403);
    expect((await as.manager.get('/audit')).status).toBe(403);
    expect((await as.director.get('/audit')).status).toBe(200);
    expect((await as.accounts.get('/audit')).status).toBe(200);

    const all = await as.admin.get(`/audit?entityType=voucher&entityId=${v.id}`);
    expect(all.status).toBe(200);
    expect(all.body.data.map((e: { action: string }) => e.action)).toEqual([
      'voucher.submitted',
      'voucher.attachment_added',
      'voucher.created',
    ]);
    expect(all.body.data[0]).toMatchObject({
      actor: { id: ids.employee, name: 'Rahul Das' },
      entityLabel: v.number,
      actorRole: 'employee',
    });
    const prefix = await as.admin.get(`/audit?action=voucher.&actorId=${ids.employee}`);
    expect(prefix.body.meta.total).toBe(3);
    expect((await as.admin.get('/audit?action=voucher.created')).body.meta.total).toBe(1);
    expect((await as.admin.get('/audit?from=2099-01-01')).body.meta.total).toBe(0);

    const facets = await as.admin.get('/audit/facets');
    expect(facets.body.entityTypes).toContain('voucher');
    expect(facets.body.actions).toContain('voucher.submitted');
    expect(facets.body.actors).toContainEqual({ id: ids.employee, name: 'Rahul Das' });

    const csv = await as.admin.get('/audit/csv?entityType=voucher');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'Time,Person,Role,Action,Type,Record,Record id,Before,After,Details,IP,Request id',
    );
    expect(lines).toHaveLength(4);
    // Downloading the log is itself logged.
    expect((await as.admin.get('/audit?action=audit.exported')).body.data[0]).toMatchObject({
      actor: { id: ids.admin },
      meta: { rows: 3 },
    });
  });
});
