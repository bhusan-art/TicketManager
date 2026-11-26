import type { AccountsDashboard, Payment, VoucherDetail } from '@ticketmanager/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUser, mockApi, renderApp, session } from '../../test-utils';
import { perms, voucher } from '../../test-fixtures';

afterEach(() => vi.unstubAllGlobals());

const accounts = makeUser({
  id: 'a1',
  name: 'Neha Joshi',
  roles: ['accounts', 'employee'],
  activeRole: 'accounts',
});
const signedIn = { 'POST /auth/refresh': () => ({ status: 200, body: session(accounts) }) };

const payment = (over: Partial<Payment> = {}): Payment => ({
  id: 'p1',
  number: 'PAY-2026-00001',
  amountPaise: 300_000,
  paidOn: '2026-11-20',
  mode: 'bank_transfer',
  reference: 'HDFC000123',
  note: null,
  recordedBy: { id: 'a1', name: 'Neha Joshi' },
  createdAt: '2026-11-20T10:00:00Z',
  reversedAt: null,
  reversedBy: null,
  reversalReason: null,
  ...over,
});

const approved = (over: Partial<VoucherDetail> = {}): VoucherDetail =>
  voucher({
    number: 'EXP-2026-00148',
    approvalStatus: 'approved',
    paymentStatus: 'payment_pending',
    approvedTotalPaise: 720_000,
    outstandingPaise: 720_000,
    waitingOn: null,
    can: perms({ pay: true, comment: true }),
    ...over,
  });

describe('Paying a voucher', () => {
  it('records an instalment with the UTR', async () => {
    const calls = mockApi({
      ...signedIn,
      'GET /vouchers/v1': () => ({ status: 200, body: approved() }),
      'POST /vouchers/v1/payments': () => ({
        status: 201,
        body: approved({
          paymentStatus: 'partially_paid',
          paidPaise: 300_000,
          outstandingPaise: 420_000,
          payments: [payment()],
        }),
      }),
    });
    renderApp('/payments/v1');
    const amount = await screen.findByLabelText(/^Amount/);
    expect(amount).toHaveValue('7200.00');

    // More than outstanding can't be sent.
    await userEvent.clear(amount);
    await userEvent.type(amount, '8000');
    expect(screen.getByText('More than is outstanding')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record payment' })).toBeDisabled();

    await userEvent.clear(amount);
    await userEvent.type(amount, '3000');
    await userEvent.type(screen.getByLabelText('UTR number'), 'hdfc000123');
    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));

    expect(
      await screen.findByText('Recorded ₹3,000.00. ₹4,200.00 is still outstanding.'),
    ).toBeInTheDocument();
    const call = calls.find((c) => c.key === 'POST /vouchers/v1/payments')!;
    expect(call.body).toMatchObject({
      version: 3,
      amountPaise: 300_000,
      mode: 'bank_transfer',
      reference: 'HDFC000123',
    });
    expect(call.headers['Idempotency-Key']).toBeTruthy();
    expect(screen.getByText('PAY-2026-00001')).toBeInTheDocument();
  });

  it('reverses a payment with a reason', async () => {
    const paid = approved({
      paymentStatus: 'paid',
      paidPaise: 720_000,
      outstandingPaise: 0,
      payments: [payment({ amountPaise: 720_000 })],
      can: perms({ comment: true }),
    });
    const calls = mockApi({
      ...signedIn,
      'GET /vouchers/v1': () => ({ status: 200, body: paid }),
      'POST /vouchers/v1/payments/p1/reverse': () => ({
        status: 200,
        body: approved({
          payments: [
            payment({
              amountPaise: 720_000,
              reversedAt: '2026-11-21T10:00:00Z',
              reversedBy: { id: 'a1', name: 'Neha Joshi' },
              reversalReason: 'Wrong account',
            }),
          ],
        }),
      }),
    });
    renderApp('/payments/v1');
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Reverse' }));
    await userEvent.type(screen.getByLabelText('Why is it being reversed?'), 'Wrong account');
    await userEvent.click(screen.getByRole('button', { name: 'Reverse payment' }));
    expect(
      await screen.findByText('Reversed PAY-2026-00001. ₹7,200.00 is outstanding again.'),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'POST /vouchers/v1/payments/p1/reverse')!.body).toEqual({
      version: 3,
      reason: 'Wrong account',
    });
    expect(screen.getByText(/^Reversed .* Wrong account$/)).toBeInTheDocument();
  });

  it('shows the employee what was paid, without payment controls', async () => {
    mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: session(makeUser()) }),
      'GET /vouchers/v1': () => ({
        status: 200,
        body: approved({
          paymentStatus: 'partially_paid',
          paidPaise: 300_000,
          outstandingPaise: 420_000,
          payments: [payment()],
          can: perms({ comment: true }),
        }),
      }),
    });
    renderApp('/expenses/v1');
    expect(await screen.findByText('PAY-2026-00001')).toBeInTheDocument();
    expect(screen.getByText('HDFC000123')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
  });
});

