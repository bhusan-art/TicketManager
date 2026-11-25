import type { ApiErrorBody } from '@ticketmanager/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
  ) {
    super(body?.error.message ?? `Request failed with ${status}`);
  }
}

/** Fetch JSON from the API. The dev server and nginx both proxy /api to the backend. */
export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok && res.status !== 503) throw new ApiError(res.status, body as ApiErrorBody | null);
  return body as T;
}
