import { Types } from 'mongoose';
import { expect, it } from 'vitest';
import { AuditLog, recordAudit } from '../src/audit/audit.js';
import { describeWithDb, useTestDb } from './helpers.js';

describeWithDb('audit log', () => {
  useTestDb();

  it('records an entry with actor, entity and change', async () => {
    const actorId = new Types.ObjectId();
    const entry = await recordAudit({
      action: 'voucher.approved',
      entityType: 'voucher',
      entityId: 'EXP-2026-00001',
      actorId,
      actorRole: 'manager',
      before: { status: 'submitted' },
      after: { status: 'manager_approved' },
    });

    const stored = await AuditLog.findById(entry._id).lean();
    expect(stored).toMatchObject({
      action: 'voucher.approved',
      entityType: 'voucher',
      entityId: 'EXP-2026-00001',
      actorRole: 'manager',
      after: { status: 'manager_approved' },
    });
    expect(String(stored!.actorId)).toBe(String(actorId));
  });

  it('cannot be edited or deleted', async () => {
    const entry = await recordAudit({ action: 'x.created', entityType: 'x' });
    await expect(AuditLog.updateOne({ _id: entry._id }, { action: 'tampered' })).rejects.toThrow(
      /append-only/,
    );
    await expect(AuditLog.deleteOne({ _id: entry._id })).rejects.toThrow(/append-only/);
    expect(await AuditLog.countDocuments()).toBe(1);
  });
});
