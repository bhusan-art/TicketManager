import { expect, it } from 'vitest';
import { bootstrapAdmin } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { users } from '../src/db/schema.js';
import { createLogger } from '../src/lib/logger.js';
import { describeWithDb, useTestDb } from './helpers.js';

describeWithDb('first admin', () => {
  const t = useTestDb();
  const logger = createLogger('silent');
  const config = (password = 'Admin#2026') =>
    loadConfig({
      NODE_ENV: 'test',
      BOOTSTRAP_ADMIN_EMAIL: 'Admin@Company.com',
      BOOTSTRAP_ADMIN_PASSWORD: password,
    });

  it('creates the admin on an empty database, and only once', async () => {
    expect(await bootstrapAdmin(t.db, config(), logger)).toBe(true);
    expect(await bootstrapAdmin(t.db, config(), logger)).toBe(false);
    const rows = await t.db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'admin@company.com', roles: ['admin', 'employee'] });
  });

  it('refuses a weak password', async () => {
    await expect(bootstrapAdmin(t.db, config('admin'), logger)).rejects.toThrow(/too weak/);
  });

  it('does nothing when not configured', async () => {
    expect(await bootstrapAdmin(t.db, loadConfig({ NODE_ENV: 'test' }), logger)).toBe(false);
  });
});
