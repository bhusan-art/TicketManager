import type { RequestHandler } from 'express';
import multer from 'multer';
import { MAX_FILE_BYTES } from '../storage/files.js';
import { AppError } from './errors.js';

/**
 * Accepts one multipart file in the field `file`, kept in memory (files are at most 10 MB and go
 * straight into the database). Puts it on `req.file`.
 */
export function singleFileUpload(field = 'file'): RequestHandler {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5 },
  }).single(field);

  return (req, res, next) => {
    handler(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'The file is larger than 10 MB'
            : err.code === 'LIMIT_UNEXPECTED_FILE'
              ? `Send one file in the "${field}" field`
              : err.message;
        return next(new AppError('VALIDATION_FAILED', message, [{ path: field, message }]));
      }
      if (err) return next(err);
      if (!req.file) {
        const message = 'Choose a file to upload';
        return next(new AppError('VALIDATION_FAILED', message, [{ path: field, message }]));
      }
      next();
    });
  };
}

/**
 * The real type of a file from its first bytes. The browser's Content-Type is only a claim,
 * so uploads are checked against this instead.
 */
export function sniffContentType(data: Buffer): string | null {
  const starts = (bytes: number[], offset = 0) =>
    data.length >= offset + bytes.length && bytes.every((b, i) => data[offset + i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/** Keeps a filename safe to store and to send back in a Content-Disposition header. */
export function cleanFilename(name: string): string {
  // multer reads the multipart filename as latin1; browsers send UTF-8.
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  const base = decoded.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return (cleaned || 'file').slice(0, 150);
}

/** `Content-Disposition` value that works for non-ASCII names too. */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
