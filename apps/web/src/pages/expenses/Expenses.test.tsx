import type { VoucherSummary } from '@ticketmanager/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { perms, voucher } from '../../test-fixtures';
import { makeUser, mockApi, renderApp, session, type Routes } from '../../test-utils';

afterEach(() => vi.unstubAllGlobals());

const user = makeUser();
const signedIn: Routes = {
  'POST /auth/refresh': () => ({ status: 200, body: session(user) }),
  'GET /categories': () => ({
    status: 200,
    body: {
      data: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'Travel',
          description: null,
          status: 'active',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          name: 'Meals',
          description: null,
          status: 'active',
        },
      ],
    },
  }),
};

const summary = (over: Partial<VoucherSummary> = {}): VoucherSummary => ({
  id: 'v1',
  number: 'EXP-2026-00148',
  purpose: 'Client meeting at Bengaluru',
  approvalStatus: 'pending_manager',
  paymentStatus: 'not_due',
  totalPaise: 720_000,
  lineCount: 1,
  expenseDate: '2026-11-18',
  categories: ['Travel'],
  submittedAt: '2026-11-18T10:00:00Z',
  createdAt: '2026-11-18T09:00:00Z',
  updatedAt: '2026-11-18T10:00:00Z',
  ...over,
});

describe('My expenses', () => {
  it('lists vouchers with tab counts', async () => {
    mockApi({
      ...signedIn,
      'GET /vouchers': () => ({
        status: 200,
        body: {
          data: [summary(), summary({ id: 'v2', number: null, approvalStatus: 'draft' })],
          meta: { page: 1, pageSize: 20, total: 2, totalPages: 1 },
        },
      }),
      'GET /vouchers/counts': () => ({
        status: 200,
        body: { all: 2, draft: 1, pending: 1, approved: 0, rejected: 0, cancelled: 0 },
      }),
    });
    renderApp('/expenses');
    expect(await screen.findByText('EXP-2026-00148')).toBeInTheDocument();
    expect(screen.getAllByText('₹7,200.00', { selector: 'td' })).toHaveLength(2);
    expect(screen.getByText('Pending manager')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Draft' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /^Pending\s*1$/ })).toBeInTheDocument();
  });
});

describe('Submit expense', () => {
  it('saves the details as a draft in paise and moves to attachments', async () => {
    const calls = mockApi({
      ...signedIn,
      'POST /vouchers': () => ({ status: 201, body: voucher({ id: 'v9' }) }),
      'GET /vouchers/v9': () => ({ status: 200, body: voucher({ id: 'v9' }) }),
    });
    renderApp('/expenses/new');
    await userEvent.type(await screen.findByLabelText('Purpose'), 'Client meeting at Bengaluru');
    await screen.findByRole('option', { name: 'Travel' });
    await userEvent.selectOptions(screen.getByLabelText('Category'), 'Travel');
    await userEvent.type(screen.getByLabelText('Amount (₹)'), '7,200.5');
    await userEvent.type(screen.getByLabelText('Description'), 'Cab to client office');
    await userEvent.click(screen.getByRole('button', { name: 'Next: Attachments →' }));

    expect(await screen.findByText('taxi.pdf')).toBeInTheDocument();
    const body = calls.find((c) => c.key === 'POST /vouchers')!.body as {
      purpose: string;
      lines: { amountPaise: number; categoryId: string }[];
    };
    expect(body.purpose).toBe('Client meeting at Bengaluru');
    expect(body.lines[0]).toMatchObject({
      amountPaise: 720_050,
      categoryId: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('flags an amount that is not a number', async () => {
    const calls = mockApi(signedIn);
    renderApp('/expenses/new');
    await userEvent.type(await screen.findByLabelText('Amount (₹)'), '12.345');
    await userEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    expect(await screen.findByText('Enter an amount like 1250 or 1250.50')).toBeInTheDocument();
    expect(calls.some((c) => c.key === 'POST /vouchers')).toBe(false);
  });

  it('lists what blocks submission on the review step', async () => {
    const draft = voucher();
    draft.lines[0]!.attachments = [];
    mockApi({ ...signedIn, 'GET /vouchers/v1': () => ({ status: 200, body: draft }) });
    renderApp('/expenses/v1/edit?step=review');
    const issues = await screen.findByRole('alert');
    expect(
      within(issues).getByText(/Expense 1: Attach a bill, or explain why there is none/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('I confirm the above information is correct.'));
    expect(screen.getByRole('button', { name: 'Submit expense' })).toBeDisabled();
  });

  it('submits once confirmed, with an idempotency key', async () => {
    const submitted = voucher({
      version: 5,
      number: 'EXP-2026-00149',
      approvalStatus: 'pending_manager',
      manager: { id: 'm1', name: 'Amit Verma' },
      submittedAt: '2026-11-18T10:00:00Z',
      can: perms({ cancel: true, comment: true }),
    });
    let current = voucher();
    const calls = mockApi({
      ...signedIn,
      'GET /vouchers/v1': () => ({ status: 200, body: current }),
      'PATCH /vouchers/v1': () => ({ status: 200, body: voucher({ version: 4 }) }),
      'POST /vouchers/v1/submit': () => {
        current = submitted;
        return { status: 200, body: submitted };
      },
    });
    renderApp('/expenses/v1/edit?step=review');
    const submit = await screen.findByRole('button', { name: 'Submit expense' });
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByLabelText('I confirm the above information is correct.'));
    await userEvent.click(submit);

    expect(await screen.findByText('Submitted as EXP-2026-00149.')).toBeInTheDocument();
    const call = calls.find((c) => c.key === 'POST /vouchers/v1/submit')!;
    expect(call.body).toEqual({ version: 4 });
    expect(call.headers['Idempotency-Key']).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cancel voucher/ })).toBeInTheDocument();
  });
});
