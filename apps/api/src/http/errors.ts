import { ERROR_CODES, type ErrorCode } from '@ticketmanager/shared';

/** Throw this from any handler; the error middleware turns it into the standard error body. */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_CODES[code];
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden = (message = 'You do not have permission to do this') =>
  new AppError('FORBIDDEN', message);
export const conflict = (message: string, details?: unknown) =>
  new AppError('CONFLICT', message, details);
