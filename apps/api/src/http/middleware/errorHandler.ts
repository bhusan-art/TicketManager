import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ApiErrorBody } from '@ticketmanager/shared';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
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
  if (err instanceof mongoose.Error.ValidationError) {
    return new AppError(
      'VALIDATION_FAILED',
      'Request validation failed',
      Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })),
    );
  }
  if (err instanceof mongoose.Error.CastError) {
    return new AppError('VALIDATION_FAILED', `Invalid value for ${err.path}`);
  }
  if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000) {
    return new AppError('CONFLICT', 'A record with the same unique value already exists');
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
