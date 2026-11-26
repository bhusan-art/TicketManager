import type { AppNotification } from '@ticketmanager/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUser, mockApi, renderApp, session } from '../../test-utils';

afterEach(() => vi.unstubAllGlobals());

const note = (over: Partial<AppNotification> = {}): AppNotification => ({
  id: 'n1',
  title: 'EXP-2026-00012 needs your approval',
  body: 'Rahul Das submitted a claim of ₹4,500.00 for Client visit.',
  link: '/approvals/v1',
  entityType: 'voucher',
  entityId: 'v1',
  role: 'manager',
  actor: { id: 'u1', name: 'Rahul Das' },
  createdAt: '2026-11-26T09:00:00Z',
  readAt: null,
  ...over,
});

describe('Notifications', () => {
  it('shows the unread count, and opening one marks it read in the right role', async () => {
    const amit = makeUser({
      id: 'm1',
      name: 'Amit Verma',
      roles: ['employee', 'manager'],
      activeRole: 'employee',
    });
    const calls = mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: session(amit) }),
      'GET /notifications/unread-count': () => ({ status: 200, body: { unread: 1 } }),
      'GET /notifications': () => ({
        status: 200,
        body: {
          data: [
            note(),
            note({
              id: 'n2',
              title: 'Question on EXP-2026-00009',
              body: 'Neha Joshi asked a question about your claim.\n“Which client?”',
              link: '/expenses/v9',
              role: 'employee',
              readAt: '2026-11-25T10:00:00Z',
            }),
          ],
          meta: { page: 1, pageSize: 25, total: 2, totalPages: 1 },
        },
      }),
      'POST /notifications/read': () => ({ status: 204 }),
      'POST /auth/switch-role': () => ({
        status: 200,
        body: session({ ...amit, activeRole: 'manager' }),
      }),
    });
    renderApp('/notifications');
    expect(await screen.findByLabelText('Notifications, 1 unread')).toBeInTheDocument();
    expect(await screen.findByText('“Which client?”')).toBeInTheDocument();
    expect(screen.getByText(/as Manager/)).toBeInTheDocument();

    await userEvent.click(screen.getByText('EXP-2026-00012 needs your approval'));
    expect(calls.find((c) => c.key === 'POST /notifications/read')!.body).toEqual({ ids: ['n1'] });
    expect(calls.find((c) => c.key === 'POST /auth/switch-role')!.body).toEqual({
      role: 'manager',
    });
  });

  it('marks everything read', async () => {
    const calls = mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: session(makeUser()) }),
      'GET /notifications/unread-count': () => ({ status: 200, body: { unread: 1 } }),
      'GET /notifications': () => ({
        status: 200,
        body: {
          data: [note({ role: 'employee', link: '/expenses/v1' })],
          meta: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
        },
      }),
      'POST /notifications/read': () => ({ status: 204 }),
    });
    renderApp('/notifications');
    await userEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
    expect(calls.find((c) => c.key === 'POST /notifications/read')!.body).toEqual({ all: true });
  });
});
