import { formatRupees, rupeesInWords, type VoucherDetail } from '@ticketmanager/shared';
import { Download, FileText, Paperclip, Pencil, Trash2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useUser } from '../../auth/AuthContext';
import { Field, FormError } from '../../components/forms';
import { AnswerPanel } from '../../components/voucher/AnswerPanel';
import { PaymentPanel } from '../../components/voucher/PaymentPanel';
import { ReviewPanel } from '../../components/voucher/ReviewPanel';
import { Timeline } from '../../components/voucher/Timeline';
import { FollowUp } from '../../components/FollowUp';
import {
  PaymentStatusPill,
  VoucherStatus,
  formatBytes,
  formatDay,
} from '../../components/VoucherStatus';
import { ApiError, apiDelete, apiGet, apiPost, fetchFile } from '../../lib/api';

/** Where the page was opened from: the employee's list or an approver's queue. */
const BACK: Record<string, { to: string; label: string }> = {
  expenses: { to: '/expenses', label: 'My expenses' },
  approvals: { to: '/approvals', label: 'Approvals' },
  verification: { to: '/verification', label: 'Verification' },
  payments: { to: '/payments', label: 'Payments' },
};

export function VoucherDetails() {
  const user = useUser();
  const { id } = useParams();
  const section = useLocation().pathname.split('/')[1] ?? 'expenses';
  const back = BACK[section] ?? BACK.expenses!;
  const startedReview = useRef(false);
  const navigate = useNavigate();
  const location = useLocation();
  const [voucher, setVoucher] = useState<VoucherDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(
    (location.state as { notice?: string } | null)?.notice ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    apiGet<VoucherDetail>(`/vouchers/${id}`).then(
      (v) => {
        if (!active) return;
        setVoucher(v);
        // Accounts opening a voucher marks it as under verification.
        if (
          v.can.approve &&
          v.approvalStatus === 'pending_accounts' &&
          !v.accountsReviewStartedAt &&
          !startedReview.current
        ) {
          startedReview.current = true;
          apiPost<VoucherDetail>(`/vouchers/${v.id}/start-review`).then(
            (started) => active && setVoucher(started),
            () => {},
          );
        }
      },
      (e: unknown) =>
        active && setError(e instanceof ApiError ? e.message : 'Could not load this voucher'),
    );
    return () => {
      active = false;
    };
  }, [id]);

  function fail(e: unknown, fallback: string) {
    setError(e instanceof ApiError ? e.message : fallback);
  }

  async function downloadPdf() {
    if (!voucher) return;
    setError(null);
    try {
      await fetchFile(
        `/vouchers/${voucher.id}/pdf`,
        'save',
        `${voucher.number ?? 'draft-voucher'}.pdf`,
      );
    } catch (e) {
      fail(e, 'Could not download the PDF');
    }
  }

  async function remove() {
    if (!voucher) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    try {
      await apiDelete(`/vouchers/${voucher.id}`);
      navigate('/expenses', { replace: true });
    } catch (e) {
      fail(e, 'Could not delete the draft');
      setBusy(false);
    }
  }

  async function cancel(e: FormEvent) {
    e.preventDefault();
    if (!voucher) return;
    setBusy(true);
    setReasonError(undefined);
    try {
      const v = await apiPost<VoucherDetail>(`/vouchers/${voucher.id}/cancel`, {
        version: voucher.version,
        reason,
      });
      setVoucher(v);
      setCancelling(false);
      setNotice('Voucher cancelled.');
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors.reason) setReasonError(err.fieldErrors.reason);
      else fail(err, 'Could not cancel the voucher');
    } finally {
      setBusy(false);
    }
  }

  if (!voucher) {
    return error ? (
      <section>
        <FormError message={error} />
        <Link to={back.to}>Back to {back.label.toLowerCase()}</Link>
      </section>
    ) : (
      <p className="page-loading">Loading…</p>
    );
  }

  const v = voucher;
  const showApproved = v.lines.some((l) => l.approvedPaise !== null);
  const lastStep = [...v.events].reverse().find((e) => ['returned', 'rejected'].includes(e.type));
  const done = (next: VoucherDetail, message: string) => {
    setVoucher(next);
    setNotice(message);
    window.scrollTo({ top: 0 });
  };

  return (
    <section>
      <Link to={back.to} className="back-link">
        ← {back.label}
      </Link>
      <div className="page-head">
        <div>
          <h1 className="with-pill">
            {v.number ?? 'Draft voucher'}{' '}
            <VoucherStatus status={v.approvalStatus} reviewStarted={!!v.accountsReviewStartedAt} />
          </h1>
          <p className="muted">
            {section !== 'expenses' ? `${v.employee.name} · ` : ''}
            {v.purpose ?? 'No purpose yet'} · {formatRupees(v.totalPaise)}
            {v.waitingOn && ` · Waiting on ${v.waitingOn}`}
          </p>
        </div>
        <div className="actions">
          <button className="btn btn-secondary" onClick={() => void downloadPdf()}>
            <Download size={16} aria-hidden /> Download PDF
          </button>
          {v.can.edit && (
            <Link to={`/expenses/${v.id}/edit`} className="btn btn-primary">
              <Pencil size={16} aria-hidden />{' '}
              {v.approvalStatus === 'returned' ? 'Edit and resubmit' : 'Edit and submit'}
            </Link>
          )}
          {v.can.cancel && !cancelling && (
            <button className="btn btn-danger" onClick={() => setCancelling(true)}>
              <XCircle size={16} aria-hidden /> Cancel voucher
            </button>
          )}
          {v.can.delete && (
            <button className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
              <Trash2 size={16} aria-hidden /> {confirmDelete ? 'Yes, delete it' : 'Delete draft'}
            </button>
          )}
        </div>
      </div>

      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <FormError message={error} />

      {v.approvalStatus === 'returned' && lastStep?.type === 'returned' && (
        <div className="card wide callout warn">
          <strong>{lastStep.actor?.name ?? 'An approver'} returned this voucher for changes</strong>
          <blockquote className="event-message returned">{lastStep.message}</blockquote>
          {v.can.edit && (
            <span className="muted small">
              Edit it and resubmit. It goes through approval again.
            </span>
          )}
        </div>
      )}
      {v.approvalStatus.endsWith('_rejected') && lastStep?.type === 'rejected' && (
        <div className="card wide callout bad">
          <strong>Rejected by {lastStep.actor?.name ?? 'an approver'}</strong>
          <blockquote className="event-message rejected">{lastStep.message}</blockquote>
        </div>
      )}
      {v.employee.id === user.id && (
        <FollowUp<VoucherDetail> path={`/vouchers/${v.id}`} version={v.version} onSent={done} />
      )}
      {v.can.answer && <AnswerPanel voucher={v} onChange={setVoucher} onDone={done} />}
      {v.can.approve && <ReviewPanel key={v.version} voucher={v} onDone={done} />}
      {v.paymentStatus !== 'not_due' && v.paymentStatus !== 'against_advance' && (
        <PaymentPanel key={`pay-${v.version}`} voucher={v} onDone={done} />
      )}

      {cancelling && (
        <form className="card wide" onSubmit={cancel} noValidate>
          <h2>Cancel this voucher?</h2>
          <p className="muted">
            It will be withdrawn from approval. You can still see it under Cancelled.
          </p>
          <Field label="Reason" error={reasonError}>
            <textarea
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </Field>
          <div className="actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setCancelling(false)}
            >
              Keep it
            </button>
            <button type="submit" className="btn btn-danger" disabled={busy}>
              Cancel voucher
            </button>
          </div>
        </form>
      )}

      <div className="detail-grid">
        <div className="card wide">
          <h2>Details</h2>
          <dl className="details">
            <dt>Employee</dt>
            <dd>
              {v.employee.name}
              {v.employee.employeeCode && ` (${v.employee.employeeCode})`}
            </dd>
            <dt>Department</dt>
            <dd>{v.department?.name ?? '—'}</dd>
            <dt>Reporting manager</dt>
            <dd>{v.manager?.name ?? '—'}</dd>
            <dt>Waiting on</dt>
            <dd>{v.waitingOn ?? 'Nobody'}</dd>
            {v.advance && (
              <>
                <dt>Advance</dt>
                <dd>
                  <Link to={`/advances/${v.advance.id}`}>{v.advance.number}</Link>
                  <div className="muted small">Settled from this advance, not paid separately.</div>
                </dd>
              </>
            )}
            <dt>Payment</dt>
            <dd>
              <PaymentStatusPill status={v.paymentStatus} />
            </dd>
            <dt>Total</dt>
            <dd>
              <strong>{formatRupees(v.totalPaise)}</strong>
              <div className="muted small">{rupeesInWords(v.totalPaise)}</div>
            </dd>
            {v.approvedTotalPaise !== null && (
              <>
                <dt>Approved</dt>
                <dd>
                  <strong>{formatRupees(v.approvedTotalPaise)}</strong>
                </dd>
              </>
            )}
          </dl>
        </div>
        <Timeline voucher={v} onChange={setVoucher} />
      </div>

      <div className="card wide table-card">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Date</th>
              <th>Category</th>
              <th>Description</th>
              <th>GST</th>
              <th>Proof</th>
              <th className="num">Amount</th>
              {showApproved && <th className="num">Approved</th>}
            </tr>
          </thead>
          <tbody>
            {v.lines.map((l, i) => (
              <tr key={l.id}>
                <td>{i + 1}</td>
                <td>{formatDay(l.expenseDate)}</td>
                <td>{l.category?.name ?? '—'}</td>
                <td>
                  {l.description ?? '—'}
                  {l.vendorName && <div className="muted small">{l.vendorName}</div>}
                </td>
                <td>
                  {l.isGst ? (
                    <>
                      {l.gstin}
                      <div className="muted small">
                        Inv {l.invoiceNumber} ·{' '}
                        {l.igstPaise
                          ? `IGST ${formatRupees(l.igstPaise)}`
                          : `CGST ${formatRupees(l.cgstPaise)} + SGST ${formatRupees(l.sgstPaise)}`}
                      </div>
                    </>
                  ) : (
                    <span className="muted">Non-GST</span>
                  )}
                </td>
                <td>
                  {l.attachments.map((a) => (
                    <div key={a.id}>
                      <button
                        className="btn btn-link file-link"
                        onClick={() =>
                          void fetchFile(`/vouchers/${v.id}/attachments/${a.id}`, 'open').catch(
                            (e: unknown) => fail(e, 'Could not open the file'),
                          )
                        }
                      >
                        {a.contentType === 'application/pdf' ? (
                          <FileText size={14} aria-hidden />
                        ) : (
                          <Paperclip size={14} aria-hidden />
                        )}
                        {a.filename}
                      </button>
                      <span className="muted small"> {formatBytes(a.sizeBytes)}</span>
                    </div>
                  ))}
                  {l.attachments.length === 0 &&
                    (l.missingProofReason ? (
                      <span className="muted small">No bill: {l.missingProofReason}</span>
                    ) : (
                      '—'
                    ))}
                </td>
                <td className="num">{formatRupees(l.amountPaise)}</td>
                {showApproved && (
                  <td className="num">
                    {l.approvedPaise === null ? '—' : formatRupees(l.approvedPaise)}
                    {l.reviewNote && <div className="muted small wrap">{l.reviewNote}</div>}
                  </td>
                )}
              </tr>
            ))}
            {v.lines.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  No expenses on this voucher yet.
                </td>
              </tr>
            )}
          </tbody>
          {v.lines.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={6}>Total</td>
                <td className="num">{formatRupees(v.totalPaise)}</td>
                {showApproved && (
                  <td className="num">
                    {v.approvedTotalPaise === null ? '—' : formatRupees(v.approvedTotalPaise)}
                  </td>
                )}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}
