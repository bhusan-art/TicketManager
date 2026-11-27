import type { ApiErrorBody, SessionResponse } from '@ticketmanager/shared';
import { shrinkImage } from './shrinkImage';

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

interface SendOptions {
  body?: unknown;
  headers?: Record<string, string>;
  accept?: string;
}

async function send(method: string, path: string, options: SendOptions = {}) {
  const { body } = options;
  const headers: Record<string, string> = {
    Accept: options.accept ?? 'application/json',
    ...options.headers,
  };
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
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

/** Sends a request, refreshing the access token once if it has expired. */
async function sendAuthed(method: string, path: string, options: SendOptions = {}) {
  let res = await send(method, path, options);
  if (res.status === 401 && accessToken && !path.startsWith('/auth/')) {
    const session = await refreshSession();
    if (!session) {
      onSignedOut();
      return res;
    }
    res = await send(method, path, options);
  }
  return res;
}

export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  return parse<T>(await sendAuthed(method, path, { body, headers }));
}

export const apiGet = <T>(path: string) => api<T>('GET', path);
export const apiPost = <T>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const apiPatch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const apiDelete = <T = void>(path: string) => api<T>('DELETE', path);

/** Uploads one file as multipart form data in the field `file`. Large photos are shrunk first. */
export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', await shrinkImage(file));
  return api<T>('POST', path, form);
}

/** A fresh key so a retried click can't submit twice. */
export const idempotencyKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Fetches a protected file (it needs the access token, so a plain link won't do) and either
 * saves it or opens it in a new tab.
 */
export async function fetchFile(path: string, mode: 'save' | 'open', fallbackName = 'file') {
  // Open the tab first, while we still have the click, so pop-up blockers allow it.
  const tab = mode === 'open' ? window.open('', '_blank') : null;
  try {
    const res = await sendAuthed('GET', path, { accept: '*/*' });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      throw new ApiError(res.status, json as ApiErrorBody | null);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (tab) {
      tab.location.href = url;
    } else {
      const match = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('content-disposition') ?? '');
      const a = document.createElement('a');
      a.href = url;
      a.download = match ? decodeURIComponent(match[1]!) : fallbackName;
      document.body.append(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}

/** Health is special: a 503 still carries a useful body. */
export async function getHealth<T>(): Promise<T> {
  const res = await send('GET', '/health');
  const json = await res.json().catch(() => null);
  if (!res.ok && res.status !== 503) throw new ApiError(res.status, json as ApiErrorBody | null);
  return json as T;
}
