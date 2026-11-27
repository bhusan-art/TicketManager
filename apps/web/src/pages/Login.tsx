import {
  GOOGLE_LOGIN_ERRORS,
  type AuthConfigResponse,
  type GoogleLoginError,
} from '@ticketmanager/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Field, FormError } from '../components/forms';
import { ApiError, apiGet } from '../lib/api';
import { AuthLayout } from './AuthLayout';

export function Login() {
  const { status, signIn } = useAuth();
  const location = useLocation();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const googleError = params.get('error') as GoogleLoginError | null;
  const [error, setError] = useState<string | null>(
    googleError ? (GOOGLE_LOGIN_ERRORS[googleError] ?? null) : null,
  );
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    apiGet<AuthConfigResponse>('/auth/config').then(
      (c) => setGoogleEnabled(c.googleEnabled),
      () => setGoogleEnabled(false),
    );
  }, []);

  if (status === 'signed-in') {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password, remember);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <h1>Sign in to your account</h1>
      <p className="muted">Enter your credentials to continue</p>
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
        <Field label="Password">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <div className="form-row-split">
          <label className="check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>Keep me signed in</span>
          </label>
          <Link to="/forgot-password">Forgot password?</Link>
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {googleEnabled && (
        <>
          <div className="divider">or continue with</div>
          <a
            className="btn btn-secondary btn-block"
            href={`/api/v1/auth/google/start${remember ? '?remember=1' : ''}`}
          >
            <GoogleMark /> Sign in with Google
          </a>
        </>
      )}
    </AuthLayout>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}
