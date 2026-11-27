import type { SystemStatus } from '@ticketmanager/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, apiGet } from '../lib/api';
import { formatBytes, formatWhen } from './VoucherStatus';

export const CHECK_LABELS: Record<string, string> = {
  database: 'Database',
  redis: 'Job queue',
  worker: 'Email worker',
};

/** Admin view of the server: services, the email worker, unsent email and nightly backups. */
export function SystemStatusCard() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<SystemStatus>('/admin/system').then(
      (s) => active && setStatus(s),
      (e: unknown) =>
        active && setError(e instanceof ApiError ? e.message : 'Could not reach the API'),
    );
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <div className="card">
        <h2>System status</h2>
        <p className="status down">API unreachable: {error}</p>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="card">
        <h2>System status</h2>
        <p>Checking services…</p>
      </div>
    );
  }

  const allUp = Object.values(status.checks).every((c) => c === 'up');
  const { backups, email } = status;
  const lastRun = backups.recent[0];
  const lastOk = backups.recent.find((r) => r.status === 'ok');
  return (
    <div className="card" aria-live="polite">
      <h2>System status</h2>
      <p className={`status ${allUp ? 'up' : 'down'}`}>
        {allUp ? 'All services up' : 'Some services are down'} · v{status.version}
      </p>
      <ul className="checks">
        {Object.entries(status.checks).map(([name, s]) => (
          <li key={name}>
            <span>
              {CHECK_LABELS[name] ?? name}
              {name === 'worker' && s === 'down' && (
                <span className="muted small">
                  {' '}
                  {status.worker.lastSeenAt
                    ? `last seen ${formatWhen(status.worker.lastSeenAt)}`
                    : 'not seen recently'}
                </span>
              )}
            </span>
            <span className={`pill ${s}`}>{s === 'up' ? 'Up' : 'Down'}</span>
          </li>
        ))}
        <li>
          <span>
            Emails waiting
            {email.failed > 0 && (
              <span className="muted small">
                {' '}
                · {email.failed} failed, <Link to="/admin/emails?status=failed">see the log</Link>
              </span>
            )}
          </span>
          <span className={`pill ${email.failed > 0 ? 'down' : 'up'}`}>{email.pending}</span>
        </li>
        <li>
          <span>
            Last backup
            <span className="muted small">
              {' '}
              {lastOk
                ? `${formatWhen(lastOk.finishedAt)} · ${lastOk.sizeBytes != null ? formatBytes(lastOk.sizeBytes) : ''}`
                : 'none yet'}
            </span>
            {lastRun?.status === 'failed' && (
              <div className="small error-text">Last try failed: {lastRun.error}</div>
            )}
          </span>
          <span className={`pill ${backups.overdue ? 'down' : 'up'}`}>
            {backups.overdue ? 'Overdue' : 'OK'}
          </span>
        </li>
      </ul>
    </div>
  );
}
