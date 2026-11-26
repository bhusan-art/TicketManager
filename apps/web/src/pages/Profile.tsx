import { ROLE_LABELS, formatWhatsApp, type AuthUser } from '@ticketmanager/shared';
import { useState, type FormEvent } from 'react';
import { useAuth, useUser } from '../auth/AuthContext';
import { Field, FormError, PasswordChecklist, passwordOk } from '../components/forms';
import { ApiError, api, apiPost } from '../lib/api';

export function Profile() {
  const user = useUser();
  const rows: [string, string][] = [
    ['Full name', user.name],
    ['Email', user.email],
    ['Employee ID', user.employeeCode ?? '—'],
    ['Department', user.department?.name ?? '—'],
    ['Designation', user.designation ?? '—'],
    ['Reporting manager', user.manager?.name ?? '—'],
    ['WhatsApp', user.whatsappNumber ? formatWhatsApp(user.whatsappNumber) : '—'],
    ['Roles', user.roles.map((r) => ROLE_LABELS[r]).join(', ')],
    ['Google sign-in', user.googleLinked ? 'Linked' : 'Not linked'],
  ];
  return (
    <section>
      <h1>My profile</h1>
      <p className="muted">
        Ask your admin to change these details. You can add your WhatsApp number below.
      </p>
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
      <WhatsAppNumber current={user.whatsappNumber} />
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

/** The person's own WhatsApp number, so colleagues can message them from a claim. */
function WhatsAppNumber({ current }: { current: string | null }) {
  const { reload } = useAuth();
  const [value, setValue] = useState(current ? formatWhatsApp(current) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const user = await api<AuthUser>('PUT', '/auth/me/whatsapp', {
        whatsappNumber: value.trim() || null,
      });
      setValue(user.whatsappNumber ? formatWhatsApp(user.whatsappNumber) : '');
      setSaved(user.whatsappNumber ? 'WhatsApp number saved.' : 'WhatsApp number removed.');
      await reload();
    } catch (err) {
      if (err instanceof ApiError) setError(err.fieldErrors.whatsappNumber ?? err.message);
      else setError('Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>WhatsApp</h2>
      <form onSubmit={onSubmit} noValidate className="narrow">
        {saved && <p className="notice">{saved}</p>}
        <Field
          label="WhatsApp number"
          error={error ?? undefined}
          hint="Colleagues can open WhatsApp from a claim with a message ready. Leave empty to remove it."
        >
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="98765 43210"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save number'}
        </button>
      </form>
    </div>
  );
}
