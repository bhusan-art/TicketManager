import { ROLE_LABELS } from '@ticketmanager/shared';
import { useState, type FormEvent } from 'react';
import { useUser } from '../auth/AuthContext';
import { Field, FormError, PasswordChecklist, passwordOk } from '../components/forms';
import { ApiError, apiPost } from '../lib/api';

export function Profile() {
  const user = useUser();
  const rows: [string, string][] = [
    ['Full name', user.name],
    ['Email', user.email],
    ['Employee ID', user.employeeCode ?? '—'],
    ['Department', user.department?.name ?? '—'],
    ['Designation', user.designation ?? '—'],
    ['Reporting manager', user.manager?.name ?? '—'],
    ['Roles', user.roles.map((r) => ROLE_LABELS[r]).join(', ')],
    ['Google sign-in', user.googleLinked ? 'Linked' : 'Not linked'],
  ];
  return (
    <section>
      <h1>My profile</h1>
      <p className="muted">Ask your admin to change these details.</p>
      <div className="card">
        <dl className="details">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <ChangePassword hasPassword={user.hasPassword} />
    </section>
  );
}

function ChangePassword({ hasPassword }: { hasPassword: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setSaved(false);
    try {
      await apiPost('/auth/password/change', {
        currentPassword: hasPassword ? current : undefined,
        newPassword: next,
      });
      setSaved(true);
      setCurrent('');
      setNext('');
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        if (!Object.keys(err.fieldErrors).length) setError(err.message);
      } else setError('Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>{hasPassword ? 'Change password' : 'Set a password'}</h2>
      <form onSubmit={onSubmit} noValidate className="narrow">
        <FormError message={error} />
        {saved && <p className="notice">Password saved. Other devices have been signed out.</p>}
        {hasPassword && (
          <Field label="Current password" error={fieldErrors.currentPassword}>
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
        )}
        <Field label="New password">
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <PasswordChecklist password={next} />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || !passwordOk(next) || (hasPassword && !current)}
        >
          {busy ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </div>
  );
}
