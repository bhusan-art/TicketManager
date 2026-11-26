import { settle, type AdvanceDetail, type AdvancePermissions } from '@ticketmanager/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUser, mockApi, renderApp, session } from '../../test-utils';

afterEach(() => vi.unstubAllGlobals());

const can = (allowed: Partial<AdvancePermissions> = {}): AdvancePermissions => ({
  edit: false,
  submit: false,
  cancel: false,
  delete: false,
  approve: false,
  return: false,
  reject: false,
  disburse: false,
  settle: false,
  close: false,
  ...allowed,
});

const advance = (over: Partial<AdvanceDetail> = {}): AdvanceDetail => ({
  id: 'a1',
  number: 'ADV-2026-00001',
  purpose: 'Site visit to Pune',
  notes: null,
  status: 'open',
  requestedPaise: 2_000_000,
  approvedPaise: 2_000_000,
  expectedDate: '2026-11-20',
  settleBy: '2026-12-20',
  overdue: false,
  version: 5,
  employee: {
    id: 'u1',
    name: 'Rahul Das',
    email: 'rahul@company.com',
    employeeCode: 'EMP-1024',
    designation: null,
  },
  department: { id: 'd1', name: 'Engineering' },
  manager: { id: 'm1', name: 'Amit Verma' },
  submittedAt: '2026-11-18T10:00:00Z',
  decidedAt: '2026-11-18T12:00:00Z',
  disbursedAt: '2026-11-19T10:00:00Z',
  closedAt: null,
  cancelReason: null,
  createdAt: '2026-11-18T09:00:00Z',
  updatedAt: '2026-11-19T10:00:00Z',
  waitingOn: null,
  transactions: [],
  vouchers: [],
  settlement: settle({ transactions: [], vouchers: [] }),
  events: [],
  can: can(),
  ...over,
});

/** ₹20,000 out, one claim of ₹14,000 approved: ₹6,000 due back. */
function withClaims(over: Partial<AdvanceDetail> = {}) {
  const transactions: AdvanceDetail['transactions'] = [
    {
      id: 't1',
      kind: 'disbursement',
      amountPaise: 2_000_000,
      paidOn: '2026-11-19',
      mode: 'bank_transfer',
      reference: 'UTR100',
      note: null,
      recordedBy: { id: 'a9', name: 'Neha Joshi' },
      createdAt: '2026-11-19T10:00:00Z',
      reversedAt: null,
      reversedBy: null,
      reversalReason: null,
    },
  ];
  const vouchers: AdvanceDetail['vouchers'] = [
    {
      id: 'v1',
      number: 'EXP-2026-00010',
      purpose: 'Hotel and cabs',
      approvalStatus: 'approved',
      totalPaise: 1_400_000,
      approvedTotalPaise: 1_400_000,
      counted: true,
      inReview: false,
    },
  ];
  return advance({
    transactions,
    vouchers,
    settlement: settle({ transactions, vouchers }),
    ...over,
  });
}

describe('Advances', () => {
  it('lets an employee request an advance', async () => {
    const calls = mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: session(makeUser()) }),
      'GET /advances/settings': () => ({ status: 200, body: { maxAdvancePaise: 5_000_000 } }),
      'POST /advances': () => ({
        status: 201,
        body: advance({
          status: 'draft',
          number: null,
          version: 1,
          can: can({ edit: true, submit: true }),
        }),
      }),
      'POST /advances/a1/submit': () => ({
        status: 200,
        body: advance({ status: 'pending_manager', waitingOn: 'Amit Verma', settleBy: null }),
      }),
      'GET /advances/a1': () => ({
        status: 200,
        body: advance({ status: 'pending_manager', waitingOn: 'Amit Verma', settleBy: null }),
      }),
    });
    renderApp('/advances/new');
    await userEvent.type(await screen.findByLabelText('Purpose'), 'Site visit to Pune');
    await userEvent.type(screen.getByLabelText(/^Amount/), '60000');
    expect(await screen.findByText('Advances are limited to ₹50,000.00')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText(/^Amount/));
    await userEvent.type(screen.getByLabelText(/^Amount/), '20000');
    await userEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    expect(
      await screen.findByText('Advance ADV-2026-00001 sent to Amit Verma.'),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'POST /advances')!.body).toMatchObject({
      purpose: 'Site visit to Pune',
      requestedPaise: 2_000_000,
    });
  });

  it('shows the settlement and records the money returned', async () => {
    const accounts = makeUser({
      id: 'a9',
      name: 'Neha Joshi',
      roles: ['accounts'],
      activeRole: 'accounts',
    });
    const settled = withClaims({
      can: can({ settle: true, close: true }),
    });
    settled.transactions.push({
      ...settled.transactions[0]!,
      id: 't2',
      kind: 'return',
      amountPaise: 600_000,
      reference: 'RET1',
    });
    settled.settlement = settle(settled);
    const calls = mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: session(accounts) }),
      'GET /advances/a1': () => ({ status: 200, body: withClaims({ can: can({ settle: true }) }) }),
      'POST /advances/a1/transactions': () => ({ status: 201, body: settled }),
    });
    renderApp('/advances/a1');
    expect(await screen.findByText('Record money returned by the employee')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'EXP-2026-00010' })).toHaveAttribute(
      'href',
      '/verification/v1',
    );
    expect(screen.getByRole('button', { name: 'Close settlement' })).toBeDisabled();
    expect(screen.getByLabelText(/^Amount/)).toHaveValue('6000.00');
    await userEvent.type(screen.getByLabelText('UTR number'), 'ret1');
    await userEvent.click(screen.getByRole('button', { name: 'Record return' }));
    expect(await screen.findByText('Recorded ₹6,000.00 returned.')).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'POST /advances/a1/transactions')!.body).toMatchObject({
      version: 5,
      kind: 'return',
      amountPaise: 600_000,
      reference: 'RET1',
    });
    expect(screen.getByRole('button', { name: 'Close settlement' })).toBeEnabled();
  });

  it('offers open advances on the expense form', async () => {
    const calls = mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: session(makeUser()) }),
      'GET /categories': () => ({ status: 200, body: { data: [] } }),
      'GET /advances/linkable': () => ({
        status: 200,
        body: {
          data: [
            {
              id: 'a1',
              number: 'ADV-2026-00001',
              purpose: 'Pune',
              disbursedPaise: 2_000_000,
              settleBy: null,
            },
          ],
        },
      }),
      'POST /vouchers': () => ({
        status: 400,
        body: { error: { code: 'VALIDATION_FAILED', message: 'stop' } },
      }),
    });
    renderApp('/expenses/new');
    const select = await screen.findByLabelText('Settle against an advance');
    await userEvent.selectOptions(select, 'a1');
    await userEvent.type(screen.getByLabelText('Purpose'), 'Pune trip');
    await userEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    expect(calls.find((c) => c.key === 'POST /vouchers')!.body).toMatchObject({ advanceId: 'a1' });
  });
});
