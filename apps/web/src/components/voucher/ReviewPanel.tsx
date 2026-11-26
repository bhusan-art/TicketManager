import { formatRupees, paiseToInput, parseRupees, type VoucherDetail } from '@ticketmanager/shared';
import { Check, CornerUpLeft, HelpCircle, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../../lib/api';
import { Field, FormError } from '../forms';

type Step = 'query' | 'return' | 'reject';

const STEP_TEXT: Record<Step, { title: string; label: string; button: string; hint: string }> = {
  query: {
    title: 'Ask the employee a question',
    label: 'Your question',
    button: 'Send query',
    hint: 'The voucher comes back to you once they answer.',
  },
  return: {
    title: 'Return for changes',
    label: 'What needs to change',
    button: 'Return voucher',
    hint: 'The employee edits it and resubmits. It then goes through approval again.',
  },
  reject: {
    title: 'Reject this voucher',
    label: 'Reason',
    button: 'Reject voucher',
    hint: 'This is final. The employee can see your reason.',
  },
};

/**
 * What an approver sees: each line's claimed amount with a box for what they approve,
 * and the four decisions.
 */
export function ReviewPanel({
  voucher,
  onDone,
}: {
  voucher: VoucherDetail;
  onDone: (v: VoucherDetail, notice: string) => void;
}) {
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      voucher.lines.map((l) => [l.id, paiseToInput(l.approvedPaise ?? l.amountPaise)]),
    ),
  );
  const [notes, setNotes] = useState<Record<string, string>>(() =>
    Object.fromEntries(voucher.lines.map((l) => [l.id, l.reviewNote ?? ''])),
  );
  const [note, setNote] = useState('');
  const [step, setStep] = useState<Step | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const parsed = voucher.lines.map((l) => parseRupees(amounts[l.id] ?? '') ?? NaN);
  const total = parsed.reduce((s, p) => s + (Number.isNaN(p) ? 0 : p), 0);
  const invalid = parsed.some((p, i) => Number.isNaN(p) || p > voucher.lines[i]!.amountPaise);
  const final = voucher.approvalStatus !== 'pending_manager';

  async function send(path: string, body: object, notice: string) {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const v = await api<VoucherDetail>('POST', `/vouchers/${voucher.id}/${path}`, {
        version: voucher.version,
        ...body,
      });
      onDone(v, notice);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setError(err.message);
      } else setError('Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function approve() {
    void send(
      'approve',
      {
        note,
        lines: voucher.lines.map((l, i) => ({
          id: l.id,
          approvedPaise: parsed[i],
          note: notes[l.id] ?? '',
        })),
      },
      final
        ? `Approved ${formatRupees(total)}. It now waits for payment.`
        : 'Approved and sent to Accounts.',
    );
  }

  function decide(e: FormEvent) {
    e.preventDefault();
    if (!step) return;
    const done = {
      query: 'Query sent to the employee.',
      return: 'Returned to the employee for changes.',
      reject: 'Voucher rejected.',
    }[step];
    void send(step, { message }, done);
  }

  return (
    <div className="card wide review-panel">
      <h2>Your review</h2>
      <p className="muted small">
        Approve the full amount, or lower a line and say why.{' '}
        {final ? 'Your approval is final.' : 'Accounts checks it next.'}
      </p>
      <FormError message={error} />
      <table className="table compact">
        <thead>
          <tr>
            <th>#</th>
            <th>Expense</th>
            <th className="num">Claimed</th>
            <th>Approve (₹)</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {voucher.lines.map((l, i) => {
            const reduced = !Number.isNaN(parsed[i]!) && parsed[i]! < l.amountPaise;
            return (
              <tr key={l.id}>
                <td>{i + 1}</td>
                <td>
                  {l.category?.name ?? '—'}
                  <div className="muted small">{l.description}</div>
                </td>
                <td className="num">{formatRupees(l.amountPaise)}</td>
                <td>
                  <input
                    className="amount-input"
                    inputMode="decimal"
                    aria-label={`Approved amount for line ${i + 1}`}
                    aria-invalid={Number.isNaN(parsed[i]!) || parsed[i]! > l.amountPaise}
                    value={amounts[l.id]}
                    onChange={(e) => setAmounts({ ...amounts, [l.id]: e.target.value })}
                  />
                  {fieldErrors[`lines.${i}.approvedPaise`] && (
                    <div className="field-error">{fieldErrors[`lines.${i}.approvedPaise`]}</div>
                  )}
                </td>
                <td>
                  {(reduced || notes[l.id]) && (
                    <input
                      aria-label={`Why line ${i + 1} is reduced`}
                      placeholder="Why less?"
                      maxLength={500}
                      value={notes[l.id]}
                      onChange={(e) => setNotes({ ...notes, [l.id]: e.target.value })}
                    />
                  )}
                  {fieldErrors[`lines.${i}.note`] && (
                    <div className="field-error">{fieldErrors[`lines.${i}.note`]}</div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>Approving</td>
            <td className="num">{formatRupees(voucher.totalPaise)}</td>
            <td className="num">{formatRupees(total)}</td>
            <td />
          </tr>
        </tfoot>
      </table>

      {!step && (
        <>
          <Field label="Note to the employee" hint="Optional">
            <input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="review-actions">
            <button className="btn btn-secondary" disabled={busy} onClick={() => setStep('query')}>
              <HelpCircle size={16} aria-hidden /> Raise query
            </button>
            <button className="btn btn-secondary" disabled={busy} onClick={() => setStep('return')}>
              <CornerUpLeft size={16} aria-hidden /> Return
            </button>
            <button className="btn btn-danger" disabled={busy} onClick={() => setStep('reject')}>
              <X size={16} aria-hidden /> Reject
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || invalid || total === 0}
              onClick={approve}
            >
              <Check size={16} aria-hidden />
              {total < voucher.totalPaise ? `Approve ${formatRupees(total)}` : 'Approve'}
            </button>
          </div>
        </>
      )}

      {step && (
        <form onSubmit={decide} noValidate className="decision-form">
          <h3>{STEP_TEXT[step].title}</h3>
          <Field
            label={STEP_TEXT[step].label}
            error={fieldErrors.message}
            hint={STEP_TEXT[step].hint}
          >
            <textarea
              rows={3}
              maxLength={1000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              autoFocus
            />
          </Field>
          <div className="actions">
            <button type="button" className="btn btn-secondary" onClick={() => setStep(null)}>
              Back
            </button>
            <button
              type="submit"
              className={`btn ${step === 'reject' ? 'btn-danger' : 'btn-primary'}`}
              disabled={busy || message.trim().length < 3}
            >
              {STEP_TEXT[step].button}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
