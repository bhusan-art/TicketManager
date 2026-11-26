import type { AuditEntry, ExportJob } from '@ticketmanager/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { voucher } from '../../test-fixtures';
import { makeUser, mockApi, renderApp, session } from '../../test-utils';

afterEach(() => vi.unstubAllGlobals());

const page = <T,>(data: T[]) => ({
  status: 200,
  body: { data, meta: { page: 1, pageSize: 20, total: data.length, totalPages: 1 } },
});

const job = (over: Partial<ExportJob> = {}): ExportJob => ({
  id: 'e1',
  status: 'ready',
  filters: {},
  includeProofs: true,
  role: 'accounts',
  filename: 'vouchers-2026-11-26-1030.zip',
  vouchers: 12,
  sizeBytes: 2_400_000,
  error: null,
  downloads: 0,
  createdAt: '2026-11-26T05:00:00Z',
  completedAt: '2026-11-26T05:00:05Z',
  expiresAt: '2026-12-03T05:00:05Z',
  ...over,
});

const neha = makeUser({
  id: 'a1',
  name: 'Neha Joshi',
  roles: ['accounts'],
  activeRole: 'accounts',
});
const common = {
  'GET /notifications/unread-count': () => ({ status: 200, body: { unread: 0 } }),
};

describe('Document centre', () => {
  it('counts what an export would hold, starts it, and lists it', async () => {
    let jobs: ExportJob[] = [];
    const calls = mockApi({
      ...common,
      'POST /auth/refresh': () => ({ status: 200, body: session(neha) }),
      'GET /reports/departments': () => ({
        status: 200,
        body: { data: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Sales' }] },
      }),
      'GET /exports/preview': () => ({
        status: 200,
        body: {
          vouchers: 12,
          totalPaise: 4_550_000,
          proofs: 20,
          proofBytes: 2_000_000,
          tooMany: false,
        },
      }),
      'GET /exports': () => page(jobs),
      'POST /exports': () => {
        jobs = [job({ status: 'queued', vouchers: null, sizeBytes: null, expiresAt: null })];
        return { status: 202, body: jobs[0] };
      },
    });
    renderApp('/documents');
    expect(await screen.findByText('12 vouchers')).toBeInTheDocument();
    expect(screen.getByText(/20 bills/)).toBeInTheDocument();
    expect(screen.getByText('No exports yet.')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Department'), 'Sales');
    await userEvent.selectOptions(screen.getByLabelText('Approval'), 'approved');
    await userEvent.click(screen.getByRole('button', { name: /Create ZIP/ }));
    const post = calls.find((c) => c.key === 'POST /exports')!;
    expect(post.body).toEqual({
      filters: { status: 'approved', departmentId: '00000000-0000-4000-8000-000000000001' },
      includeProofs: true,
    });
    expect(await screen.findByText('Queued')).toBeInTheDocument();
  });

  it('blocks an export that is too big', async () => {
    mockApi({
      ...common,
      'POST /auth/refresh': () => ({ status: 200, body: session(neha) }),
      'GET /reports/departments': () => ({ status: 200, body: { data: [] } }),
      'GET /exports/preview': () => ({
        status: 200,
        body: { vouchers: 800, totalPaise: 1, proofs: 0, proofBytes: 0, tooMany: true },
      }),
      'GET /exports': () => page([]),
    });
    renderApp('/documents');
    expect(await screen.findByText(/An export holds up to 500/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create ZIP/ })).toBeDisabled();
  });

  it('makes a shareable link for a ready export', async () => {
    const calls = mockApi({
      ...common,
      'POST /auth/refresh': () => ({ status: 200, body: session(neha) }),
      'GET /reports/departments': () => ({ status: 200, body: { data: [] } }),
      'GET /exports/preview': () => ({
        status: 200,
        body: { vouchers: 0, totalPaise: 0, proofs: 0, proofBytes: 0, tooMany: false },
      }),
      'GET /exports': () => page([job()]),
      'POST /exports/e1/link': () => ({
        status: 201,
        body: {
          url: 'https://tm.example.com/api/v1/exports/download/abc',
          expiresAt: '2026-11-27T05:00:00Z',
        },
      }),
    });
    renderApp('/documents');
    const row = (await screen.findByText('vouchers-2026-11-26-1030.zip')).closest('tr')!;
    expect(within(row).getByText('Ready')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: /Copy a download link/ }));
    expect(calls.some((c) => c.key === 'POST /exports/e1/link')).toBe(true);
    expect(await within(row).findByLabelText('Download link')).toHaveValue(
      'https://tm.example.com/api/v1/exports/download/abc',
    );
  });

  it('is not offered to admins', async () => {
    mockApi({
      ...common,
      'POST /auth/refresh': () => ({
        status: 200,
        body: session(makeUser({ roles: ['admin'], activeRole: 'admin' })),
      }),
      'GET /health': () => ({ status: 200, body: {} }),
    });
    renderApp('/documents');
    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByRole('link', { name: 'Documents' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Audit log' })).toBeInTheDocument();
  });
});

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 1,
  at: '2026-11-26T06:00:00Z',
  actor: { id: 'm1', name: 'Amit Verma' },
  actorRole: 'manager',
  action: 'voucher.approved',
  entityType: 'voucher',
  entityId: 'v1',
  entityLabel: 'EXP-2026-00012',
  before: { approvalStatus: 'pending_manager' },
  after: { approvalStatus: 'pending_accounts' },
  meta: null,
  requestId: 'req-1',
  ip: '10.0.0.5',
  ...over,
});

