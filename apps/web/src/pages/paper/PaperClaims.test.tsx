import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { voucher } from '../../test-fixtures';
import { makeUser, mockApi, renderApp, session, type Routes } from '../../test-utils';

afterEach(() => vi.unstubAllGlobals());

const neha = makeUser({
  id: 'acc1',
  name: 'Neha Joshi',
  roles: ['accounts'],
  activeRole: 'accounts',
});
const signedIn: Routes = {
  'POST /auth/refresh': () => ({ status: 200, body: session(neha) }),
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
      ],
    },
  }),
};
const rahulId = '00000000-0000-4000-8000-0000000000b1';

describe('paper claims', () => {
  it('lets Accounts type in a claim for an employee', async () => {
    const paperDraft = voucher({
      id: 'v9',
      enteredBy: { id: 'acc1', name: 'Neha Joshi' },
    });
    const calls = mockApi({
      ...signedIn,
      'GET /vouchers/claimants': () => ({
        status: 200,
        body: {
          data: [{ id: rahulId, name: 'Rahul Das', employeeCode: 'EMP-1024', department: 'Sales' }],
        },
      }),
      'POST /vouchers': () => ({ status: 201, body: paperDraft }),
      'GET /vouchers/v9': () => ({ status: 200, body: paperDraft }),
    });
    renderApp('/paper-claims/new');
    expect(await screen.findByRole('heading', { name: 'Paper claim' })).toBeInTheDocument();

    // Saving without choosing the employee is stopped.
    await userEvent.type(screen.getByLabelText('Purpose'), 'Client visit');
    await userEvent.click(screen.getByRole('button', { name: 'Next: Attachments →' }));
    expect(await screen.findByText('Choose whose claim this is')).toBeInTheDocument();
    expect(calls.some((c) => c.key === 'POST /vouchers')).toBe(false);

    await userEvent.type(screen.getByLabelText('Find employee'), 'rah');
    await screen.findByRole('option', { name: 'Rahul Das (EMP-1024) · Sales' });
    await userEvent.selectOptions(screen.getByLabelText('Claim for'), rahulId);
    await userEvent.selectOptions(screen.getByLabelText('Category'), 'Travel');
    await userEvent.type(screen.getByLabelText('Amount (₹)'), '450');
    await userEvent.type(screen.getByLabelText('Description'), 'Cab');
    await userEvent.click(screen.getByRole('button', { name: 'Next: Attachments →' }));

    await screen.findByText('taxi.pdf');
    expect(calls.find((c) => c.key === 'POST /vouchers')!.body).toMatchObject({
      employeeId: rahulId,
      purpose: 'Client visit',
    });
    expect(calls.find((c) => c.key === 'GET /vouchers/claimants' && c.query)!.query).toBe(
      'search=rah',
    );
  });

  it('shows on the claim that it came from paper', async () => {
    mockApi({
      ...signedIn,
      'GET /vouchers/v9': () => ({
        status: 200,
        body: voucher({ id: 'v9', enteredBy: { id: 'acc1', name: 'Neha Joshi' } }),
      }),
    });
    renderApp('/expenses/v9');
    expect(
      await screen.findByText(/Neha Joshi typed this in from Rahul Das.s paper form/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Paper claims' })).toHaveAttribute(
      'href',
      '/paper-claims',
    );
  });
});
