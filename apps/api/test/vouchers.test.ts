import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, categories, files } from '../src/db/schema.js';
import { currentYear } from '../src/vouchers/numbering.js';
import { bearer, describeWithDb, makeUser, signIn, testServices, useTestDb } from './helpers.js';

const PDF = Buffer.from('%PDF-1.4\n%test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);

function binary(res: NodeJS.ReadableStream, done: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
}

describeWithDb('vouchers', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  let auth: { Authorization: string };
  let travel: string;
  let meals: string;
  let managerId: string;
  const year = currentYear();
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(() => {
    ctx = testServices(t.db);
  });
  beforeEach(async () => {
    const rows = await t.db
      .insert(categories)
      .values([{ name: 'Travel' }, { name: 'Meals' }, { name: 'Old', status: 'inactive' }])
      .returning();
    travel = rows[0]!.id;
    meals = rows[1]!.id;
    const manager = await makeUser(t.db, { roles: ['manager', 'employee'] });
    managerId = manager.id;
    const employee = await makeUser(t.db, { managerId, employeeCode: 'EMP-7' });
    auth = bearer((await signIn(ctx.app, employee.email)).token);
  });

  const api = (as = auth) => ({
    get: (path: string) => request(ctx.app).get(`/api/v1${path}`).set(as),
    post: (path: string, body: object = {}) =>
      request(ctx.app).post(`/api/v1${path}`).set(as).send(body),
    patch: (path: string, body: object) =>
      request(ctx.app).patch(`/api/v1${path}`).set(as).send(body),
    delete: (path: string) => request(ctx.app).delete(`/api/v1${path}`).set(as),
    upload: (path: string, data: Buffer, name: string) =>
      request(ctx.app).post(`/api/v1${path}`).set(as).attach('file', data, name),
  });

  const goodLine = () => ({
    categoryId: travel,
    expenseDate: '2026-11-18',
    description: 'Cab to client office',
    amountPaise: 72_000,
  });
  const gstLine = () => ({
    categoryId: meals,
    expenseDate: '2026-11-18',
    description: 'Team lunch with client',
    amountPaise: 118_000,
    isGst: true,
    gstin: '29abcde1234f1z5',
    invoiceNumber: 'INV-88',
    cgstPaise: 9_000,
    sgstPaise: 9_000,
  });

  async function draft(lines: object[] = [goodLine()], purpose = 'Client visit in Bengaluru') {
    const res = await api().post('/vouchers', { purpose, lines });
    expect(res.status).toBe(201);
    return res.body;
  }

  /** A draft whose every line has a proof, ready to submit. */
  async function ready(lines: object[] = [goodLine()], as = auth) {
    const res = await api(as).post('/vouchers', { purpose: 'Client visit', lines });
    expect(res.status).toBe(201);
    let version = res.body.version as number;
    for (const line of res.body.lines) {
      const up = await api(as).upload(
        `/vouchers/${res.body.id}/lines/${line.id}/attachments`,
        PDF,
        'bill.pdf',
      );
      expect(up.status).toBe(201);
      version = up.body.version;
    }
    return { id: res.body.id as string, version };
  }

  describe('categories', () => {
    it('lists active categories to everyone and all of them to admins', async () => {
      const res = await api().get('/categories');
      expect(res.body.data.map((c: { name: string }) => c.name)).toEqual(['Meals', 'Travel']);
      expect((await api().get('/categories?all=true')).body.data).toHaveLength(2);

      const admin = await makeUser(t.db, { roles: ['admin'] });
      const adminAuth = bearer((await signIn(ctx.app, admin.email)).token);
      expect((await api(adminAuth).get('/categories?all=true')).body.data).toHaveLength(3);
    });

    it('lets only admins add and change categories, with unique names', async () => {
      expect((await api().post('/categories', { name: 'Fuel' })).status).toBe(403);
      const admin = await makeUser(t.db, { roles: ['admin'] });
      const adminApi = api(bearer((await signIn(ctx.app, admin.email)).token));

      const created = await adminApi.post('/categories', { name: 'Fuel', description: 'Petrol' });
      expect(created.status).toBe(201);
      expect((await adminApi.post('/categories', { name: 'Fuel' })).status).toBe(409);
      const off = await adminApi.patch(`/categories/${created.body.id}`, { status: 'inactive' });
      expect(off.body.status).toBe('inactive');
      const actions = (await t.db.select().from(auditLog)).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['category.created', 'category.updated']));
    });
  });

  describe('drafts', () => {
    it('creates a draft with lines and a total, and no number yet', async () => {
      const v = await draft([goodLine(), gstLine()]);
      expect(v).toMatchObject({
        number: null,
        approvalStatus: 'draft',
        paymentStatus: 'not_due',
        totalPaise: 190_000,
        version: 1,
        employee: { employeeCode: 'EMP-7' },
        can: { edit: true, submit: true, cancel: false, delete: true },
      });
      expect(v.lines).toHaveLength(2);
      expect(v.lines[1]).toMatchObject({ gstin: '29ABCDE1234F1Z5', category: { name: 'Meals' } });
    });

    it('saves incomplete drafts', async () => {
      const res = await api().post('/vouchers', { lines: [{ amountPaise: 0 }] });
      expect(res.status).toBe(201);
      expect(res.body.purpose).toBeNull();
    });

    it('rejects unknown and inactive categories', async () => {
      const inactive = (await t.db.select().from(categories)).find((c) => c.status === 'inactive')!;
      const res = await api().post('/vouchers', {
        lines: [{ ...goodLine(), categoryId: inactive.id }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].path).toBe('lines.0.categoryId');
    });

    it('updates lines, keeps the proofs of kept lines and drops removed ones', async () => {
      const v = await draft([goodLine(), gstLine()]);
      const [first, second] = v.lines;
      await api().upload(`/vouchers/${v.id}/lines/${first.id}/attachments`, PDF, 'a.pdf');
      const up = await api().upload(
        `/vouchers/${v.id}/lines/${second.id}/attachments`,
        PNG,
        'b.png',
      );
      expect(await t.db.$count(files)).toBe(2);

      const res = await api().patch(`/vouchers/${v.id}`, {
        version: up.body.version,
        purpose: 'Updated',
        lines: [
          { ...goodLine(), id: first.id, amountPaise: 50_000 },
          { ...goodLine(), description: 'Metro' },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.totalPaise).toBe(122_000);
      expect(res.body.lines[0].id).toBe(first.id);
      expect(res.body.lines[0].attachments).toHaveLength(1);
      expect(res.body.lines[1].description).toBe('Metro');
      // The removed line's file is gone from storage too.
      expect(await t.db.$count(files)).toBe(1);
    });

    it('rejects a stale version with 409', async () => {
      const v = await draft();
      const ok = await api().patch(`/vouchers/${v.id}`, { version: 1, lines: [] });
      expect(ok.body.version).toBe(2);
      const stale = await api().patch(`/vouchers/${v.id}`, { version: 1, lines: [] });
      expect(stale.status).toBe(409);
      expect(stale.body.error.details).toEqual({ currentVersion: 2 });
    });

    it('rejects line ids from another voucher', async () => {
      const a = await draft();
      const b = await draft();
      const res = await api().patch(`/vouchers/${b.id}`, {
        version: 1,
        lines: [{ ...goodLine(), id: a.lines[0].id }],
      });
      expect(res.status).toBe(400);
    });

    it('deletes a draft and its files', async () => {
      const { id } = await ready();
      expect((await api().delete(`/vouchers/${id}`)).status).toBe(204);
      expect((await api().get(`/vouchers/${id}`)).status).toBe(404);
      expect(await t.db.$count(files)).toBe(0);
    });

    it('hides vouchers from other employees', async () => {
      const v = await draft();
      const other = await makeUser(t.db, { managerId });
      const otherApi = api(bearer((await signIn(ctx.app, other.email)).token));
      expect((await otherApi.get(`/vouchers/${v.id}`)).status).toBe(404);
      expect((await otherApi.get(`/vouchers/${v.id}/pdf`)).status).toBe(404);
      expect((await otherApi.patch(`/vouchers/${v.id}`, { version: 1, lines: [] })).status).toBe(
        404,
      );
      expect((await otherApi.get('/vouchers')).body.meta.total).toBe(0);
    });
  });

  describe('proofs', () => {
    it('stores a proof by its real type and serves it back to the owner', async () => {
      const v = await draft();
      const lineId = v.lines[0].id;
      const res = await api().upload(
        `/vouchers/${v.id}/lines/${lineId}/attachments`,
        PDF,
        'hotel invoice.pdf',
      );
      expect(res.status).toBe(201);
      expect(res.body.attachment).toMatchObject({
        filename: 'hotel invoice.pdf',
        contentType: 'application/pdf',
        sizeBytes: PDF.length,
      });
      expect(res.body.version).toBe(2);

      const file = await api()
        .get(`/vouchers/${v.id}/attachments/${res.body.attachment.id}?download=1`)
        .buffer(true)
        .parse(binary);
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toBe('application/pdf');
      expect(file.headers['content-disposition']).toContain('attachment;');
      expect(Buffer.from(file.body).equals(PDF)).toBe(true);
    });

    it('rejects files that are not PDF or images, whatever their name says', async () => {
      const v = await draft();
      const res = await api().upload(
        `/vouchers/${v.id}/lines/${v.lines[0].id}/attachments`,
        Buffer.from('<html><script>alert(1)</script>'),
        'bill.pdf',
      );
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].path).toBe('file');
    });

    it('requires a file and rejects one over 10 MB', async () => {
      const v = await draft();
      const path = `/vouchers/${v.id}/lines/${v.lines[0].id}/attachments`;
      expect((await api().post(path)).status).toBe(400);
      const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);
      const res = await api().upload(path, big, 'big.pdf');
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('10 MB');
    });

    it('removes a proof and its stored file', async () => {
      const v = await draft();
      const up = await api().upload(
        `/vouchers/${v.id}/lines/${v.lines[0].id}/attachments`,
        PNG,
        'r.png',
      );
      const del = await api().delete(`/vouchers/${v.id}/attachments/${up.body.attachment.id}`);
      expect(del.status).toBe(200);
      expect(del.body.version).toBe(3);
      expect(await t.db.$count(files)).toBe(0);
    });
  });

  describe('submit', () => {
    it('lists every problem that blocks submission', async () => {
      const v = await draft(
        [
          { amountPaise: 0 },
          { ...gstLine(), gstin: 'BAD', cgstPaise: 9_000, sgstPaise: 8_000 },
          { ...goodLine(), expenseDate: '2999-01-01' },
        ],
        '',
      );
      const res = await api().post(`/vouchers/${v.id}/submit`, { version: v.version });
      expect(res.status).toBe(400);
      const paths = res.body.error.details.map((d: { path: string }) => d.path);
      expect(paths).toEqual(
        expect.arrayContaining([
          'purpose',
          'lines.0.categoryId',
          'lines.0.expenseDate',
          'lines.0.description',
          'lines.0.amountPaise',
          'lines.0.proof',
          'lines.1.gstin',
          'lines.1.sgstPaise',
          'lines.2.expenseDate',
        ]),
      );
    });

    it('accepts a missing-proof reason instead of a bill', async () => {
      const v = await draft([{ ...goodLine(), missingProofReason: 'Auto driver gave no receipt' }]);
      const res = await api().post(`/vouchers/${v.id}/submit`, { version: 1 });
      expect(res.status).toBe(200);
    });

    it('numbers vouchers in order and sends them to the reporting manager', async () => {
      const a = await ready([goodLine(), gstLine()]);
      const b = await ready();
      const first = await api().post(`/vouchers/${a.id}/submit`, { version: a.version });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        number: `EXP-${year}-00001`,
        approvalStatus: 'pending_manager',
        manager: { id: managerId },
        can: { edit: false, submit: false, cancel: true, delete: false },
      });
      expect(first.body.submittedAt).toBeTruthy();
      const second = await api().post(`/vouchers/${b.id}/submit`, { version: b.version });
      expect(second.body.number).toBe(`EXP-${year}-00002`);

      // Submitted vouchers can't be edited, deleted or resubmitted.
      const v = second.body.version;
      expect((await api().patch(`/vouchers/${b.id}`, { version: v, lines: [] })).status).toBe(409);
      expect((await api().delete(`/vouchers/${b.id}`)).status).toBe(409);
      expect((await api().post(`/vouchers/${b.id}/submit`, { version: v })).status).toBe(409);
      const actions = (await t.db.select().from(auditLog)).map((x) => x.action);
      expect(actions).toContain('voucher.submitted');
    });

    it('routes managers to Accounts and Accounts users to the Director', async () => {
      const manager = await makeUser(t.db, { roles: ['manager', 'employee'] });
      const managerAuth = bearer((await signIn(ctx.app, manager.email)).token);
      const m = await ready([goodLine()], managerAuth);
      const mRes = await api(managerAuth).post(`/vouchers/${m.id}/submit`, { version: m.version });
      expect(mRes.body).toMatchObject({ approvalStatus: 'pending_accounts', manager: null });

      const accounts = await makeUser(t.db, { roles: ['accounts', 'employee'], managerId });
      const accountsAuth = bearer((await signIn(ctx.app, accounts.email)).token);
      const a = await ready([goodLine()], accountsAuth);
      const aRes = await api(accountsAuth).post(`/vouchers/${a.id}/submit`, { version: a.version });
      expect(aRes.body.approvalStatus).toBe('pending_director');
    });

    it('asks employees without a manager to get one first', async () => {
      const loner = await makeUser(t.db);
      const lonerAuth = bearer((await signIn(ctx.app, loner.email)).token);
      const v = await ready([goodLine()], lonerAuth);
      const res = await api(lonerAuth).post(`/vouchers/${v.id}/submit`, { version: v.version });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('reporting manager');
    });

    it('replays a retried submit with the same Idempotency-Key', async () => {
      const v = await ready();
      const send = () =>
        api()
          .post(`/vouchers/${v.id}/submit`, { version: v.version })
          .set('Idempotency-Key', 'submit-key-123');
      const first = await send();
      const retry = await send();
      expect(retry.status).toBe(200);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body.number).toBe(first.body.number);
    });

    it('blocks submission when a category was switched off after drafting', async () => {
      const v = await ready();
      await t.db.update(categories).set({ status: 'inactive' });
      const res = await api().post(`/vouchers/${v.id}/submit`, { version: v.version });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].path).toBe('lines.0.categoryId');
    });
  });

  describe('cancel', () => {
    it('cancels a submitted voucher with a reason', async () => {
      const v = await ready();
      const sub = await api().post(`/vouchers/${v.id}/submit`, { version: v.version });
      expect(
        (await api().post(`/vouchers/${v.id}/cancel`, { version: sub.body.version })).status,
      ).toBe(400);
      const res = await api().post(`/vouchers/${v.id}/cancel`, {
        version: sub.body.version,
        reason: 'Trip was called off',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        approvalStatus: 'cancelled',
        cancelReason: 'Trip was called off',
        can: { cancel: false },
      });
      expect(
        (
          await api().post(`/vouchers/${v.id}/cancel`, {
            version: res.body.version,
            reason: 'again',
          })
        ).status,
      ).toBe(409);
    });

    it('does not cancel drafts', async () => {
      const v = await draft();
      const res = await api().post(`/vouchers/${v.id}/cancel`, { version: 1, reason: 'nope' });
      expect(res.status).toBe(409);
    });
  });

  describe('list and PDF', () => {
    it('lists my vouchers with tab counts, filters and search', async () => {
      const a = await ready([goodLine(), gstLine()]);
      await api().post(`/vouchers/${a.id}/submit`, { version: a.version });
      await draft([goodLine()], 'Stationery');

      const all = await api().get('/vouchers');
      expect(all.body.meta.total).toBe(2);
      const submitted = all.body.data.find((v: { id: string }) => v.id === a.id);
      expect(submitted).toMatchObject({
        number: `EXP-${year}-00001`,
        lineCount: 2,
        totalPaise: 190_000,
        categories: ['Meals', 'Travel'],
        expenseDate: '2026-11-18',
      });

      expect((await api().get('/vouchers?status=draft')).body.data[0].purpose).toBe('Stationery');
      expect((await api().get('/vouchers?status=pending')).body.meta.total).toBe(1);
      expect((await api().get(`/vouchers?search=EXP-${year}`)).body.meta.total).toBe(1);
      expect((await api().get('/vouchers?search=station')).body.meta.total).toBe(1);
      expect((await api().get('/vouchers/counts')).body).toEqual({
        all: 2,
        draft: 1,
        pending: 1,
        approved: 0,
        rejected: 0,
        cancelled: 0,
      });
    });

    it('downloads the voucher as a PDF', async () => {
      const v = await ready([goodLine(), gstLine()]);
      await api().post(`/vouchers/${v.id}/submit`, { version: v.version });
      const res = await api().get(`/vouchers/${v.id}/pdf`).buffer(true).parse(binary);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toContain(`EXP-${year}-00001.pdf`);
      expect(Buffer.from(res.body).subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('marks a draft PDF as a draft', async () => {
      const v = await draft();
      const res = await api().get(`/vouchers/${v.id}/pdf`).buffer(true).parse(binary);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('draft-voucher.pdf');
    });
  });

  it('uses today as a valid expense date', async () => {
    const v = await ready([{ ...goodLine(), expenseDate: today }]);
    const res = await api().post(`/vouchers/${v.id}/submit`, { version: v.version });
    expect(res.status).toBe(200);
  });
});
