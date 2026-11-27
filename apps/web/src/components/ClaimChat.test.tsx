import type { ChatMessage } from '@ticketmanager/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { voucher } from '../test-fixtures';
import { makeUser, mockApi, renderApp, session, type Routes } from '../test-utils';

afterEach(() => vi.unstubAllGlobals());

const rahul = makeUser();
const signedIn: Routes = {
  'POST /auth/refresh': () => ({ status: 200, body: session(rahul) }),
};
const fromNeha: ChatMessage = {
  id: 1,
  author: { id: 'acc1', name: 'Neha Joshi' },
  authorRole: 'accounts',
  body: 'Please share the hotel bill',
  createdAt: '2026-11-27T05:00:00.000Z',
};

describe('chat on a claim', () => {
  it('shows the conversation and sends a reply', async () => {
    const submitted = voucher({
      submittedAt: '2026-11-26T05:00:00.000Z',
      approvalStatus: 'pending_accounts',
    });
    const calls = mockApi({
      ...signedIn,
      'GET /vouchers/v1': () => ({ status: 200, body: submitted }),
      'GET /vouchers/v1/follow-up': () => ({ status: 200, body: { waitingOn: null } }),
      'GET /vouchers/v1/chat': () => ({
        status: 200,
        body: { messages: [fromNeha], canPost: true },
      }),
      'POST /vouchers/v1/chat': (body) => ({
        status: 201,
        body: {
          id: 2,
          author: { id: 'u1', name: 'Rahul Das' },
          authorRole: 'employee',
          body: (body as { body: string }).body,
          createdAt: '2026-11-27T05:05:00.000Z',
        },
      }),
    });
    renderApp('/expenses/v1');

    const chat = await screen.findByRole('region', { name: 'Chat' });
    expect(within(chat).getByText('Please share the hotel bill')).toBeInTheDocument();
    expect(within(chat).getByText('Neha Joshi · Accounts')).toBeInTheDocument();

    await userEvent.type(within(chat).getByLabelText('Message'), 'Attached it now{Enter}');
    expect(await within(chat).findByText('Attached it now')).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'POST /vouchers/v1/chat')!.body).toEqual({
      body: 'Attached it now',
    });
    expect(within(chat).getByLabelText('Message')).toHaveValue('');
  });

  it('has no chat on a draft', async () => {
    const calls = mockApi({
      ...signedIn,
      'GET /vouchers/v1': () => ({ status: 200, body: voucher() }),
    });
    renderApp('/expenses/v1');
    expect(await screen.findByRole('heading', { name: /voucher/i, level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Chat' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.key === 'GET /vouchers/v1/chat')).toBe(false);
  });
});
