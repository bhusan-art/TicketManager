import type { AuthUser, Role, SessionResponse } from '@ticketmanager/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { apiPost, refreshSession, setAccessToken, setSignedOutHandler } from '../lib/api';

/** `offline`: the server couldn't be reached to restore the sign-in; retried when back online. */
type Status = 'loading' | 'signed-in' | 'signed-out' | 'offline';

interface AuthState {
  status: Status;
  user: AuthUser | null;
  /** `remember` keeps the sign-in for 30 days; otherwise it ends when the browser closes. */
  signIn(email: string, password: string, remember?: boolean): Promise<void>;
  signOut(): Promise<void>;
  switchRole(role: Role): Promise<void>;
  /** Re-reads the user after a change (e.g. password set). */
  reload(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const restored = useRef(false);

  const apply = useCallback((session: SessionResponse | null) => {
    setAccessToken(session?.accessToken ?? null);
    setUser(session?.user ?? null);
    setStatus(session ? 'signed-in' : 'signed-out');
  }, []);

  useEffect(() => {
    setSignedOutHandler(() => apply(null));
    // Restore the session from the refresh cookie, unless the user signs in first. With no
    // network (the installed app opened offline) that says nothing about being signed out:
    // wait, and try again when the connection is back.
    let settled = false;
    const restore = () =>
      refreshSession().then(
        (session) => {
          if (!settled && !restored.current) apply(session);
        },
        () => {
          if (settled || restored.current) return;
          setStatus('offline');
          window.addEventListener('online', restore, { once: true });
        },
      );
    void restore();
    return () => {
      settled = true;
      window.removeEventListener('online', restore);
    };
  }, [apply]);

  // Refresh a minute before the access token expires.
  useEffect(() => {
    if (status !== 'signed-in') return;
    const timer = setInterval(
      // A failed request (offline) keeps the session; the next tick or request tries again.
      () =>
        refreshSession().then(
          (s) => s ?? apply(null),
          () => {},
        ),
      13 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, [status, apply]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      async signIn(email, password, remember = false) {
        const session = await apiPost<SessionResponse>('/auth/login', {
          email,
          password,
          remember,
        });
        restored.current = true;
        apply(session);
      },
      async signOut() {
        try {
          await apiPost('/auth/logout');
        } finally {
          apply(null);
        }
      },
      async switchRole(role) {
        apply(await apiPost<SessionResponse>('/auth/switch-role', { role }));
      },
      async reload() {
        apply(await refreshSession());
      },
    }),
    [status, user, apply],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** The signed-in user. Only use under a route that requires sign-in. */
export function useUser() {
  const { user } = useAuth();
  if (!user) throw new Error('useUser needs a signed-in user');
  return user;
}
