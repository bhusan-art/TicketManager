import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { health, makeUser, mockApi, renderApp, session } from './test-utils';

afterEach(() => vi.unstubAllGlobals());

const signedOut = {
  status: 401,
  body: { error: { code: 'UNAUTHENTICATED', message: 'Please sign in' } },
};
const authConfig = (googleEnabled = false) => ({ status: 200, body: { googleEnabled } });

describe('signing in', () => {
  it('sends a signed-out visitor to the sign-in page', async () => {
    mockApi({ 'POST /auth/refresh': () => signedOut, 'GET /auth/config': () => authConfig() });
    renderApp('/');
    expect(
      await screen.findByRole('heading', { name: 'Sign in to your account' }),
    ).toBeInTheDocument();
  });

  it('signs in and lands on the dashboard', async () => {
    const user = makeUser();
    const calls = mockApi({
      'POST /auth/refresh': () => signedOut,
      'GET /auth/config': () => authConfig(),
      'POST /auth/login': () => ({ status: 200, body: session(user) }),
      'GET /health': health,
    });
    renderApp('/');
    await userEvent.type(await screen.findByLabelText('Email address'), 'rahul@company.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Expense#2026');
    expect(screen.getByLabelText('Keep me signed in')).not.toBeChecked();
    await userEvent.click(screen.getByLabelText('Keep me signed in'));
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: /, Rahul$/ })).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'POST /auth/login')!.body).toEqual({
      email: 'rahul@company.com',
      password: 'Expense#2026',
      remember: true,
    });
  });

  it('shows the server’s message when sign-in fails', async () => {
    mockApi({
      'POST /auth/refresh': () => signedOut,
      'GET /auth/config': () => authConfig(),
      'POST /auth/login': () => ({
        status: 401,
        body: { error: { code: 'UNAUTHENTICATED', message: 'Email or password is incorrect' } },
      }),
    });
    renderApp('/login');
    await userEvent.type(await screen.findByLabelText('Email address'), 'x@y.co');
    await userEvent.type(screen.getByLabelText('Password'), 'bad');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect');
  });

  it('offers Google only when it is set up, and explains a Google error', async () => {
    mockApi({ 'POST /auth/refresh': () => signedOut, 'GET /auth/config': () => authConfig(true) });
    renderApp('/login?error=google_not_registered');
    expect(await screen.findByRole('link', { name: /Sign in with Google/ })).toHaveAttribute(
      'href',
      '/api/v1/auth/google/start',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('not registered');
  });
});

describe('roles', () => {
  it('shows only the menu items of the active role, and switches role', async () => {
    const user = makeUser({ roles: ['employee', 'admin'], activeRole: 'employee' });
    mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: session(user) }),
      'GET /health': health,
      'POST /auth/switch-role': (body) => ({
        status: 200,
        body: session({ ...user, activeRole: (body as { role: 'admin' }).role }),
      }),
    });
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(nav).toHaveTextContent('My expenses');
    expect(nav).not.toHaveTextContent('Users & roles');

    await userEvent.selectOptions(screen.getByLabelText('Active role'), 'admin');
    await waitFor(() => expect(nav).toHaveTextContent('Users & roles'));
    expect(nav).not.toHaveTextContent('My expenses');
  });

  it('hides the role switcher for a single-role user', async () => {
    mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: session(makeUser()) }),
      'GET /health': health,
    });
    renderApp('/');
    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByLabelText('Active role')).not.toBeInTheDocument();
  });

  it('tells a user which role opens an admin page', async () => {
    const user = makeUser({ roles: ['employee', 'admin'], activeRole: 'employee' });
    mockApi({ 'POST /auth/refresh': () => ({ status: 200, body: session(user) }) });
    renderApp('/admin/users');
    expect(await screen.findByText(/Switch to the Admin role/)).toBeInTheDocument();
  });
});

describe('passwords', () => {
  it('checks the password rules and matching confirmation before reset', async () => {
    const calls = mockApi({
      'POST /auth/refresh': () => signedOut,
      'POST /auth/password/reset': () => ({ status: 204 }),
    });
    renderApp('/reset-password?token=abcdefghijklmnopqrstuvwxyz');
    const submit = await screen.findByRole('button', { name: 'Reset password' });
    await userEvent.type(screen.getByLabelText('New password'), 'weak');
    expect(submit).toBeDisabled();

    await userEvent.clear(screen.getByLabelText('New password'));
    await userEvent.type(screen.getByLabelText('New password'), 'Strong#2026');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'Strong#2026');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    expect(await screen.findByText(/Your password is set/)).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'POST /auth/password/reset')!.body).toEqual({
      token: 'abcdefghijklmnopqrstuvwxyz',
      password: 'Strong#2026',
    });
  });

  it('says the same thing after a forgot-password request whether or not the email exists', async () => {
    mockApi({
      'POST /auth/refresh': () => signedOut,
      'POST /auth/password/forgot': () => ({ status: 204 }),
    });
    renderApp('/forgot-password');
    await userEvent.type(await screen.findByLabelText('Email address'), 'who@company.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/If/)).toHaveTextContent('who@company.com has an account');
  });
});

describe('admin', () => {
  it('lists users with their roles', async () => {
    const admin = makeUser({ roles: ['admin'], activeRole: 'admin' });
    mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: session(admin) }),
      'GET /admin/departments': () => ({ status: 200, body: { data: [] } }),
      'GET /admin/users': () => ({
        status: 200,
        body: {
          data: [
            {
              id: 'u2',
              email: 'neha@company.com',
              name: 'Neha Joshi',
              employeeCode: 'EMP-1030',
              designation: null,
              roles: ['employee', 'manager'],
              status: 'active',
              department: { id: 'd1', name: 'Engineering' },
              manager: null,
              hasPassword: false,
              googleLinked: false,
              lastLoginAt: null,
              createdAt: '2026-11-26T00:00:00Z',
            },
          ],
          meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
        },
      }),
    });
    renderApp('/admin/users');
    expect(await screen.findByRole('link', { name: 'Neha Joshi' })).toHaveAttribute(
      'href',
      '/admin/users/u2',
    );
    expect(screen.getByText('Invite pending')).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveTextContent('Manager');
  });
});
