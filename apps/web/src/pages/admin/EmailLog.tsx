import {
  EMAIL_KIND_LABELS,
  EMAIL_STATUS_LABELS,
  type EmailDelivery,
  type EmailStatus,
  type Paginated,
} from '@ticketmanager/shared';
import { RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { FormError } from '../../components/forms';
import { formatWhen } from '../../components/VoucherStatus';
import { ApiError, apiGet, apiPost } from '../../lib/api';

type Log = Paginated<EmailDelivery> & { counts: { pending: number; failed: number } };

const TONE: Record<EmailStatus, string> = { pending: 'pending', sent: 'up', failed: 'down' };

const TABS: { key: EmailStatus | ''; label: string; count?: 'pending' | 'failed' }[] = [
  { key: '', label: 'All' },
  { key: 'failed', label: 'Failed', count: 'failed' },
  { key: 'pending', label: 'Waiting', count: 'pending' },
  { key: 'sent', label: 'Sent' },
];

/** Every email the app sent or tried to send. Failed ones can be sent again. */
export function EmailLog() {
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? '') as EmailStatus | '';
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [reload, setReload] = useState(0);
  const query = params.toString();

  useEffect(() => {
    let active = true;
    apiGet<Log>(`/admin/emails?${query}`).then(
      (r) => {
        if (!active) return;
        setLog(r);
        setError(null);
      },
      (e: unknown) => active && setError(e instanceof ApiError ? e.message : 'Could not load'),
    );
    return () => {
      active = false;
    };
  }, [query, reload]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next);
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      if (search.trim() !== (params.get('search') ?? '')) setFilter('search', search.trim());
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function retry(e: EmailDelivery) {
    setError(null);
    try {
      await apiPost(`/admin/emails/${e.id}/retry`);
      setNotice(`Sending “${e.subject}” again.`);
      setReload((n) => n + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not retry');
    }
  }

  const meta = log?.meta;
  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Email log</h1>
          <p className="muted">
            Every email the app sends. Failed sends are retried automatically for about four hours;
            after that you can send them again here once the mail settings are fixed.
          </p>
        </div>
      </div>

      <div className="tabs" role="tablist" aria-label="Email status">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={status === t.key}
            className={`tab${status === t.key ? ' active' : ''}`}
            onClick={() => setFilter('status', t.key)}
          >
            {t.label}
            {log && t.count && <span className="tab-count">{log.counts[t.count]}</span>}
          </button>
        ))}
      </div>

      <div className="filters">
        <input
          type="search"
          placeholder="Search recipient or subject"
          aria-label="Search emails"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <FormError message={error} />
      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Queued</th>
              <th>To</th>
              <th>Subject</th>
              <th>Type</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {log?.data.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{formatWhen(e.createdAt)}</td>
                <td>
                  {e.to.join(', ')}
                  {e.cc.length > 0 && <div className="muted small">cc {e.cc.join(', ')}</div>}
                </td>
                <td>{e.subject}</td>
                <td className="nowrap">{EMAIL_KIND_LABELS[e.kind]}</td>
                <td>
                  <span className={`pill ${TONE[e.status]}`}>{EMAIL_STATUS_LABELS[e.status]}</span>
                  <div className="muted small">
                    {e.status === 'sent'
                      ? formatWhen(e.sentAt)
                      : e.attempts > 0
                        ? `${e.attempts} ${e.attempts === 1 ? 'try' : 'tries'}${e.nextAttemptAt ? `, next ${formatWhen(e.nextAttemptAt)}` : ''}`
                        : ''}
                  </div>
                  {e.lastError && e.status !== 'sent' && (
                    <div className="small error-text">{e.lastError}</div>
                  )}
                </td>
                <td>
                  {e.status === 'failed' && (
                    <button className="btn btn-secondary btn-sm" onClick={() => void retry(e)}>
                      <RotateCw size={14} aria-hidden /> Retry
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {log && log.data.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No emails here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {meta && meta.totalPages > 1 && (
        <nav className="pager" aria-label="Pages">
          <button
            className="btn btn-secondary"
            disabled={meta.page <= 1}
            onClick={() => setFilter('page', String(meta.page - 1))}
          >
            Previous
          </button>
          <span>
            Page {meta.page} of {meta.totalPages} · {meta.total} emails
          </span>
          <button
            className="btn btn-secondary"
            disabled={meta.page >= meta.totalPages}
            onClick={() => setFilter('page', String(meta.page + 1))}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}
