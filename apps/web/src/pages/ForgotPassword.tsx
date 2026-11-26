import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Field, FormError } from '../components/forms';
import { ApiError, apiPost } from '../lib/api';
import { AuthLayout } from './AuthLayout';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost('/auth/password/forgot', { email });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <Link to="/login" className="back-link">
        ← Back to sign in
      </Link>
      <h1>Forgot your password?</h1>
      {sent ? (
        <p className="notice">
          If <strong>{email}</strong> has an account, we have sent it a link to reset the password.
          The link works for 1 hour.
        </p>
      ) : (
        <>
          <p className="muted">Enter your registered email and we’ll send you a reset link.</p>
          <form onSubmit={onSubmit} noValidate>
            <FormError message={error} />
            <Field label="Email address">
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </Field>
            <button type="submit" className="btn btn-primary btn-block" disabled={busy || !email}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        </>
      )}
    </AuthLayout>
  );
}
