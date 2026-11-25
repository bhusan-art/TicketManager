/**
 * Every API error response has this shape:
 *   { "error": { "code": "VALIDATION_FAILED", "message": "...", "details": [...], "requestId": "..." } }
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}
