import type { VoucherDetail, VoucherSummary } from '@ticketmanager/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shrinkImage } from '../lib/shrinkImage';
import { voucher } from '../test-fixtures';
import { makeUser, mockApi, renderApp, session, type Routes } from '../test-utils';

/** Pretends to be a phone: narrow screen and a touch pointer. */
function asPhone() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('max-width: 720px') || query.includes('pointer: coarse'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

const rahul = makeUser();
const signedIn: Routes = {
  'POST /auth/refresh': () => ({ status: 200, body: session(rahul) }),
  'GET /notifications/unread-count': () => ({ status: 200, body: { unread: 2 } }),
};

const row = (over: Partial<VoucherSummary> = {}): VoucherSummary => ({
  id: 'v1',
  number: 'EXP-2026-00148',
  purpose: 'Client meeting at Bengaluru',
  approvalStatus: 'pending_manager',
  project: null,
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

describe('On a phone', () => {
  it('shows tabs along the bottom and a menu that slides in', async () => {
    asPhone();
    mockApi(signedIn);
    renderApp('/');
    const tabs = await screen.findByRole('navigation', { name: 'Quick links' });
    for (const name of ['Home', 'Expenses', 'Advances', /Alerts/, 'More']) {
      expect(within(tabs).getByRole(name === 'More' ? 'button' : 'link', { name })).toBeVisible();
    }
    expect(await within(tabs).findByText('2')).toBeInTheDocument(); // unread count on Alerts

    const open = screen.getByRole('button', { name: 'Open menu' });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(open);
    expect(open).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    expect(open).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(within(tabs).getByRole('button', { name: 'More' }));
    const menu = screen.getByRole('navigation', { name: 'Main' });
    await userEvent.click(within(menu).getByRole('link', { name: 'Documents' }));
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(await screen.findByRole('heading', { name: 'Document centre' })).toBeInTheDocument();
  });

  it('labels every table cell with its column, so rows can show as cards', async () => {
    asPhone();
    mockApi({
      ...signedIn,
      'GET /vouchers': () => ({
        status: 200,
        body: { data: [row()], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } },
      }),
      'GET /vouchers/counts': () => ({
        status: 200,
        body: { all: 1, draft: 0, pending: 1, approved: 0, rejected: 0, cancelled: 0 },
      }),
    });
    renderApp('/expenses');
    const cell = (await screen.findByText('EXP-2026-00148')).closest('td')!;
    expect(cell).toHaveAttribute('data-label', 'Voucher no.');
    const amount = screen.getByText('₹7,200.00', { selector: 'td' });
    expect(amount).toHaveAttribute('data-label', 'Amount');
  });

  it('offers the camera for bills, and uploads the photo', async () => {
    asPhone();
    const draft: VoucherDetail = voucher({ approvalStatus: 'draft', number: null });
    draft.lines[0]!.attachments = [];
    const calls = mockApi({
      ...signedIn,
      'GET /vouchers/v1': () => ({ status: 200, body: draft }),
      'POST /vouchers/v1/lines/l1/attachments': () => ({
        status: 201,
        body: {
          version: draft.version + 1,
          attachment: {
            id: 'a9',
            filename: 'bill.jpg',
            contentType: 'image/jpeg',
            sizeBytes: 1234,
            createdAt: '2026-11-27T05:00:00Z',
          },
        },
      }),
    });
    renderApp('/expenses/v1/edit?step=proofs');
    expect(await screen.findByText(/take a photo, or/)).toBeInTheDocument();
    const camera = screen.getByLabelText('Take a photo of the bill', { selector: 'input' });
    expect(camera).toHaveAttribute('capture', 'environment');
    expect(camera).toHaveAttribute('accept', 'image/*');
    const photo = new File([new Uint8Array(2000)], 'bill.jpg', { type: 'image/jpeg' });
    await userEvent.upload(camera, photo);
    await waitFor(() =>
      expect(calls.some((c) => c.key === 'POST /vouchers/v1/lines/l1/attachments')).toBe(true),
    );
    expect(await screen.findByRole('button', { name: 'bill.jpg' })).toBeInTheDocument();
  });

  it('says so when the connection drops', async () => {
    mockApi(signedIn);
    renderApp('/');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument();
    act(() => void window.dispatchEvent(new Event('offline')));
    expect(screen.getByText(/You're offline/)).toBeInTheDocument();
    act(() => void window.dispatchEvent(new Event('online')));
    expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument();
  });
});

describe('Opening the app without a connection', () => {
  it('says it is offline instead of asking to sign in, and carries on when back online', async () => {
    let online = false;
    mockApi({
      ...signedIn,
      'POST /auth/refresh': () => {
        if (!online) throw new TypeError('Failed to fetch');
        return { status: 200, body: session(rahul) };
      },
    });
    renderApp('/expenses');
    expect(await screen.findByRole('heading', { name: "You're offline" })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
    online = true;
    act(() => void window.dispatchEvent(new Event('online')));
    expect(await screen.findByRole('heading', { name: 'My expenses' })).toBeInTheDocument();
  });
});

describe('On a computer', () => {
  it('shows neither the tabs nor the camera button', async () => {
    mockApi(signedIn);
    renderApp('/');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('navigation', { name: 'Quick links' })).not.toBeInTheDocument();
  });
});

describe('shrinkImage', () => {
  it('leaves PDFs and small photos alone', async () => {
    const pdf = new File([new Uint8Array(3_000_000)], 'bill.pdf', { type: 'application/pdf' });
    const small = new File([new Uint8Array(200_000)], 'bill.jpg', { type: 'image/jpeg' });
    expect(await shrinkImage(pdf)).toBe(pdf);
    expect(await shrinkImage(small)).toBe(small);
  });

  it('keeps the original when the photo can’t be decoded', async () => {
    const big = new File([new Uint8Array(3_000_000)], 'bill.jpg', { type: 'image/jpeg' });
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('not an image');
      }),
    );
    expect(await shrinkImage(big)).toBe(big);
  });
});
