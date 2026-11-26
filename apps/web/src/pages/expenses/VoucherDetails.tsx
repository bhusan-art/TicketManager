import {
  PAYMENT_STATUS_LABELS,
  formatRupees,
  rupeesInWords,
  type VoucherDetail,
} from '@ticketmanager/shared';
import { Download, FileText, Paperclip, Pencil, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { Field, FormError } from '../../components/forms';
import { VoucherStatus, formatBytes, formatDay, formatWhen } from '../../components/VoucherStatus';
import { ApiError, apiDelete, apiGet, apiPost, fetchFile } from '../../lib/api';

export function VoucherDetails() {
  const { id } = useParams();
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
      (v) => active && setVoucher(v),
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
        <Link to="/expenses">Back to my expenses</Link>
      </section>
    ) : (
      <p className="page-loading">Loading…</p>
    );
  }

  const v = voucher;
  const history = [
    { label: 'Created', at: v.createdAt },
    v.submittedAt && {
      label: `Submitted${v.manager ? ` to ${v.manager.name}` : ''}`,
      at: v.submittedAt,
    },
    v.cancelledAt && { label: `Cancelled: ${v.cancelReason ?? ''}`, at: v.cancelledAt },
  ].filter(Boolean) as { label: string; at: string }[];

  return (
    <section>
      <Link to="/expenses" className="back-link">
        ← My expenses
      </Link>
      <div className="page-head">
        <div>
          <h1 className="with-pill">
            {v.number ?? 'Draft voucher'} <VoucherStatus status={v.approvalStatus} />
          </h1>
          <p className="muted">
            {v.purpose ?? 'No purpose yet'} · {formatRupees(v.totalPaise)}
          </p>
        </div>
        <div className="actions">
          <button className="btn btn-secondary" onClick={() => void downloadPdf()}>
            <Download size={16} aria-hidden /> Download PDF
          </button>
          {v.can.edit && (
            <Link to={`/expenses/${v.id}/edit`} className="btn btn-primary">
              <Pencil size={16} aria-hidden /> Edit and submit
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
            <dt>Sent to</dt>
            <dd>
              {v.approvalStatus === 'draft'
                ? 'Not submitted yet'
                : (v.manager?.name ??
                  (v.approvalStatus === 'pending_director' ? 'Director' : 'Accounts'))}
            </dd>
            <dt>Payment</dt>
            <dd>{PAYMENT_STATUS_LABELS[v.paymentStatus]}</dd>
            <dt>Total</dt>
            <dd>
              <strong>{formatRupees(v.totalPaise)}</strong>
              <div className="muted small">{rupeesInWords(v.totalPaise)}</div>
            </dd>
          </dl>
        </div>
        <div className="card wide">
          <h2>History</h2>
          <ol className="timeline">
            {history.map((h) => (
              <li key={h.label}>
                <strong>{h.label}</strong>
                <span className="muted small">{formatWhen(h.at)}</span>
              </li>
            ))}
          </ol>
        </div>
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
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}
