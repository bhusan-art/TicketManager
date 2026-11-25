import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { recordAudit } from '../src/audit/audit.js';
import { auditLog } from '../src/db/schema.js';
import { describeWithDb, useTestDb } from './helpers.js';

describeWithDb('audit log', () => {
  const t = useTestDb();

  it('records an entry with actor, entity and change', async () => {
    const actorId = randomUUID();
    const entry = await recordAudit(t.db, {
      action: 'voucher.approved',
      entityType: 'voucher',
      entityId: 'EXP-2026-00001',
      actorId,
      actorRole: 'manager',
      before: { status: 'submitted' },
      after: { status: 'manager_approved' },
    });

    const [stored] = await t.db.select().from(auditLog).where(eq(auditLog.id, entry.id));
    expect(stored).toMatchObject({
      action: 'voucher.approved',
      entityType: 'voucher',
      entityId: 'EXP-2026-00001',
      actorId,
      actorRole: 'manager',
      after: { status: 'manager_approved' },
    });
  });

  it('is written inside a transaction and rolled back with it', async () => {
    await expect(
      t.db.transaction(async (tx) => {
        await recordAudit(tx, { action: 'x.created', entityType: 'x' });
        throw new Error('change failed');
      }),
    ).rejects.toThrow('change failed');
    expect(await t.db.$count(auditLog)).toBe(0);
  });

  it('cannot be edited or deleted', async () => {
    const entry = await recordAudit(t.db, { action: 'x.created', entityType: 'x' });
    await expect(
      t.db.update(auditLog).set({ action: 'tampered' }).where(eq(auditLog.id, entry.id)),
    ).rejects.toThrow();
    await expect(t.db.delete(auditLog).where(eq(auditLog.id, entry.id))).rejects.toThrow();
    const [stored] = await t.db.select().from(auditLog);
    expect(stored!.action).toBe('x.created');
  });
});
