import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUser, mockApi, renderApp, session } from '../test-utils';

afterEach(() => vi.unstubAllGlobals());

describe('paper claim form', () => {
  it('is offered on My expenses and asks the server for the form', async () => {
    const calls = mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: session(makeUser()) }),
      'GET /vouchers': () => ({
        status: 200,
        body: { data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } },
      }),
      'GET /forms/claim.pdf': () => ({
        status: 503,
        body: { error: { code: 'UNAVAILABLE', message: 'Try again in a minute' } },
      }),
    });
    renderApp('/expenses');
    await userEvent.click(await screen.findByRole('button', { name: /Paper claim form/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in a minute');
    expect(calls.some((c) => c.key === 'GET /forms/claim.pdf')).toBe(true);
  });
});
