import type { ApiErrorBody, SessionResponse } from '@ticketmanager/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
  ) {
    super(body?.error.message ?? `Request failed (${status})`);
  }

  /** Field messages from a 400 response, keyed by field path. */
  get fieldErrors(): Record<string, string> {
    const details = this.body?.error.details;
    if (!Array.isArray(details)) return {};
    return Object.fromEntries(
      details
        .filter((d): d is { path: string; message: string } => typeof d?.path === 'string')
        .map((d) => [d.path, d.message]),
    );
  }
}

/**
 * The access token lives only in memory. The refresh token is an httpOnly cookie the browser
 * sends to /api/v1/auth, so a page reload signs in again through `refreshSession()`.
 */
let accessToken: string | null = null;
let onSignedOut: () => void = () => {};
let refreshing: Promise<SessionResponse | null> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function setSignedOutHandler(handler: () => void) {
  onSignedOut = handler;
}

async function send(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json as ApiErrorBody | null);
  return json as T;
}

/** Gets a new access token from the refresh cookie. Concurrent callers share one request. */
export function refreshSession(): Promise<SessionResponse | null> {
  refreshing ??= (async () => {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await send('POST', '/auth/refresh');
        if (res.ok) {
          const session = (await res.json()) as SessionResponse;
          accessToken = session.accessToken;
          return session;
        }
        // 409: another tab rotated the cookie a moment ago. The browser now holds the new one,
        // so one retry succeeds. Anything else means signed out.
        if (res.status !== 409) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      accessToken = null;
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await send(method, path, body);
  if (res.status === 401 && accessToken && !path.startsWith('/auth/')) {
    const session = await refreshSession();
    if (!session) {
      onSignedOut();
      return parse<T>(res);
    }
    res = await send(method, path, body);
  }
  return parse<T>(res);
}

export const apiGet = <T>(path: string) => api<T>('GET', path);
export const apiPost = <T>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const apiPatch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);

/** Health is special: a 503 still carries a useful body. */
export async function getHealth<T>(): Promise<T> {
  const res = await send('GET', '/health');
  const json = await res.json().catch(() => null);
  if (!res.ok && res.status !== 503) throw new ApiError(res.status, json as ApiErrorBody | null);
  return json as T;
}
