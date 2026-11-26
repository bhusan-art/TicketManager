import type { AuthUser, SessionResponse } from '@ticketmanager/shared';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import { setAccessToken } from './lib/api';

type Handler = (body: unknown) => { status: number; body?: unknown };
export type Routes = Record<string, Handler>;

/** Mocks fetch with handlers keyed by "METHOD /path" (path without /api/v1 and query). */
export function mockApi(routes: Routes) {
  const calls: { key: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/api\/v1/, '').split('?')[0];
    const key = `${init?.method ?? 'GET'} ${path}`;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ key, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const handler = routes[key];
    const result = handler
      ? handler(body)
      : { status: 404, body: { error: { code: 'NOT_FOUND', message: 'nope' } } };
    return {
      ok: result.status < 400,
      status: result.status,
      json: async () => result.body,
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

export function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'u1',
    email: 'rahul@company.com',
    name: 'Rahul Das',
    employeeCode: 'EMP-1024',
    designation: 'Engineer',
    roles: ['employee'],
    activeRole: 'employee',
    department: { id: 'd1', name: 'Engineering' },
    manager: { id: 'm1', name: 'Amit Verma' },
    hasPassword: true,
    googleLinked: false,
    ...overrides,
  };
}

export const session = (user: AuthUser): SessionResponse => ({
  accessToken: `token-${user.activeRole}`,
  expiresIn: 900,
  user,
});

export const health = () => ({
  status: 200,
  body: {
    status: 'ok',
    version: '0.1.0',
    uptimeSeconds: 1,
    checks: { database: 'up', redis: 'up' },
  },
});

export function renderApp(path = '/') {
  setAccessToken(null);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}
