import type { Role } from '@ticketmanager/shared';
import { ROLE_LABELS } from '@ticketmanager/shared';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from './AuthContext';

export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <p className="page-loading">Loading…</p>;
  if (status === 'offline') {
    return (
      <section className="page-loading offline-page" role="status">
        <img src="/favicon.svg" alt="" width={40} height={40} />
        <h1>You&apos;re offline</h1>
        <p className="muted">
          TicketManager needs the internet to show your claims. It opens again by itself as soon as
          you&apos;re connected.
        </p>
      </section>
    );
  }
  if (status === 'signed-out') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

/** Shows the page only in one of these roles; otherwise explains which role to switch to. */
export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return null;
  if (roles.includes(user.activeRole)) return <>{children}</>;
  const held = roles.filter((r) => user.roles.includes(r));
  return (
    <section>
      <h1>Not available in this role</h1>
      <p className="muted">
        {held.length
          ? `Switch to the ${held.map((r) => ROLE_LABELS[r]).join(' or ')} role (top right) to open this page.`
          : 'Your account does not have access to this page.'}
      </p>
    </section>
  );
}