describe('Audit log', () => {
  it('lists entries, filters by action, and shows before and after', async () => {
    const calls = mockApi({
      ...common,
      'POST /auth/refresh': () => ({ status: 200, body: session(neha) }),
      'GET /audit/facets': () => ({
        status: 200,
        body: {
          entityTypes: ['voucher', 'user'],
          actions: ['voucher.approved', 'voucher.submitted', 'user.created'],
          actors: [{ id: 'm1', name: 'Amit Verma' }],
        },
      }),
      'GET /audit': () => page([entry()]),
    });
    renderApp('/audit');
    expect(await screen.findByText('EXP-2026-00012')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Voucher approved')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByText(/"pending_manager"/)).toBeInTheDocument();
    expect(screen.getByText(/"pending_accounts"/)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Action'), 'voucher.');
    await waitFor(() =>
      expect(calls.filter((c) => c.key === 'GET /audit').length).toBeGreaterThan(1),
    );
  });
});

describe('WhatsApp', () => {
  it('offers a ready message on a voucher, and names people with no number', async () => {
    const amit = makeUser({
      id: 'm1',
      name: 'Amit Verma',
      roles: ['manager'],
      activeRole: 'manager',
    });
    const v = voucher({
      number: 'EXP-2026-00012',
      approvalStatus: 'manager_query',
      submittedAt: '2026-11-20T09:00:00Z',
    });
    mockApi({
      ...common,
      'POST /auth/refresh': () => ({ status: 200, body: session(amit) }),
      'GET /vouchers/v1': () => ({ status: 200, body: v }),
      'GET /vouchers/v1/follow-up': () => ({ status: 200, body: { waitingOn: null } }),
      'GET /vouchers/v1/whatsapp': () => ({
        status: 200,
        body: {
          suggestions: [
            {
              to: { id: 'u1', name: 'Rahul Das' },
              reason: 'Employee',
              number: '919876543210',
              text: 'Hi Rahul, I have a question on EXP-2026-00012.',
              url: 'https://wa.me/919876543210?text=Hi%20Rahul',
            },
          ],
          missing: [{ id: 'x', name: 'Sara Khan' }],
        },
      }),
    });
    renderApp('/approvals/v1');
    const link = await screen.findByRole('link', { name: /WhatsApp Rahul/ });
    expect(link).toHaveAttribute('href', 'https://wa.me/919876543210?text=Hi%20Rahul');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/\+91 98765 43210/)).toBeInTheDocument();
    expect(screen.getByText(/No WhatsApp number saved for Sara Khan/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'See message' }));
    expect(screen.getByText('Hi Rahul, I have a question on EXP-2026-00012.')).toBeInTheDocument();
  });

  it('saves your own number on the profile', async () => {
    const rahul = makeUser();
    const calls = mockApi({
      ...common,
      'POST /auth/refresh': () => ({ status: 200, body: session(rahul) }),
      'PUT /auth/me/whatsapp': () => ({
        status: 200,
        body: { ...rahul, whatsappNumber: '919876543210' },
      }),
    });
    renderApp('/profile');
    await userEvent.type(await screen.findByLabelText('WhatsApp number'), '98765 43210');
    await userEvent.click(screen.getByRole('button', { name: 'Save number' }));
    expect(calls.find((c) => c.key === 'PUT /auth/me/whatsapp')!.body).toEqual({
      whatsappNumber: '98765 43210',
    });
    expect(await screen.findByText('WhatsApp number saved.')).toBeInTheDocument();
    expect(screen.getByLabelText('WhatsApp number')).toHaveValue('+91 98765 43210');
  });

  it('shows a clear error for a bad number', async () => {
    mockApi({
      ...common,
      'POST /auth/refresh': () => ({ status: 200, body: session(makeUser()) }),
      'PUT /auth/me/whatsapp': () => ({
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Check the highlighted fields',
            details: [
              { path: 'whatsappNumber', message: 'Enter a mobile number like 98765 43210' },
            ],
          },
        },
      }),
    });
    renderApp('/profile');
    await userEvent.type(await screen.findByLabelText('WhatsApp number'), '123');
    await userEvent.click(screen.getByRole('button', { name: 'Save number' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a mobile number like 98765 43210',
    );
  });
});