describe('Accounts dashboard', () => {
  it('shows what to verify and what is owed', async () => {
    const dash: AccountsDashboard = {
      toVerify: { count: 4, amountPaise: 1_250_000 },
      awaitingPayment: { count: 2, amountPaise: 980_000 },
      paidThisMonth: { count: 7, amountPaise: 3_100_000 },
      claimedThisMonth: { count: 12, amountPaise: 5_600_000 },
      openAdvances: { count: 1, amountPaise: 2_000_000, overdue: 0 },
      liabilityAging: [
        { bucket: '0-7', count: 1, amountPaise: 500_000 },
        { bucket: '8-30', count: 1, amountPaise: 480_000 },
        { bucket: '31-60', count: 0, amountPaise: 0 },
        { bucket: '60+', count: 0, amountPaise: 0 },
      ],
      monthly: ['06', '07', '08', '09', '10', '11'].map((m) => ({
        month: `2026-${m}`,
        approvedPaise: 1_000_000,
        paidPaise: 800_000,
      })),
    };
    mockApi({
      ...signedIn,
      'GET /accounts/dashboard': () => ({ status: 200, body: dash }),
      'GET /health': () => ({ status: 200, body: { status: 'ok', version: '1', checks: {} } }),
    });
    renderApp('/');
    const owed = (await screen.findByText('Approved, not paid')).closest('a')!;
    expect(owed).toHaveAttribute('href', '/payments');
    expect(within(owed).getByText('₹9,800.00')).toBeInTheDocument();
    expect(screen.getByText('8-30 days')).toBeInTheDocument();
  });
});

describe('Reports', () => {
  it('shows spend by department and the unpaid list', async () => {
    const row = {
      vouchers: 3,
      claimedPaise: 209_000,
      approvedPaise: 178_000,
      paidPaise: 118_000,
      outstandingPaise: 60_000,
      inReviewPaise: 9_000,
      rejectedPaise: 0,
    };
    const calls = mockApi({
      ...signedIn,
      'GET /reports/departments': () => ({
        status: 200,
        body: { data: [{ id: 'd1', name: 'Sales' }] },
      }),
      'GET /reports': () => ({
        status: 200,
        body: {
          totals: row,
          byDepartment: [{ key: { id: 'd1', name: 'Sales' }, ...row }],
          byEmployee: [],
          byCategory: [],
        },
      }),
      'GET /reports/liability': () => ({
        status: 200,
        body: {
          data: [
            {
              id: 'v1',
              number: 'EXP-2026-00148',
              employee: { id: 'u1', name: 'Rahul Das' },
              department: { id: 'd1', name: 'Sales' },
              approvalStatus: 'approved',
              paymentStatus: 'partially_paid',
              decidedAt: '2026-11-01T10:00:00Z',
              ageDays: 25,
              approvedPaise: 100_000,
              paidPaise: 40_000,
              outstandingPaise: 60_000,
            },
          ],
        },
      }),
    });
    renderApp('/reports');
    expect(await screen.findByRole('cell', { name: 'Sales' })).toBeInTheDocument();
    expect(screen.getAllByText('₹2,090.00').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('tab', { name: 'Approved, not paid' }));
    expect(screen.getByRole('link', { name: 'EXP-2026-00148' })).toHaveAttribute(
      'href',
      '/payments/v1',
    );
    await userEvent.selectOptions(screen.getByLabelText('Department'), 'd1');
    expect(calls.some((c) => c.key === 'GET /reports/liability')).toBe(true);
  });
});
