import type { Project } from '@ticketmanager/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUser, mockApi, renderApp, session } from '../../test-utils';

afterEach(() => vi.unstubAllGlobals());

const P1 = '00000000-0000-4000-8000-0000000000a1';
const project = (over: Partial<Project> = {}): Project => ({
  id: P1,
  name: 'Mumbai Metro',
  code: 'PRJ-104',
  description: null,
  status: 'active',
  ...over,
});

const admin = makeUser({ id: 'ad1', name: 'Asha Rao', roles: ['admin'], activeRole: 'admin' });
const accounts = makeUser({
  id: 'a1',
  name: 'Neha Joshi',
  roles: ['accounts'],
  activeRole: 'accounts',
});
const common = {
  'GET /notifications/unread-count': () => ({ status: 200, body: { unread: 0 } }),
};

describe('Projects', () => {
  it('lets an admin add a project', async () => {
    let projects: Project[] = [];
    const calls = mockApi({
      ...common,
      'POST /auth/refresh': () => ({ status: 200, body: session(admin) }),
      'GET /projects': () => ({ status: 200, body: { data: projects } }),
      'POST /projects': (body) => {
        projects = [project()];
        return { status: 201, body: { ...projects[0], ...(body as object) } };
      },
    });
    renderApp('/admin/projects');
    await userEvent.click(await screen.findByRole('button', { name: '+ Add project' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Mumbai Metro');
    await userEvent.type(screen.getByLabelText(/^Code/), 'PRJ-104');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls.find((c) => c.key === 'POST /projects')!.body).toMatchObject({
      name: 'Mumbai Metro',
      code: 'PRJ-104',
      status: 'active',
    });
    expect(await screen.findByRole('cell', { name: 'Mumbai Metro' })).toBeInTheDocument();
  });
});

describe('Employment type', () => {
  it('lets a regular employee have no manager, but not a contractual one', async () => {
    const calls = mockApi({
      ...common,
      'POST /auth/refresh': () => ({ status: 200, body: session(admin) }),
      'GET /admin/departments': () => ({ status: 200, body: { data: [] } }),
      'GET /admin/users': () => ({
        status: 200,
        body: { data: [], meta: { page: 1, pageSize: 100, total: 0, totalPages: 0 } },
      }),
      'POST /admin/users': () => ({ status: 201, body: {} }),
    });
    renderApp('/admin/users/new');
    await userEvent.type(await screen.findByLabelText('Full name'), 'Kiran Mehta');
    await userEvent.type(screen.getByLabelText('Email'), 'kiran@company.com');
    expect(screen.getByText(/claims go straight to Accounts/)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Employment type'), 'contractual');
    expect(screen.getByText('Contractual employees need a reporting manager')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Create user' });
    expect(save).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText('Employment type'), 'regular');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.key === 'POST /admin/users')?.body).toMatchObject({
        employmentType: 'regular',
        managerId: null,
      }),
    );
  });
});

describe('Spend by project', () => {
  it('shows each project total and filters the report by project', async () => {
    const row = {
      vouchers: 4,
      claimedPaise: 500_000,
      approvedPaise: 450_000,
      paidPaise: 200_000,
      outstandingPaise: 250_000,
      inReviewPaise: 50_000,
      rejectedPaise: 0,
    };
    const calls = mockApi({
      ...common,
      'POST /auth/refresh': () => ({ status: 200, body: session(accounts) }),
      'GET /reports/departments': () => ({ status: 200, body: { data: [] } }),
      'GET /projects': () => ({ status: 200, body: { data: [project()] } }),
      'GET /reports': () => ({
        status: 200,
        body: {
          totals: row,
          byDepartment: [],
          byProject: [
            { key: { id: P1, name: 'Mumbai Metro' }, code: 'PRJ-104', employees: 3, ...row },
          ],
          byEmployee: [],
          byCategory: [],
        },
      }),
      'GET /reports/liability': () => ({ status: 200, body: { data: [] } }),
    });
    renderApp('/reports');
    await userEvent.click(await screen.findByRole('tab', { name: 'By project' }));
    const table = await screen.findByRole('table');
    const metro = within(table).getByText('Mumbai Metro').closest('tr')!;
    expect(within(metro).getByText('PRJ-104')).toBeInTheDocument();
    expect(within(metro).getByRole('cell', { name: '3' })).toBeInTheDocument();
    expect(within(metro).getAllByText('₹5,000.00').length).toBeGreaterThan(0);

    await userEvent.selectOptions(screen.getByLabelText('Project'), P1);
    await waitFor(() =>
      expect(
        calls.some((c) => c.key === 'GET /reports' && c.query.includes(`projectId=${P1}`)),
      ).toBe(true),
    );
  });
});
