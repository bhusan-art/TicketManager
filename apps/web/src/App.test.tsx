import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('App shell', () => {
  it('shows the sidebar and service status', async () => {
    mockFetch(200, {
      status: 'ok',
      version: '0.1.0',
      uptimeSeconds: 3,
      checks: { mongo: 'up', redis: 'up', storage: 'up' },
    });
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(await screen.findByText('All services up · API v0.1.0')).toBeInTheDocument();
    expect(screen.getByText('Database')).toBeInTheDocument();
  });

  it('flags a degraded backend', async () => {
    mockFetch(503, {
      status: 'degraded',
      version: '0.1.0',
      uptimeSeconds: 3,
      checks: { mongo: 'up', storage: 'down' },
    });
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Some services are down/)).toBeInTheDocument();
    expect(screen.getByText('Down')).toBeInTheDocument();
  });

  it('shows a placeholder for screens from later phases', () => {
    mockFetch(200, { status: 'ok', version: 'x', uptimeSeconds: 0, checks: {} });
    render(
      <MemoryRouter initialEntries={['/advances']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText('This screen arrives in Phase 5.')).toBeInTheDocument();
  });
});
