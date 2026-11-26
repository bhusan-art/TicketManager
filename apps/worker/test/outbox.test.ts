import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EMAIL_MAX_ATTEMPTS } from '@ticketmanager/shared';
import { deliverDue, renderText, type Mail } from '../src/outbox.js';

const url = process.env.DATABASE_URL_TEST;
if (!url && process.env.REQUIRE_DB_TESTS) throw new Error('DATABASE_URL_TEST must be set');

describe('renderText', () => {
  const email = {
    id: '1',
    kind: 'notification',
    to: ['a@example.com'],
    cc: [],
    subject: 's',
    text: 'Hi Ravi,\n\nYour claim was approved.',
    link: '/expenses/abc',
    attempts: 1,
  };
  it('adds the full link and a sign-off to workflow emails', () => {
    expect(renderText(email, 'https://expenses.example.com/')).toBe(
      'Hi Ravi,\n\nYour claim was approved.\n\nOpen it in TicketManager:\nhttps://expenses.example.com/expenses/abc\n\nTicketManager',
    );
  });
  it('leaves invitations as written', () => {
    expect(renderText({ ...email, kind: 'invite', link: null }, 'http://x')).toBe(email.text);
  });
});

describe.skipIf(!url)('outbox delivery', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await pool.query('drop schema if exists public cascade');
    await pool.query('drop schema if exists drizzle cascade');
    await pool.query('create schema public');
    await migrate(drizzle(pool), {
      migrationsFolder: fileURLToPath(new URL('../../api/drizzle', import.meta.url)),
    });
  });
  beforeEach(async () => {
    await pool.query('truncate email_outbox');
  });
  afterAll(async () => {
    await pool?.end();
  });

  async function add(to: string, extra = '') {
    const { rows } = await pool.query<{ id: string }>(
      `insert into email_outbox (kind, "to", cc, subject, text, link)
       values ('notification', $1, $2, 'EXP-2026-00001 needs your approval', 'Hi', '/approvals/1')
       returning id`,
      [[to], extra ? [extra] : []],
    );
    return rows[0]!.id;
  }
  const row = async (id: string) =>
    (await pool.query('select * from email_outbox where id = $1', [id])).rows[0];

  it('sends what is due once and logs it as sent', async () => {
    const id = await add('manager@example.com', 'cc@example.com');
    const sent: Mail[] = [];
    const send = async (m: Mail) => {
      sent.push(m);
      return { messageId: '<m1@example.com>' };
    };
    expect(await deliverDue(pool, send, { publicUrl: 'http://app' })).toEqual({
      sent: 1,
      retrying: 0,
      failed: 0,
    });
    expect(sent[0]).toMatchObject({ to: ['manager@example.com'], cc: ['cc@example.com'] });
    expect(sent[0]!.text).toContain('http://app/approvals/1');
    expect(await row(id)).toMatchObject({
      status: 'sent',
      attempts: 1,
      message_id: '<m1@example.com>',
    });

    // Nothing is sent twice.
    expect((await deliverDue(pool, send, { publicUrl: 'http://app' })).sent).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('retries a failed send later, then gives up and marks it failed', async () => {
    const id = await add('employee@example.com');
    const fail = async () => {
      throw new Error('SMTP 421 try again later');
    };
    expect((await deliverDue(pool, fail, { publicUrl: 'http://app' })).retrying).toBe(1);
    let r = await row(id);
    expect(r).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'SMTP 421 try again later',
    });
    expect(new Date(r.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);

    // Not due yet: nothing is tried.
    expect(await deliverDue(pool, fail, { publicUrl: 'http://app' })).toEqual({
      sent: 0,
      retrying: 0,
      failed: 0,
    });

    for (let i = 2; i <= EMAIL_MAX_ATTEMPTS; i++) {
      await pool.query('update email_outbox set next_attempt_at = now() where id = $1', [id]);
      await deliverDue(pool, fail, { publicUrl: 'http://app' });
    }
    r = await row(id);
    expect(r).toMatchObject({ status: 'failed', attempts: EMAIL_MAX_ATTEMPTS });

    // Failed emails stay failed until an admin retries them.
    await pool.query('update email_outbox set next_attempt_at = now() where id = $1', [id]);
    expect((await deliverDue(pool, fail, { publicUrl: 'http://app' })).failed).toBe(0);
  });

  it('never hands the same email to two workers', async () => {
    for (let i = 0; i < 30; i++) await add(`p${i}@example.com`);
    const seen: string[] = [];
    const send = async (m: Mail) => {
      seen.push(m.to[0]!);
      await new Promise((r) => setTimeout(r, 2));
      return {};
    };
    await Promise.all([
      deliverDue(pool, send, { publicUrl: 'http://app', batch: 5 }),
      deliverDue(pool, send, { publicUrl: 'http://app', batch: 5 }),
    ]);
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
  });
});
