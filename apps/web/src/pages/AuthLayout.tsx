import type { ReactNode } from 'react';

/** Split screen used by sign-in and password pages: brand panel left, form right. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <aside className="auth-brand">
        <div className="brand brand-light">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <span>TicketManager</span>
        </div>
        <p>Submit, approve and pay expense claims in one place.</p>
      </aside>
      <main className="auth-panel">
        <div className="auth-card">{children}</div>
      </main>
    </div>
  );
}
