import { todayIso } from '@ticketmanager/shared';
import { writeFileSync } from 'node:fs';
import request from 'supertest';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { categories } from '../src/db/schema.js';
import { bearer, describeWithDb, makeUser, signIn, testServices, useTestDb } from './helpers.js';

function binary(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

/** Set PDF_OUT to a folder to keep the files and look at them. */
const keep = (name: string, body: Buffer) => {
  if (process.env.PDF_OUT) writeFileSync(`${process.env.PDF_OUT}/${name}`, body);
};

describeWithDb('printable forms', () => {
  const t = useTestDb();
  let ctx: ReturnType<typeof testServices>;
  let rahul: Record<string, string>;
  let priya: Record<string, string>;
  let neha: Record<string, string>;

  beforeAll(() => {
    ctx = testServices(t.db);
  });

  const pdf = (auth: Record<string, string>, path: string) =>
    request(ctx.app).get(`/api/v1${path}`).set(auth).buffer(true).parse(binary);

  beforeEach(async () => {
    const manager = await makeUser(t.db, { email: 'amit@company.com', roles: ['manager'] });
    await makeUser(t.db, {
      email: 'rahul@company.com',
      name: 'Rahul Das',
      employeeCode: 'EMP-1024',
      managerId: manager.id,
    });
    await makeUser(t.db, { email: 'priya@company.com', name: 'Priya Nair' });
    await makeUser(t.db, { email: 'neha@company.com', roles: ['accounts'] });
    rahul = bearer((await signIn(ctx.app, 'rahul@company.com')).token);
    priya = bearer((await signIn(ctx.app, 'priya@company.com')).token);
    neha = bearer((await signIn(ctx.app, 'neha@company.com')).token);
    await t.db.insert(categories).values([{ name: 'Travel' }, { name: 'Food and meals' }]);
  });

  it('gives anyone signed in a blank paper claim form', async () => {
    const res = await pdf(rahul, '/forms/claim.pdf');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('paper-claim-form.pdf');
    expect(Buffer.from(res.body).subarray(0, 5).toString()).toBe('%PDF-');
    keep('paper-claim-form.pdf', res.body);
    await request(ctx.app).get('/api/v1/forms/claim.pdf').expect(401);
  });

  it('downloads an advance as a PDF for the people who can see it', async () => {
    const draft = await request(ctx.app).post('/api/v1/advances').set(rahul).send({
      purpose: 'Site visit to Pune',
      requestedPaise: 2_000_000,
      expectedDate: todayIso(),
    });
    expect(draft.status).toBe(201);
    const sent = await request(ctx.app)
      .post(`/api/v1/advances/${draft.body.id}/submit`)
      .set(rahul)
      .send({ version: 1 });
    expect(sent.status).toBe(200);

    const own = await pdf(rahul, `/advances/${draft.body.id}/pdf`);
    expect(own.status).toBe(200);
    expect(own.headers['content-disposition']).toContain(`${sent.body.number}.pdf`);
    expect(Buffer.from(own.body).subarray(0, 5).toString()).toBe('%PDF-');
    keep('advance.pdf', own.body);

    expect((await pdf(neha, `/advances/${draft.body.id}/pdf`)).status).toBe(200);
    expect((await pdf(priya, `/advances/${draft.body.id}/pdf`)).status).toBe(404);
  });
});
