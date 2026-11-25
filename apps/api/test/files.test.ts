import { expect, it } from 'vitest';
import { deleteFile, getFileInfo, readFile, saveFile } from '../src/storage/files.js';
import { describeWithDb, useTestDb } from './helpers.js';

describeWithDb('file storage', () => {
  const t = useTestDb();

  it('saves, reads and deletes a file', async () => {
    const data = Buffer.from('%PDF-1.7 receipt');
    const saved = await saveFile(t.db, {
      filename: 'taxi.pdf',
      contentType: 'application/pdf',
      data,
    });
    expect(saved).toMatchObject({ filename: 'taxi.pdf', sizeBytes: data.length });
    expect(saved.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(saved).not.toHaveProperty('data');

    expect(await getFileInfo(t.db, saved.id)).toMatchObject({ id: saved.id });
    const read = await readFile(t.db, saved.id);
    expect(read!.data.equals(data)).toBe(true);

    expect(await deleteFile(t.db, saved.id)).toBe(true);
    expect(await getFileInfo(t.db, saved.id)).toBeUndefined();
  });

  it('rejects empty and oversized files', async () => {
    const base = { filename: 'f', contentType: 'image/png' };
    await expect(saveFile(t.db, { ...base, data: Buffer.alloc(0) })).rejects.toThrow(RangeError);
    await expect(
      saveFile(t.db, { ...base, data: Buffer.alloc(10 * 1024 * 1024 + 1) }),
    ).rejects.toThrow(RangeError);
  });
});
