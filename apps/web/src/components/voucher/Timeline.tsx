import {
  ROLE_LABELS,
  formatRupees,
  type VoucherDetail,
  type VoucherEvent,
} from '@ticketmanager/shared';
import { useState, type FormEvent } from 'react';
import { ApiError, apiPost } from '../../lib/api';
import { formatWhen } from '../VoucherStatus';

const WHO: Record<string, string> = {
  pending_manager: 'the manager',
  pending_accounts: 'Accounts',
  pending_director: 'the Director',
};

function describe(e: VoucherEvent, v: VoucherDetail): string {
  switch (e.type) {
    case 'created':
      return 'Created the draft';
    case 'submitted':
      return `Submitted to ${e.toStatus === 'pending_manager' && v.manager ? v.manager.name : (WHO[e.toStatus ?? ''] ?? 'review')}`;
    case 'resubmitted':
      return 'Resubmitted after changes';
    case 'review_started':
      return 'Started verification';
    case 'approved': {
      const total = (e.meta?.approvedTotalPaise as number | undefined) ?? null;
      const reduced = Array.isArray(e.meta?.reduced) && e.meta.reduced.length > 0;
      const forward = e.toStatus === 'pending_accounts' ? ' and sent it to Accounts' : '';
      return reduced && total !== null
        ? `Approved ${formatRupees(total)} of ${formatRupees(v.totalPaise)}${forward}`
        : `Approved${forward}`;
    }
    case 'queried':
      return 'Asked a question';
    case 'answered':
      return 'Answered the query';
    case 'returned':
      return 'Returned it for changes';
    case 'rejected':
      return 'Rejected it';
    case 'cancelled':
      return 'Cancelled it';
    case 'comment':
      return 'Commented';
    case 'attachment_added':
      return 'Added a bill';
    case 'payment_recorded': {
      const amount = formatRupees(Number(e.meta?.amountPaise ?? 0));
      return e.meta?.status === 'paid' ? `Paid ${amount}, paid in full` : `Paid ${amount}`;
    }
    case 'payment_reversed':
      return `Reversed payment ${String(e.meta?.number ?? '')} of ${formatRupees(Number(e.meta?.amountPaise ?? 0))}`;
  }
}

const TONE: Partial<Record<VoucherEvent['type'], string>> = {
  approved: 'good',
  rejected: 'bad',
  cancelled: 'bad',
  queried: 'warn',
  returned: 'warn',
  comment: 'quiet',
  attachment_added: 'quiet',
  payment_recorded: 'good',
  payment_reversed: 'bad',
};

/** The voucher's activity: every step and comment, oldest first, with a comment box. */
export function Timeline({
  voucher,
  onChange,
}: {
  voucher: VoucherDetail;
  onChange: (v: VoucherDetail) => void;
}) {
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onChange(
        await apiPost<VoucherDetail>(`/vouchers/${voucher.id}/comments`, { message: comment }),
      );
      setComment('');
    } catch (err) {
      setError(
        err instanceof ApiError ? (err.fieldErrors.message ?? err.message) : 'Could not post',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card wide">
      <h2>Activity</h2>
      <ol className="timeline">
        {voucher.events.map((e) => (
          <li key={e.id} className={TONE[e.type]}>
            <span>
              <strong>{e.actor?.name ?? 'System'}</strong>
              {e.actorRole && e.actorRole !== 'employee' && (
                <span className="muted small"> · {ROLE_LABELS[e.actorRole]}</span>
              )}
            </span>
            <span>
              {e.type === 'attachment_added' ? `Added a bill: ${e.message}` : describe(e, voucher)}
            </span>
            {e.message && e.type !== 'attachment_added' && (
              <blockquote className={`event-message ${e.type}`}>{e.message}</blockquote>
            )}
            <span className="muted small">{formatWhen(e.at)}</span>
          </li>
        ))}
      </ol>
      {voucher.can.comment && (
        <form className="comment-box" onSubmit={send}>
          <textarea
            aria-label="Add a comment"
            placeholder="Add a comment…"
            rows={2}
            maxLength={1000}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          {error && (
            <span className="field-error" role="alert">
              {error}
            </span>
          )}
          <button className="btn btn-secondary" disabled={busy || comment.trim().length < 3}>
            Post comment
          </button>
        </form>
      )}
    </div>
  );
}
