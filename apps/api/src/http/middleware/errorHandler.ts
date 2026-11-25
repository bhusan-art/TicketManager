import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ApiErrorBody } from '@ticketmanager/shared';
import { ZodError } from 'zod';
import { pgErrorCode } from '../../db/client.js';
import { AppError } from '../errors.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError('NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError(
      'VALIDATION_FAILED',
      'Request validation failed',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  switch (pgErrorCode(err)) {
    case '23505':
      return new AppError('CONFLICT', 'A record with the same unique value already exists');
    case '23503':
      return new AppError('VALIDATION_FAILED', 'A referenced record does not exist');
    case '22P02':
      return new AppError('VALIDATION_FAILED', 'A value has the wrong format');
  }
  // Malformed JSON bodies from express.json()
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { type?: unknown }).type === 'entity.parse.failed'
  ) {
    return new AppError('VALIDATION_FAILED', 'Request body is not valid JSON');
  }
  return new AppError('INTERNAL', 'Something went wrong');
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appErr = toAppError(err);
  if (appErr.status >= 500) {
    req.log?.error({ err }, 'Unhandled error');
  }
  const body: ApiErrorBody = {
    error: {
      code: appErr.code,
      message: appErr.message,
      ...(appErr.details !== undefined ? { details: appErr.details } : {}),
      requestId: req.id ? String(req.id) : undefined,
    },
  };
  res.status(appErr.status).json(body);
};
