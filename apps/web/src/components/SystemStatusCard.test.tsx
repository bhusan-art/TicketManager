import type { SystemStatus } from '@ticketmanager/shared';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUser, mockApi, renderApp, session } from '../test-utils';

afterEach(() => vi.unstubAllGlobals());

const status = (over: Partial<SystemStatus> = {}): SystemStatus => ({
  version: '1.0.0',
  uptimeSeconds: 100,
  checks: { database: 'up', redis: 'up', worker: 'up' },
  worker: { lastSeenAt: '2026-11-26T10:00:00Z' },
  email: { pending: 0, failed: 0, oldestPendingAt: null },
  backups: {
    lastSuccessAt: '2026-11-26T21:00:00Z',
    overdue: false,
    recent: [
      {
        id: 1,
        status: 'ok',
        file: 'ticketmanager-2026-11-27-0230.dump',
        sizeBytes: 5_242_880,
        error: null,
        startedAt: '2026-11-26T21:00:00Z',
        finishedAt: '2026-11-26T21:00:05Z',
      },
    ],
  },
  ...over,
});

function render(s: SystemStatus) {
  const admin = makeUser({ roles: ['admin'], activeRole: 'admin' });
  mockApi({
    'POST /auth/refresh': () => ({ status: 200, body: session(admin) }),
    'GET /notifications/unread-count': () => ({ status: 200, body: { unread: 0 } }),
    'GET /accounts/overview': () => ({ status: 404 }),
    'GET /admin/system': () => ({ status: 200, body: s }),
  });
  renderApp('/');
}

describe('Admin system status', () => {
  it('shows services, the worker and the last backup', async () => {
    render(status());
    expect(await screen.findByText('All services up · v1.0.0')).toBeInTheDocument();
    expect(screen.getByText('Email worker')).toBeInTheDocument();
    expect(screen.getByText(/5\.0 MB/)).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  it('warns about a stopped worker, failed email and an overdue backup', async () => {
    render(
      status({
        checks: { database: 'up', redis: 'up', worker: 'down' },
        email: { pending: 3, failed: 2, oldestPendingAt: '2026-11-26T09:00:00Z' },
        backups: {
          lastSuccessAt: null,
          overdue: true,
          recent: [
            {
              id: 2,
              status: 'failed',
              file: null,
              sizeBytes: null,
              error: 'pg_dump: could not connect',
              startedAt: '2026-11-26T21:00:00Z',
              finishedAt: '2026-11-26T21:00:01Z',
            },
          ],
        },
      }),
    );
    expect(await screen.findByText('Some services are down · v1.0.0')).toBeInTheDocument();
    expect(screen.getByText(/last seen/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'see the log' })).toHaveAttribute(
      'href',
      '/admin/emails?status=failed',
    );
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText(/Last try failed: pg_dump: could not connect/)).toBeInTheDocument();
  });
});
