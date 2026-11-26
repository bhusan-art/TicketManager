import {
  ADVANCE_STATUS_LABELS,
  ADVANCE_TRANSACTION_LABELS,
  PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  REFERENCE_LABELS,
  ROLE_LABELS,
  formatRupees,
  paiseToInput,
  parseRupees,
  todayIso,
  type AdvanceDetail,
  type AdvanceEvent,
  type AdvanceTransaction,
  type PaymentMode,
} from '@ticketmanager/shared';
import {
  Banknote,
  Check,
  CornerUpLeft,
  Lock,
  Pencil,
  Trash2,
  Undo2,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useUser } from '../../auth/AuthContext';
import { FollowUp } from '../../components/FollowUp';
import { WhatsAppSend } from '../../components/WhatsAppSend';
import { Field, FormError } from '../../components/forms';
import {
  AdvanceStatusPill,
  VoucherStatus,
  formatDay,
  formatWhen,
} from '../../components/VoucherStatus';
import { ApiError, api, apiDelete, apiGet, idempotencyKey } from '../../lib/api';

type Send = (path: string, body: object, notice: string, idempotent?: boolean) => Promise<boolean>;

export function AdvanceDetails() {
  const user = useUser();
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [advance, setAdvance] = useState<AdvanceDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(
    (location.state as { notice?: string } | null)?.notice ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    apiGet<AdvanceDetail>(`/advances/${id}`).then(
      (a) => active && setAdvance(a),
      (e: unknown) =>
        active && setError(e instanceof ApiError ? e.message : 'Could not load this advance'),
    );
    return () => {
      active = false;
    };
  }, [id]);

  const send: Send = async (path, body, message, idempotent = false) => {
    if (!advance) return false;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const next = await api<AdvanceDetail>(
        'POST',
        `/advances/${advance.id}/${path}`,
        { version: advance.version, ...body },
        idempotent ? { 'Idempotency-Key': idempotencyKey() } : undefined,
      );
      setAdvance(next);
      setNotice(message);
      window.scrollTo({ top: 0 });
      return true;
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setError(err.message);
      } else setError('Could not reach the server. Try again.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!advance) {
    return error ? (
      <section>
        <FormError message={error} />
        <Link to="/advances">Back to advances</Link>
      </section>
    ) : (
      <p className="page-loading">Loading…</p>
    );
  }

  const a = advance;
  const money = a.status === 'open' || a.status === 'closed';
  const lastStep = [...a.events].reverse().find((e) => ['returned', 'rejected'].includes(e.type));

  async function remove() {
    setBusy(true);
    try {
      await apiDelete(`/advances/${a.id}`);
      navigate('/advances', { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not delete');
      setBusy(false);
    }
  }

  return (
    <section>
      <Link to="/advances" className="back-link">
        ← Advances
      </Link>
      <div className="page-head">
        <div>
          <h1 className="with-pill">
            {a.number ?? 'Draft advance'}{' '}
            <AdvanceStatusPill status={a.status} overdue={a.overdue} />
          </h1>
          <p className="muted">
            {a.employee.name} · {a.purpose} · {formatRupees(a.approvedPaise ?? a.requestedPaise)}
            {a.waitingOn && ` · Waiting on ${a.waitingOn}`}
          </p>
        </div>
        <div className="actions">
          {a.can.edit && (
            <Link to={`/advances/${a.id}/edit`} className="btn btn-primary">
              <Pencil size={16} aria-hidden />{' '}
              {a.status === 'returned' ? 'Edit and resubmit' : 'Edit and submit'}
            </Link>
          )}
          {a.can.delete && (
            <button className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
              <Trash2 size={16} aria-hidden /> Delete draft
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

      {a.overdue && (
        <div className="card wide callout bad">
          <strong>Settlement overdue since {formatDay(a.settleBy)}</strong>
          <span className="muted small">
            Tag the remaining claims to this advance and return any unused money.
          </span>
        </div>
      )}
      {lastStep && (a.status === 'returned' || a.status.endsWith('_rejected')) && (
        <div className={`card wide callout ${a.status === 'returned' ? 'warn' : 'bad'}`}>
          <strong>
            {lastStep.actor?.name ?? 'An approver'}{' '}
            {a.status === 'returned'
              ? 'returned this request for changes'
              : 'rejected this request'}
          </strong>
          <blockquote className={`event-message ${lastStep.type}`}>{lastStep.message}</blockquote>
        </div>
      )}

      {a.can.approve && (
        <ReviewAdvance key={a.version} advance={a} send={send} busy={busy} errors={fieldErrors} />
      )}
      {a.can.disburse && (
        <MoneyForm
          key={`d-${a.version}`}
          title="Pay out the advance"
          button="Record payout"
          max={a.approvedPaise ?? 0}
          maxHint={`Up to the approved ${formatRupees(a.approvedPaise ?? 0)}`}
          busy={busy}
          errors={fieldErrors}
          onSubmit={(body) =>
            send(
              'disburse',
              body,
              `Paid out ${formatRupees(body.amountPaise)}. The advance is now open for claims.`,
              true,
            )
          }
        />
      )}

      {money && <SettlementPanel advance={a} send={send} busy={busy} errors={fieldErrors} />}

      {a.employee.id === user.id && (
        <FollowUp<AdvanceDetail>
          path={`/advances/${a.id}`}
          version={a.version}
          onSent={(next, message) => {
            setAdvance(next);
            setNotice(message);
            window.scrollTo({ top: 0 });
          }}
        />
      )}
      {a.status !== 'draft' && <WhatsAppSend path={`/advances/${a.id}`} version={a.version} />}

      {a.can.cancel && <CancelAdvance advance={a} send={send} busy={busy} errors={fieldErrors} />}

      <div className="detail-grid">
        <div className="card wide">
          <h2>Details</h2>
          <dl className="details">
            <dt>Employee</dt>
            <dd>
              {a.employee.name}
              {a.employee.employeeCode && ` (${a.employee.employeeCode})`}
            </dd>
            <dt>Department</dt>
            <dd>{a.department?.name ?? '—'}</dd>
            <dt>Requested</dt>
            <dd>{formatRupees(a.requestedPaise)}</dd>
            {a.approvedPaise !== null && (
              <>
                <dt>Approved</dt>
                <dd>
                  <strong>{formatRupees(a.approvedPaise)}</strong>
                </dd>
              </>
            )}
            <dt>Expected expense date</dt>
            <dd>{formatDay(a.expectedDate)}</dd>
            {a.settleBy && (
              <>
                <dt>Settle by</dt>
                <dd>{formatDay(a.settleBy)}</dd>
              </>
            )}
            <dt>Status</dt>
            <dd>{ADVANCE_STATUS_LABELS[a.status]}</dd>
            {a.notes && (
              <>
                <dt>Details</dt>
                <dd className="wrap">{a.notes}</dd>
              </>
            )}
            {a.cancelReason && (
              <>
                <dt>Cancelled because</dt>
                <dd>{a.cancelReason}</dd>
              </>
            )}
          </dl>
        </div>
        <AdvanceTimeline events={a.events} />
      </div>
    </section>
  );
}

function ReviewAdvance({
  advance: a,
  send,
  busy,
  errors,
}: {
  advance: AdvanceDetail;
  send: Send;
  busy: boolean;
  errors: Record<string, string>;
}) {
  const [amount, setAmount] = useState(paiseToInput(a.approvedPaise ?? a.requestedPaise));
  const [note, setNote] = useState('');
  const [step, setStep] = useState<'return' | 'reject' | null>(null);
  const [message, setMessage] = useState('');
  const approvedPaise = parseRupees(amount);
  const invalid = approvedPaise === null || approvedPaise <= 0 || approvedPaise > a.requestedPaise;
  const final = a.status !== 'pending_manager';

  return (
    <div className="card wide review-panel">
      <h2>Your review</h2>
      <p className="muted small">
        {a.employee.name} asked for {formatRupees(a.requestedPaise)}. You can approve less.{' '}
        {final ? 'Your approval is final; Accounts then pays it out.' : 'Accounts checks it next.'}
      </p>
      {!step && (
        <>
          <div className="form-grid">
            <Field
              label="Approve (₹)"
              error={
                errors.approvedPaise ??
                (approvedPaise !== null && approvedPaise > a.requestedPaise
                  ? 'More than was requested'
                  : undefined)
              }
            >
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Note to the employee" hint="Optional">
              <input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          <div className="review-actions">
            <button className="btn btn-secondary" disabled={busy} onClick={() => setStep('return')}>
              <CornerUpLeft size={16} aria-hidden /> Return
            </button>
            <button className="btn btn-danger" disabled={busy} onClick={() => setStep('reject')}>
              <X size={16} aria-hidden /> Reject
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || invalid}
              onClick={() =>
                void send(
                  'approve',
                  { approvedPaise, note },
                  final
                    ? `Approved ${formatRupees(approvedPaise!)}. Accounts can now pay it out.`
                    : 'Approved and sent to Accounts.',
                )
              }
            >
              <Check size={16} aria-hidden /> Approve {formatRupees(approvedPaise ?? 0)}
            </button>
          </div>
        </>
      )}
      {step && (
        <form
          className="decision-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void send(
              step,
              { message },
              step === 'return' ? 'Returned to the employee for changes.' : 'Advance rejected.',
            );
          }}
        >
          <h3>{step === 'return' ? 'Return for changes' : 'Reject this advance'}</h3>
          <Field
            label={step === 'return' ? 'What needs to change' : 'Reason'}
            error={errors.message}
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
              {step === 'return' ? 'Return advance' : 'Reject advance'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

interface MoneyBody {
  amountPaise: number;
  paidOn: string;
  mode: PaymentMode;
  reference: string | null;
  note: string;
}

/** Amount, date, mode and reference: a payout, a return or a shortfall payment. */
function MoneyForm({
  title,
  button,
  max,
  maxHint,
  busy,
  errors,
  onSubmit,
  embedded = false,
}: {
  title: string;
  button: string;
  max: number;
  maxHint: string;
  busy: boolean;
  errors: Record<string, string>;
  onSubmit: (body: MoneyBody) => Promise<boolean>;
  embedded?: boolean;
}) {
  const [amount, setAmount] = useState(paiseToInput(max));
  const [paidOn, setPaidOn] = useState(todayIso());
  const [mode, setMode] = useState<PaymentMode>('bank_transfer');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const amountPaise = parseRupees(amount);
  const refLabel = REFERENCE_LABELS[mode];
  const tooMuch = amountPaise !== null && amountPaise > max;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (amountPaise === null) return;
    void onSubmit({ amountPaise, paidOn, mode, reference: refLabel ? reference : null, note });
  }

  const form = (
    <form className={embedded ? 'payment-form' : undefined} onSubmit={submit} noValidate>
      <h3>{title}</h3>
      <div className="form-grid">
        <Field
          label="Amount (₹)"
          error={errors.amountPaise ?? errors.kind ?? (tooMuch ? 'Too much' : undefined)}
          hint={maxHint}
        >
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Date" error={errors.paidOn}>
          <input
            type="date"
            value={paidOn}
            max={todayIso()}
            onChange={(e) => setPaidOn(e.target.value)}
          />
        </Field>
        <Field label="Mode">
          <select value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)}>
            {PAYMENT_MODES.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
        {refLabel && (
          <Field label={refLabel} error={errors.reference}>
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
          <Banknote size={16} aria-hidden /> {button}
        </button>
      </div>
    </form>
  );
  return embedded ? form : <div className="card wide payment-panel">{form}</div>;
}

function SettlementPanel({
  advance: a,
  send,
  busy,
  errors,
}: {
  advance: AdvanceDetail;
  send: Send;
  busy: boolean;
  errors: Record<string, string>;
}) {
  const s = a.settlement;
  const user = useUser();
  const claimBase =
    a.employee.id === user.id
      ? '/expenses'
      : user.activeRole === 'accounts'
        ? '/verification'
        : '/approvals';
  const [reversing, setReversing] = useState<AdvanceTransaction | null>(null);
  const [reason, setReason] = useState('');
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState('');

  return (
    <div className="card wide payment-panel">
      <h2>Settlement</h2>
      <dl className="money-row">
        <div>
          <dt>Paid out</dt>
          <dd>{formatRupees(s.disbursedPaise)}</dd>
        </div>
        <div>
          <dt>Claims approved</dt>
          <dd>{formatRupees(s.approvedExpensesPaise)}</dd>
        </div>
        {s.returnedPaise > 0 && (
          <div>
            <dt>Returned</dt>
            <dd>{formatRupees(s.returnedPaise)}</dd>
          </div>
        )}
        {s.topUpPaise > 0 && (
          <div>
            <dt>Shortfall paid</dt>
            <dd>{formatRupees(s.topUpPaise)}</dd>
          </div>
        )}
        <div>
          <dt>{s.payablePaise > 0 ? 'Owed to employee' : 'Due back'}</dt>
          <dd className={s.balancePaise !== 0 ? 'owed' : undefined}>
            {formatRupees(Math.abs(s.balancePaise))}
          </dd>
        </div>
      </dl>
      {s.inReviewCount > 0 && (
        <p className="muted small">
          {s.inReviewCount} more claim{s.inReviewCount === 1 ? '' : 's'} (
          {formatRupees(s.inReviewPaise)}) still in review. They count once approved.
        </p>
      )}
      {a.status === 'closed' && (
        <p className="notice">Settled and closed {formatWhen(a.closedAt)}.</p>
      )}

      <h3>Claims tagged to this advance</h3>
      {a.vouchers.length === 0 ? (
        <p className="muted small">
          No claims yet. When creating an expense voucher, choose this advance under “Settle against
          an advance”.
        </p>
      ) : (
        <table className="table compact">
          <thead>
            <tr>
              <th>Voucher</th>
              <th>Purpose</th>
              <th>Status</th>
              <th className="num">Claimed</th>
              <th className="num">Approved</th>
            </tr>
          </thead>
          <tbody>
            {a.vouchers.map((v) => (
              <tr key={v.id}>
                <td>{v.number ? <Link to={`${claimBase}/${v.id}`}>{v.number}</Link> : 'Draft'}</td>
                <td>{v.purpose}</td>
                <td>
                  <VoucherStatus status={v.approvalStatus} />
                </td>
                <td className="num">{formatRupees(v.totalPaise)}</td>
                <td className="num">{v.counted ? formatRupees(v.approvedTotalPaise ?? 0) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Money</h3>
      <table className="table compact">
        <thead>
          <tr>
            <th>Entry</th>
            <th>Date</th>
            <th>Mode and reference</th>
            <th className="num">Amount</th>
            {a.can.settle && <th />}
          </tr>
        </thead>
        <tbody>
          {a.transactions.map((t) => (
            <tr key={t.id} className={t.reversedAt ? 'reversed' : undefined}>
              <td className="nowrap">
                {ADVANCE_TRANSACTION_LABELS[t.kind]}
                <div className="muted small">{t.recordedBy ? `by ${t.recordedBy.name}` : ''}</div>
              </td>
              <td className="nowrap">{formatDay(t.paidOn)}</td>
              <td>
                {PAYMENT_MODE_LABELS[t.mode]}
                {t.reference && <div className="muted small mono">{t.reference}</div>}
                {t.reversedAt && (
                  <div className="field-error">
                    Reversed {formatWhen(t.reversedAt)}
                    {t.reversedBy && ` by ${t.reversedBy.name}`}: {t.reversalReason}
                  </div>
                )}
              </td>
              <td className="num">{formatRupees(t.amountPaise)}</td>
              {a.can.settle && (
                <td>
                  {!t.reversedAt && (
                    <button
                      className="btn btn-link"
                      disabled={busy}
                      onClick={() => {
                        setReversing(t);
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

      {reversing && (
        <form
          className="decision-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void send(
              `transactions/${reversing.id}/reverse`,
              { reason },
              `Reversed ${ADVANCE_TRANSACTION_LABELS[reversing.kind].toLowerCase()} of ${formatRupees(reversing.amountPaise)}.`,
            ).then((ok) => ok && setReversing(null));
          }}
        >
          <h3>
            Reverse {ADVANCE_TRANSACTION_LABELS[reversing.kind].toLowerCase()} (
            {formatRupees(reversing.amountPaise)})
          </h3>
          <Field label="Why is it being reversed?" error={errors.reason}>
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
              Reverse
            </button>
          </div>
        </form>
      )}

      {a.can.settle && !reversing && s.balancePaise !== 0 && (
        <MoneyForm
          key={`${a.version}`}
          embedded
          title={
            s.dueBackPaise > 0
              ? 'Record money returned by the employee'
              : 'Pay the shortfall to the employee'
          }
          button={s.dueBackPaise > 0 ? 'Record return' : 'Record payment'}
          max={s.dueBackPaise || s.payablePaise}
          maxHint={
            s.dueBackPaise > 0
              ? `${formatRupees(s.dueBackPaise)} is due back`
              : `${formatRupees(s.payablePaise)} is owed to the employee`
          }
          busy={busy}
          errors={errors}
          onSubmit={(body) =>
            send(
              'transactions',
              { ...body, kind: s.dueBackPaise > 0 ? 'return' : 'top_up' },
              s.dueBackPaise > 0
                ? `Recorded ${formatRupees(body.amountPaise)} returned.`
                : `Recorded ${formatRupees(body.amountPaise)} paid to the employee.`,
              true,
            )
          }
        />
      )}

      {a.status === 'open' && a.can.settle && (
        <div className="payment-form">
          {!closing ? (
            <div className="actions">
              {!a.can.close && (
                <span className="muted small">
                  {s.inReviewCount > 0
                    ? 'Close once every tagged claim is decided.'
                    : 'Close once the balance is zero.'}
                </span>
              )}
              <button
                className="btn btn-primary"
                disabled={busy || !a.can.close}
                onClick={() => setClosing(true)}
              >
                <Lock size={16} aria-hidden /> Close settlement
              </button>
            </div>
          ) : (
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void send('close', { note }, 'Settlement closed.');
              }}
            >
              <Field label="Closing note" hint="Optional">
                <input
                  value={note}
                  maxLength={1000}
                  onChange={(e) => setNote(e.target.value)}
                  autoFocus
                />
              </Field>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setClosing(false)}
                >
                  Back
                </button>
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  Close settlement
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

function CancelAdvance({
  advance,
  send,
  busy,
  errors,
}: {
  advance: AdvanceDetail;
  send: Send;
  busy: boolean;
  errors: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <div className="actions page-actions">
        <button className="btn btn-danger" onClick={() => setOpen(true)}>
          <XCircle size={16} aria-hidden /> Cancel request
        </button>
      </div>
    );
  }
  return (
    <form
      className="card wide"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void send('cancel', { reason }, `Advance ${advance.number ?? ''} cancelled.`);
      }}
    >
      <h2>Cancel this advance request?</h2>
      <Field label="Reason" error={errors.reason}>
        <textarea
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
        />
      </Field>
      <div className="actions">
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
          Keep it
        </button>
        <button
          type="submit"
          className="btn btn-danger"
          disabled={busy || reason.trim().length < 3}
        >
          Cancel request
        </button>
      </div>
    </form>
  );
}

function describe(e: AdvanceEvent): string {
  const amount = (key: string) => formatRupees(Number(e.meta?.[key] ?? 0));
  switch (e.type) {
    case 'created':
      return 'Created the request';
    case 'submitted':
      return `Asked for ${amount('requestedPaise')}`;
    case 'resubmitted':
      return 'Resubmitted after changes';
    case 'approved':
      return e.toStatus === 'pending_accounts'
        ? `Approved ${amount('approvedPaise')} and sent it to Accounts`
        : `Approved ${amount('approvedPaise')}`;
    case 'returned':
      return 'Returned it for changes';
    case 'rejected':
      return 'Rejected it';
    case 'cancelled':
      return 'Cancelled it';
    case 'disbursed':
      return `Paid out ${amount('amountPaise')}`;
    case 'return_recorded':
      return `Recorded ${amount('amountPaise')} returned`;
    case 'top_up_recorded':
      return `Paid the shortfall of ${amount('amountPaise')}`;
    case 'transaction_reversed':
      return `Reversed ${String(e.meta?.label ?? 'an entry').toLowerCase()} of ${amount('amountPaise')}`;
    case 'closed':
      return 'Closed the settlement';
    case 'followed_up':
      return `Sent a reminder to ${String(e.meta?.waitingOn ?? 'the approver')}`;
  }
}

const TONE: Partial<Record<AdvanceEvent['type'], string>> = {
  approved: 'good',
  disbursed: 'good',
  closed: 'good',
  rejected: 'bad',
  cancelled: 'bad',
  transaction_reversed: 'bad',
  returned: 'warn',
};

function AdvanceTimeline({ events }: { events: AdvanceEvent[] }) {
  return (
    <div className="card wide">
      <h2>Activity</h2>
      <ol className="timeline">
        {events.map((e) => (
          <li key={e.id} className={TONE[e.type]}>
            <span>
              <strong>{e.actor?.name ?? 'System'}</strong>
              {e.actorRole && e.actorRole !== 'employee' && (
                <span className="muted small"> · {ROLE_LABELS[e.actorRole]}</span>
              )}
            </span>
            <span>{describe(e)}</span>
            {e.message && (
              <blockquote className={`event-message ${e.type}`}>{e.message}</blockquote>
            )}
            <span className="muted small">{formatWhen(e.at)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
