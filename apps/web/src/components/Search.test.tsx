import type { SearchResponse } from '@ticketmanager/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUser, mockApi, renderApp, session } from '../test-utils';

afterEach(() => vi.unstubAllGlobals());

const results: SearchResponse = {
  claims: [
    {
      id: 'v1',
      title: 'Client visit to Pune',
      subtitle: 'EXP-2026-00012 · Rahul Das',
      path: '/verification/v1',
      amountPaise: 450_000,
      status: 'pending_accounts',
    },
  ],
  advances: [],
  people: [],
};

describe('top-bar search', () => {
  it('finds claims and pages, and opens one with the keyboard', async () => {
    const user = makeUser({ roles: ['accounts'], activeRole: 'accounts' });
    const calls = mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: session(user) }),
      'GET /search': () => ({ status: 200, body: results }),
    });
    renderApp('/');
    const box = await screen.findByRole('combobox', { name: 'Search' });

    await userEvent.type(box, 'pa');
    // Pages match straight away, without asking the server.
    const list = await screen.findByRole('listbox', { name: 'Search results' });
    expect(within(list).getByRole('option', { name: /Payments/ })).toBeInTheDocument();

    await userEvent.clear(box);
    await userEvent.type(box, 'pune');
    const hit = await screen.findByRole('option', { name: /Client visit to Pune/ });
    expect(hit).toHaveTextContent('₹4,500.00');
    expect(hit).toHaveTextContent('Pending accounts');
    expect(calls.filter((c) => c.key === 'GET /search').at(-1)!.query).toBe('q=pune');

    await userEvent.keyboard('{Enter}');
    expect(box).toHaveValue('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('says when nothing matches', async () => {
    mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: session(makeUser()) }),
      'GET /search': () => ({ status: 200, body: { claims: [], advances: [], people: [] } }),
    });
    renderApp('/');
    await userEvent.type(await screen.findByRole('combobox', { name: 'Search' }), 'zzz');
    expect(await screen.findByText('Nothing matches “zzz”.')).toBeInTheDocument();
  });
});
