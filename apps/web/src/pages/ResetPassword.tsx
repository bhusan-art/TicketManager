import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Field, FormError, PasswordChecklist, passwordOk } from '../components/forms';
import { ApiError, apiPost } from '../lib/api';
import { AuthLayout } from './AuthLayout';

/** Used for both the reset link and the invite ("set your password") link. */
export function ResetPassword({ invite = false }: { invite?: boolean }) {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = passwordOk(password) && password === confirm && !busy;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost('/auth/password/reset', { token, password });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const title = invite ? 'Set your password' : 'Reset password';

  if (!token) {
    return (
      <AuthLayout>
        <h1>{title}</h1>
        <p className="notice">This link is incomplete. Open the link from your email again.</p>
        <Link to="/login">Back to sign in</Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h1>{title}</h1>
      {done ? (
        <>
          <p className="notice">Your password is set. You can sign in now.</p>
          <Link to="/login" className="btn btn-primary btn-block">
            Go to sign in
          </Link>
        </>
      ) : (
        <>
          <p className="muted">Create a new password for your account.</p>
          <form onSubmit={onSubmit} noValidate>
            <FormError message={error} />
            <Field label="New password">
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
            </Field>
            <Field label="Confirm password" error={mismatch ? 'Passwords do not match' : undefined}>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
            <PasswordChecklist password={password} />
            <button type="submit" className="btn btn-primary btn-block" disabled={!canSubmit}>
              {busy ? 'Saving…' : title}
            </button>
          </form>
        </>
      )}
    </AuthLayout>
  );
}
