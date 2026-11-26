import { APPROVAL_STATUS_LABELS, type ApprovalStatus } from '@ticketmanager/shared';

const TONE: Partial<Record<ApprovalStatus, string>> = {
  draft: 'muted-pill',
  approved: 'up',
  partially_approved: 'up',
  manager_rejected: 'down',
  accounts_rejected: 'down',
  director_rejected: 'down',
  cancelled: 'muted-pill',
};

export function VoucherStatus({ status }: { status: ApprovalStatus }) {
  return (
    <span className={`pill ${TONE[status] ?? 'pending'}`}>{APPROVAL_STATUS_LABELS[status]}</span>
  );
}

const dateFormat = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
const dateTimeFormat = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** "2026-11-18" → "18 Nov 2026", read as a calendar date (no time-zone shift). */
export function formatDay(iso: string | null | undefined) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return dateFormat.format(new Date(y!, m! - 1, d!));
}

export function formatWhen(iso: string | null | undefined) {
  return iso ? dateTimeFormat.format(new Date(iso)) : '—';
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
