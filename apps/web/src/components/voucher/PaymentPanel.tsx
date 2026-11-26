import {
  PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  REFERENCE_LABELS,
  formatRupees,
  paiseToInput,
  parseRupees,
  todayIso,
  type Payment,
  type PaymentMode,
  type VoucherDetail,
} from '@ticketmanager/shared';
import { Banknote, Undo2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useUser } from '../../auth/AuthContext';
import { ApiError, api, idempotencyKey } from '../../lib/api';
import { Field, FormError } from '../forms';
import { formatDay, formatWhen } from '../VoucherStatus';

/**
 * Money on an approved voucher: approved, paid and outstanding, every payment made, and for
 * Accounts a form to record the next instalment and a way to reverse a mistaken payment.
 */
export function PaymentPanel({
  voucher,
  onDone,
}: {
  voucher: VoucherDetail;
  onDone: (v: VoucherDetail, notice: string) => void;
}) {
  const user = useUser();
  const v = voucher;
  const canReverse = user.activeRole === 'accounts' && v.employee.id !== user.id;
  const [amount, setAmount] = useState(paiseToInput(v.outstandingPaise));
  const [paidOn, setPaidOn] = useState(todayIso());
  const [mode, setMode] = useState<PaymentMode>('bank_transfer');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [reversing, setReversing] = useState<Payment | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const amountPaise = parseRupees(amount);
  const refLabel = REFERENCE_LABELS[mode];
  const tooMuch = amountPaise !== null && amountPaise > v.outstandingPaise;

  async function send(path: string, body: object, notice: string, headers?: object) {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const next = await api<VoucherDetail>(
        'POST',
        `/vouchers/${v.id}/${path}`,
        { version: v.version, ...body },
        headers as Record<string, string> | undefined,
      );
      onDone(next, notice);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setError(err.message);
      } else setError('Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function record(e: FormEvent) {
    e.preventDefault();
    if (amountPaise === null) {
      setFieldErrors({ amountPaise: 'Enter an amount like 1250 or 1250.50' });
      return;
    }
    const full = amountPaise === v.outstandingPaise;
    void send(
      'payments',
      { amountPaise, paidOn, mode, reference: refLabel ? reference : null, note },
      full
        ? `Paid ${formatRupees(amountPaise)}. The voucher is paid in full.`
        : `Recorded ${formatRupees(amountPaise)}. ${formatRupees(v.outstandingPaise - amountPaise)} is still outstanding.`,
      // A second click is refused anyway: it carries a version that is now stale.
      { 'Idempotency-Key': idempotencyKey() },
    );
  }

  function reverse(e: FormEvent) {
    e.preventDefault();
    if (!reversing) return;
    void send(
      `payments/${reversing.id}/reverse`,
      { reason },
      `Reversed ${reversing.number}. ${formatRupees(reversing.amountPaise)} is outstanding again.`,
    );
  }

  return (
    <div className="card wide payment-panel">
      <h2>Payment</h2>
      <dl className="money-row">
        <div>
          <dt>Approved</dt>
          <dd>{formatRupees(v.approvedTotalPaise ?? 0)}</dd>
        </div>
        <div>
          <dt>Paid</dt>
          <dd>{formatRupees(v.paidPaise)}</dd>
        </div>
        <div>
          <dt>Outstanding</dt>
          <dd className={v.outstandingPaise > 0 ? 'owed' : undefined}>
            {formatRupees(v.outstandingPaise)}
          </dd>
        </div>
      </dl>
      <FormError message={error} />

      {v.payments.length > 0 && (
        <table className="table compact">
          <thead>
            <tr>
              <th>Payment</th>
              <th>Paid on</th>
              <th>Mode and reference</th>
              <th className="num">Amount</th>
              {canReverse && <th />}
            </tr>
          </thead>
          <tbody>
            {v.payments.map((p) => (
              <tr key={p.id} className={p.reversedAt ? 'reversed' : undefined}>
                <td className="nowrap">
                  {p.number}
                  <div className="muted small">
                    {p.recordedBy ? `by ${p.recordedBy.name}` : ''}
                    {p.note && ` · ${p.note}`}
                  </div>
                </td>
                <td className="nowrap">{formatDay(p.paidOn)}</td>
                <td>
                  {PAYMENT_MODE_LABELS[p.mode]}
                  {p.reference && <div className="muted small mono">{p.reference}</div>}
                  {p.reversedAt && (
                    <div className="field-error">
                      Reversed {formatWhen(p.reversedAt)}
                      {p.reversedBy && ` by ${p.reversedBy.name}`}: {p.reversalReason}
                    </div>
                  )}
                </td>
                <td className="num">{formatRupees(p.amountPaise)}</td>
                {canReverse && (
                  <td>
                    {!p.reversedAt && (
                      <button
                        className="btn btn-link"
                        disabled={busy}
                        onClick={() => {
                          setReversing(p);
                          setReason('');
                        }}
                      >
                        <Undo2 size={14} aria-hidden /> Reverse
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {v.payments.length === 0 && !v.can.pay && (
        <p className="muted small">No payment has been made yet.</p>
      )}

      {reversing && (
        <form className="decision-form" onSubmit={reverse} noValidate>
          <h3>
            Reverse {reversing.number} ({formatRupees(reversing.amountPaise)})
          </h3>
          <Field
            label="Why is it being reversed?"
            error={fieldErrors.reason}
            hint="The payment stays on record, marked reversed, and stops counting as paid."
          >
            <textarea
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </Field>
          <div className="actions">
            <button type="button" className="btn btn-secondary" onClick={() => setReversing(null)}>
              Back
            </button>
            <button
              type="submit"
              className="btn btn-danger"
              disabled={busy || reason.trim().length < 3}
            >
              Reverse payment
            </button>
          </div>
        </form>
      )}

      {v.can.pay && !reversing && (
        <form className="payment-form" onSubmit={record} noValidate>
          <h3>Record a payment</h3>
          <div className="form-grid">
            <Field
              label="Amount (₹)"
              error={fieldErrors.amountPaise ?? (tooMuch ? 'More than is outstanding' : undefined)}
              hint={`Up to ${formatRupees(v.outstandingPaise)}. Pay less to record an instalment.`}
            >
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Paid on" error={fieldErrors.paidOn}>
              <input
                type="date"
                value={paidOn}
                max={todayIso()}
                onChange={(e) => setPaidOn(e.target.value)}
              />
            </Field>
            <Field label="Mode" error={fieldErrors.mode}>
              <select value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)}>
                {PAYMENT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </Field>
            {refLabel && (
              <Field label={refLabel} error={fieldErrors.reference}>
                <input
                  value={reference}
                  maxLength={40}
                  autoComplete="off"
                  onChange={(e) => setReference(e.target.value.toUpperCase())}
                />
              </Field>
            )}
            <Field label="Note" hint="Optional">
              <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          <div className="actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || amountPaise === null || amountPaise <= 0 || tooMuch}
            >
              <Banknote size={16} aria-hidden /> Record payment
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
