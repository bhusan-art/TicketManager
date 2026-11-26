import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { files } from '../db/schema.js';

/**
 * File storage. Files live in the `files` table so one database backup covers everything.
 * Callers only use these functions, so files can move to S3 or disk later without touching them.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface NewFile {
  filename: string;
  contentType: string;
  data: Buffer;
  uploadedBy?: string | null;
}

export type StoredFileInfo = Omit<typeof files.$inferSelect, 'data'>;

const info = {
  id: files.id,
  filename: files.filename,
  contentType: files.contentType,
  sizeBytes: files.sizeBytes,
  sha256: files.sha256,
  uploadedBy: files.uploadedBy,
  createdAt: files.createdAt,
};

/** Uploads are limited to 10 MB; the app's own files (export ZIPs) pass a larger `maxBytes`. */
export async function saveFile(
  db: Pick<Db, 'insert'>,
  file: NewFile,
  { maxBytes = MAX_FILE_BYTES }: { maxBytes?: number } = {},
): Promise<StoredFileInfo> {
  if (file.data.length === 0) throw new RangeError('File is empty');
  if (file.data.length > maxBytes) {
    throw new RangeError(`File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
  const [row] = await db
    .insert(files)
    .values({
      filename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.data.length,
      sha256: createHash('sha256').update(file.data).digest('hex'),
      data: file.data,
      uploadedBy: file.uploadedBy ?? null,
    })
    .returning(info);
  return row!;
}

export async function getFileInfo(
  db: Pick<Db, 'select'>,
  id: string,
): Promise<StoredFileInfo | undefined> {
  const [row] = await db.select(info).from(files).where(eq(files.id, id));
  return row;
}

export async function readFile(db: Pick<Db, 'select'>, id: string) {
  const [row] = await db.select().from(files).where(eq(files.id, id));
  return row;
}

export async function deleteFile(db: Pick<Db, 'delete'>, id: string) {
  const deleted = await db.delete(files).where(eq(files.id, id)).returning({ id: files.id });
  return deleted.length > 0;
}
