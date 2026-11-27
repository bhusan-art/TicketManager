import type { ApprovalQueueItem, VoucherDetail } from '@ticketmanager/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUser, mockApi, renderApp, session } from '../../test-utils';
import { perms, voucher } from '../../test-fixtures';

afterEach(() => vi.unstubAllGlobals());

const manager = makeUser({
  id: 'm1',
  name: 'Amit Verma',
  roles: ['manager', 'employee'],
  activeRole: 'manager',
});
const signedIn = { 'POST /auth/refresh': () => ({ status: 200, body: session(manager) }) };

const pending = (): VoucherDetail =>
  voucher({
    number: 'EXP-2026-00148',
    approvalStatus: 'pending_manager',
    submittedAt: '2026-11-18T10:00:00Z',
    manager: { id: 'm1', name: 'Amit Verma' },
    waitingOn: 'Amit Verma',
    can: perms({ approve: true, query: true, return: true, reject: true, comment: true }),
    events: [
      {
        id: 1,
        type: 'submitted',
        at: '2026-11-18T10:00:00Z',
        actor: { id: 'u1', name: 'Rahul Das' },
        actorRole: 'employee',
        fromStatus: 'draft',
        toStatus: 'pending_manager',
        message: null,
        meta: null,
      },
    ],
  });

describe('Approvals', () => {
  it('lists what waits for the manager', async () => {
    const item: ApprovalQueueItem = {
      id: 'v1',
      number: 'EXP-2026-00148',
      purpose: 'Client meeting at Bengaluru',
      approvalStatus: 'pending_manager',
      project: null,
      paymentStatus: 'not_due',
      totalPaise: 720_000,
      lineCount: 1,
      expenseDate: '2026-11-18',
      categories: ['Travel'],
      submittedAt: '2026-11-18T10:00:00Z',
      createdAt: '2026-11-18T09:00:00Z',
      updatedAt: '2026-11-18T10:00:00Z',
      employee: { id: 'u1', name: 'Rahul Das', employeeCode: 'EMP-1024' },
      department: { id: 'd1', name: 'Engineering' },
      reviewStarted: false,
    };
    mockApi({
      ...signedIn,
      'GET /approvals': () => ({
        status: 200,
        body: { data: [item], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } },
      }),
      'GET /approvals/counts': () => ({ status: 200, body: { pending: 1, queried: 0 } }),
    });
    renderApp('/approvals');
    expect(await screen.findByText('Rahul Das')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'EXP-2026-00148' })).toHaveAttribute(
      'href',
      '/approvals/v1',
    );
    expect(await screen.findByRole('tab', { name: /^Waiting for me\s*1$/ })).toBeInTheDocument();
  });

  it('approves a lower amount with a note', async () => {
    const calls = mockApi({
      ...signedIn,
      'GET /vouchers/v1': () => ({ status: 200, body: pending() }),
      'POST /vouchers/v1/approve': () => ({
        status: 200,
        body: voucher({
          approvalStatus: 'pending_accounts',
          number: 'EXP-2026-00148',
          approvedTotalPaise: 500_000,
          waitingOn: 'Accounts',
          can: perms({ comment: true }),
        }),
      }),
    });
    renderApp('/approvals/v1');
    const amount = await screen.findByLabelText('Approved amount for line 1');
    expect(amount).toHaveValue('7200.00');
    await userEvent.clear(amount);
    await userEvent.type(amount, '5000');
    await userEvent.type(screen.getByLabelText('Why line 1 is reduced'), 'Cab capped');
    await userEvent.click(screen.getByRole('button', { name: 'Approve ₹5,000.00' }));

    expect(await screen.findByText('Approved and sent to Accounts.')).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'POST /vouchers/v1/approve')!.body).toEqual({
      version: 3,
      note: '',
      lines: [{ id: 'l1', approvedPaise: 500_000, note: 'Cab capped' }],
    });
  });

  it('asks for a reason before rejecting', async () => {
    const calls = mockApi({
      ...signedIn,
      'GET /vouchers/v1': () => ({ status: 200, body: pending() }),
      'POST /vouchers/v1/reject': () => ({
        status: 200,
        body: voucher({ approvalStatus: 'manager_rejected', can: perms({ comment: true }) }),
      }),
    });
    renderApp('/approvals/v1');
    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const send = screen.getByRole('button', { name: 'Reject voucher' });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason'), 'Personal expense');
    await userEvent.click(send);
    expect(await screen.findByText('Voucher rejected.')).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'POST /vouchers/v1/reject')!.body).toEqual({
      version: 3,
      message: 'Personal expense',
    });
  });
});

describe('Answering a query', () => {
  it('shows the question and sends the answer', async () => {
    const employee = makeUser();
    const queried = voucher({
      number: 'EXP-2026-00148',
      approvalStatus: 'manager_query',
      can: perms({ answer: true, cancel: true, comment: true }),
      events: [
        {
          id: 2,
          type: 'queried',
          at: '2026-11-18T11:00:00Z',
          actor: { id: 'm1', name: 'Amit Verma' },
          actorRole: 'manager',
          fromStatus: 'pending_manager',
          toStatus: 'manager_query',
          message: 'Which client was this for?',
          meta: null,
        },
      ],
    });
    const calls = mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: session(employee) }),
      'GET /vouchers/v1': () => ({ status: 200, body: queried }),
      'POST /vouchers/v1/answer': () => ({
        status: 200,
        body: voucher({ approvalStatus: 'pending_manager', can: perms({ cancel: true }) }),
      }),
    });
    renderApp('/expenses/v1');
    expect(await screen.findByText('Amit Verma has a question')).toBeInTheDocument();
    expect(screen.getAllByText('Which client was this for?').length).toBeGreaterThan(0);
    await userEvent.type(screen.getByLabelText('Your answer'), 'Acme Ltd');
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(await screen.findByText('Answer sent.')).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'POST /vouchers/v1/answer')!.body).toEqual({
      version: 3,
      message: 'Acme Ltd',
    });
  });
});
