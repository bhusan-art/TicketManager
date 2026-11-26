import {
  formatRupees,
  paiseToInput,
  parseRupees,
  todayIso,
  type AdvanceDetail,
  type AdvanceSettings,
} from '@ticketmanager/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Field, FormError } from '../../components/forms';
import { ApiError, api, apiGet, idempotencyKey } from '../../lib/api';

/** Request an advance, or change a draft or returned one. */
export function AdvanceForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [advance, setAdvance] = useState<AdvanceDetail | null>(null);
  const [purpose, setPurpose] = useState('');
  const [amount, setAmount] = useState('');
  const [expectedDate, setExpectedDate] = useState(todayIso());
  const [notes, setNotes] = useState('');
  const [limit, setLimit] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet<AdvanceSettings>('/advances/settings').then(
      (s) => setLimit(s.maxAdvancePaise),
      () => {},
    );
  }, []);

  useEffect(() => {
    if (!id) return;
    let active = true;
    apiGet<AdvanceDetail>(`/advances/${id}`).then(
      (a) => {
        if (!active) return;
        if (!a.can.edit) {
          navigate(`/advances/${a.id}`, { replace: true });
          return;
        }
        setAdvance(a);
        setPurpose(a.purpose);
        setAmount(paiseToInput(a.requestedPaise));
        setExpectedDate(a.expectedDate);
        setNotes(a.notes ?? '');
      },
      (e: unknown) => active && setError(e instanceof ApiError ? e.message : 'Could not load'),
    );
    return () => {
      active = false;
    };
  }, [id, navigate]);

  const requestedPaise = parseRupees(amount);
  const overLimit = limit !== null && requestedPaise !== null && requestedPaise > limit;

  async function save(e: FormEvent, submit: boolean) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    if (requestedPaise === null || requestedPaise <= 0) {
      setFieldErrors({ requestedPaise: 'Enter an amount like 15000 or 15000.50' });
      return;
    }
    setBusy(true);
    const body = { purpose, requestedPaise, expectedDate, notes };
    try {
      let saved = advance
        ? await api<AdvanceDetail>('PATCH', `/advances/${advance.id}`, {
            version: advance.version,
            ...body,
          })
        : await api<AdvanceDetail>('POST', '/advances', body);
      setAdvance(saved);
      if (submit) {
        saved = await api<AdvanceDetail>(
          'POST',
          `/advances/${saved.id}/submit`,
          { version: saved.version },
          { 'Idempotency-Key': idempotencyKey() },
        );
      }
      navigate(`/advances/${saved.id}`, {
        state: {
          notice: submit
            ? `Advance ${saved.number} sent to ${saved.waitingOn ?? 'review'}.`
            : 'Draft saved.',
        },
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setError(err.message);
      } else setError('Could not save. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <Link to={advance ? `/advances/${advance.id}` : '/advances'} className="back-link">
        ← {advance?.number ?? 'My advances'}
      </Link>
      <div className="page-head">
        <div>
          <h1>{advance ? 'Change advance request' : 'Request an advance'}</h1>
          <p className="muted">
            Your manager and Accounts approve it, then Accounts pays it out. Tag your expense claims
            to it afterwards; settle within 30 days of the expected date.
          </p>
        </div>
      </div>
      <form className="card wide form-grid" onSubmit={(e) => void save(e, true)} noValidate>
        <FormError message={error} />
        <Field label="Purpose" error={fieldErrors.purpose} hint="e.g. Site visit to Pune, 3 days">
          <input
            value={purpose}
            maxLength={200}
            onChange={(e) => setPurpose(e.target.value)}
            autoFocus
          />
        </Field>
        <Field
          label="Amount (₹)"
          error={
            fieldErrors.requestedPaise ??
            (overLimit ? `Advances are limited to ${formatRupees(limit!)}` : undefined)
          }
          hint={limit !== null ? `Up to ${formatRupees(limit)}` : undefined}
        >
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field
          label="When will you spend it?"
          error={fieldErrors.expectedDate}
          hint="The expected expense date"
        >
          <input
            type="date"
            value={expectedDate}
            onChange={(e) => setExpectedDate(e.target.value)}
          />
        </Field>
        <Field label="Details" error={fieldErrors.notes} hint="Optional: travel plan, estimate">
          <textarea
            rows={3}
            maxLength={1000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <div className="actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={(e) => void save(e, false)}
          >
            Save draft
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || overLimit}>
            {advance?.status === 'returned' ? 'Resubmit' : 'Submit request'}
          </button>
        </div>
      </form>
    </section>
  );
}
