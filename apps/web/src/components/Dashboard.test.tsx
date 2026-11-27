import type { AccountsDashboard, ReportResponse } from '@ticketmanager/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeUser, mockApi, renderApp, session, type Routes } from '../test-utils';

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

const signedInAs = (user = makeUser()): Routes => ({
  'POST /auth/refresh': () => ({ status: 200, body: session(user) }),
});

describe('light and dark mode', () => {
  it('switches with the toggle and remembers the choice', async () => {
    mockApi({ ...signedInAs(), 'GET /vouchers/counts': () => ({ status: 200, body: { all: 0 } }) });
    renderApp('/');
    const toggle = await screen.findByRole('switch', { name: 'Dark mode' });
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem('tm-theme')).toBe('dark');

    await userEvent.click(toggle);
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(localStorage.getItem('tm-theme')).toBe('light');
  });

  it('is on the sign-in page too', async () => {
    mockApi({
      'POST /auth/refresh': () => ({ status: 401, body: { error: { code: 'UNAUTHENTICATED' } } }),
      'GET /auth/config': () => ({ status: 200, body: { googleEnabled: false } }),
    });
    localStorage.setItem('tm-theme', 'dark');
    renderApp('/login');
    expect(await screen.findByRole('switch', { name: 'Dark mode' })).toBeChecked();
  });
});

describe('employee dashboard', () => {
  it('shows claim counts and the latest claims', async () => {
    mockApi({
      ...signedInAs(),
      'GET /vouchers/counts': () => ({
        status: 200,
        body: { all: 7, draft: 1, pending: 3, approved: 2, rejected: 1 },
      }),
      'GET /vouchers': () => ({
        status: 200,
        body: {
          data: [
            {
              id: 'v9',
              number: 'EXP-2026-00150',
              purpose: 'Client visit, Pune',
              approvalStatus: 'pending_manager',
              paymentStatus: 'not_due',
              totalPaise: 450_000,
              lineCount: 1,
              expenseDate: null,
              categories: ['Travel'],
              project: null,
              submittedAt: null,
              createdAt: '2026-11-20T09:00:00Z',
              updatedAt: '2026-11-20T09:00:00Z',
            },
          ],
          meta: { page: 1, pageSize: 5, total: 1, totalPages: 1 },
        },
      }),
    });
    renderApp('/');
    const inProgress = (await screen.findByText('In progress', { selector: '.kpi-label' })).closest(
      'a',
    )!;
    expect(inProgress).toHaveAttribute('href', '/expenses?status=pending');
    expect(await within(inProgress).findByText('3')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Your claims by status' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Client visit, Pune/ })).toHaveAttribute(
      'href',
      '/expenses/v9',
    );
    expect(screen.getByRole('link', { name: /New expense/ })).toHaveAttribute(
      'href',
      '/expenses/new',
    );
  });
});

describe('accounts dashboard', () => {
  it('breaks spend down by category, department and person', async () => {
    const dash: AccountsDashboard = {
      toVerify: { count: 1, amountPaise: 100_000 },
      awaitingPayment: { count: 0, amountPaise: 0 },
      paidThisMonth: { count: 0, amountPaise: 0 },
      claimedThisMonth: { count: 1, amountPaise: 100_000 },
      openAdvances: { count: 2, amountPaise: 500_000, overdue: 1 },
      liabilityAging: [],
      monthly: [{ month: '2026-11', approvedPaise: 100_000, paidPaise: 0 }],
    };
    const row = {
      vouchers: 2,
      claimedPaise: 300_000,
      approvedPaise: 0,
      paidPaise: 0,
      outstandingPaise: 0,
      inReviewPaise: 0,
      rejectedPaise: 0,
    };
    const report: ReportResponse = {
      totals: row,
      byDepartment: [{ key: { id: 'd1', name: 'Sales' }, ...row }],
      byProject: [],
      byEmployee: [
        {
          key: { id: 'u2', name: 'Priya Sharma' },
          employeeCode: 'E2',
          department: 'Sales',
          ...row,
        },
      ],
      byCategory: [
        { key: { id: 'c1', name: 'Travel' }, vouchers: 2, claimedPaise: 200_000, approvedPaise: 0 },
        { key: { id: 'c2', name: 'Meals' }, vouchers: 1, claimedPaise: 100_000, approvedPaise: 0 },
      ],
    };
    const calls = mockApi({
      ...signedInAs(makeUser({ roles: ['accounts'], activeRole: 'accounts' })),
      'GET /accounts/dashboard': () => ({ status: 200, body: dash }),
      'GET /reports': () => ({ status: 200, body: report }),
      'GET /approvals': () => ({
        status: 200,
        body: { data: [], meta: { page: 1, pageSize: 5, total: 0, totalPages: 0 } },
      }),
    });
    renderApp('/');
    const legend = await screen.findByRole('img', { name: 'Claimed amount by category' });
    const donut = legend.closest('.donut')! as HTMLElement;
    expect(within(donut).getByText('Travel')).toBeInTheDocument();
    expect(within(donut).getByText('67%')).toBeInTheDocument();
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('All caught up. Nothing is waiting.')).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'GET /reports')!.query).toMatch(/^from=\d{4}-\d{2}-01$/);
  });
});
