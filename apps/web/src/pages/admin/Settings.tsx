import {
  formatRupees,
  paiseToInput,
  parseRupees,
  type AdvanceSettings,
} from '@ticketmanager/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Field, FormError } from '../../components/forms';
import { ApiError, api, apiGet } from '../../lib/api';

/** Company policies. For now: the largest advance anyone may request. */
export function Settings() {
  const [current, setCurrent] = useState<AdvanceSettings | null>(null);
  const [limit, setLimit] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet<AdvanceSettings>('/advances/settings').then(
      (s) => {
        setCurrent(s);
        setLimit(s.maxAdvancePaise === null ? '' : paiseToInput(s.maxAdvancePaise));
      },
      (e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load settings'),
    );
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldError(undefined);
    setNotice(null);
    const paise = limit.trim() === '' ? null : parseRupees(limit);
    if (limit.trim() !== '' && (paise === null || paise <= 0)) {
      setFieldError('Enter an amount like 50000, or leave it empty for no limit');
      return;
    }
    setBusy(true);
    try {
      const saved = await api<AdvanceSettings>('PUT', '/admin/settings/advances', {
        maxAdvancePaise: paise,
      });
      setCurrent(saved);
      setNotice(
        saved.maxAdvancePaise === null
          ? 'Saved. There is no limit on advances.'
          : `Saved. Advances are limited to ${formatRupees(saved.maxAdvancePaise)}.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Company-wide policies.</p>
        </div>
      </div>
      <form className="card form-grid" onSubmit={save} noValidate>
        <h2>Advances</h2>
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        <FormError message={error} />
        <Field
          label="Largest advance (₹)"
          error={fieldError}
          hint="Leave empty for no limit. Each person can have one active advance, settled within 30 days of the expected expense date."
        >
          <input
            inputMode="decimal"
            value={limit}
            disabled={!current}
            onChange={(e) => setLimit(e.target.value)}
          />
        </Field>
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !current}>
            Save
          </button>
        </div>
      </form>
    </section>
  );
}
