import type { HealthResponse } from '@ticketmanager/shared';
import { useEffect, useState } from 'react';
import { ROLE_LABELS } from '@ticketmanager/shared';
import { useUser } from '../auth/AuthContext';
import { AccountsOverview } from '../components/AccountsOverview';
import { CHECK_LABELS, SystemStatusCard } from '../components/SystemStatusCard';
import { getHealth } from '../lib/api';

type State =
  | { kind: 'loading' }
  | { kind: 'loaded'; health: HealthResponse }
  | { kind: 'error'; message: string };

function greeting(hour: number) {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function Dashboard() {
  const user = useUser();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const isAdmin = user.activeRole === 'admin';

  useEffect(() => {
    if (isAdmin) return;
    let active = true;
    getHealth<HealthResponse>()
      .then((health) => active && setState({ kind: 'loaded', health }))
      .catch((err: Error) => active && setState({ kind: 'error', message: err.message }));
    return () => {
      active = false;
    };
  }, [isAdmin]);

  return (
    <section>
      <h1>
        {greeting(new Date().getHours())}, {user.name.split(' ')[0]}
      </h1>
      <p className="muted">You are viewing TicketManager as {ROLE_LABELS[user.activeRole]}.</p>

      {['accounts', 'director', 'admin'].includes(user.activeRole) && (
        <AccountsOverview showLinks={user.activeRole === 'accounts'} />
      )}

      {isAdmin ? (
        <SystemStatusCard />
      ) : (
        <div className="card" aria-live="polite">
          <h2>System status</h2>
          {state.kind === 'loading' && <p>Checking services…</p>}
          {state.kind === 'error' && (
            <p className="status down">API unreachable: {state.message}</p>
          )}
          {state.kind === 'loaded' && (
            <>
              <p className={`status ${state.health.status === 'ok' ? 'up' : 'down'}`}>
                {state.health.status === 'ok' ? 'All services up' : 'Some services are down'} · API
                v{state.health.version}
              </p>
              <ul className="checks">
                {Object.entries(state.health.checks).map(([name, status]) => (
                  <li key={name}>
                    <span>{CHECK_LABELS[name] ?? name}</span>
                    <span className={`pill ${status}`}>{status === 'up' ? 'Up' : 'Down'}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
