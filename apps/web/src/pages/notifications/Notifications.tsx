import { ROLE_LABELS, type AppNotification, type Paginated } from '@ticketmanager/shared';
import { CheckCheck, Receipt, HandCoins } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { FormError } from '../../components/forms';
import { formatWhen } from '../../components/VoucherStatus';
import { ApiError, apiGet, apiPost } from '../../lib/api';
import { notificationsChanged } from '../../lib/notifications';

/** Everything that happened to the person's claims and the claims waiting on them. */
export function Notifications() {
  const { user, switchRole } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const unreadOnly = params.get('unread') === 'true';
  const page = Number(params.get('page') ?? '1') || 1;
  const [result, setResult] = useState<Paginated<AppNotification> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    const q = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (unreadOnly) q.set('unread', 'true');
    apiGet<Paginated<AppNotification>>(`/notifications?${q}`).then(
      (r) => {
        if (!active) return;
        setResult(r);
        setError(null);
      },
      (e: unknown) =>
        active && setError(e instanceof ApiError ? e.message : 'Could not load notifications'),
    );
    return () => {
      active = false;
    };
  }, [page, unreadOnly, reload]);

  function show(next: Record<string, string>) {
    setParams(new URLSearchParams(next));
  }

  async function markAllRead() {
    try {
      await apiPost('/notifications/read', { all: true });
      notificationsChanged();
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not mark them read');
    }
  }

  async function open(n: AppNotification) {
    if (!n.readAt) {
      await apiPost('/notifications/read', { ids: [n.id] }).catch(() => {});
      notificationsChanged();
    }
    if (!n.link) {
      setReload((x) => x + 1);
      return;
    }
    // Act in the role the notification is for, e.g. Manager for "needs your approval".
    if (n.role && user && n.role !== user.activeRole && user.roles.includes(n.role)) {
      await switchRole(n.role);
    }
    navigate(n.link);
  }

  const unreadHere = result?.data.some((n) => !n.readAt) ?? false;
  const meta = result?.meta;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Notifications</h1>
          <p className="muted">
            Steps on your claims and advances, and the ones waiting for you. Opening one switches to
            the role it is for.
          </p>
        </div>
        <div className="actions">
          <button
            className="btn btn-secondary"
            onClick={() => void markAllRead()}
            disabled={!unreadHere}
          >
            <CheckCheck size={16} aria-hidden /> Mark all read
          </button>
        </div>
      </div>

      <div className="tabs" role="tablist" aria-label="Notifications">
        <button
          role="tab"
          aria-selected={!unreadOnly}
          className={`tab${!unreadOnly ? ' active' : ''}`}
          onClick={() => show({})}
        >
          All
        </button>
        <button
          role="tab"
          aria-selected={unreadOnly}
          className={`tab${unreadOnly ? ' active' : ''}`}
          onClick={() => show({ unread: 'true' })}
        >
          Unread
        </button>
      </div>

      <FormError message={error} />
      <ul className="card wide notification-list">
        {result?.data.map((n) => {
          const Icon = n.entityType === 'advance' ? HandCoins : Receipt;
          const [body, quote] = (n.body ?? '').split('\n');
          return (
            <li key={n.id} className={n.readAt ? 'read' : 'unread'}>
              <button className="notification" onClick={() => void open(n)}>
                <span className="notification-icon" aria-hidden>
                  <Icon size={18} />
                </span>
                <span className="notification-text">
                  <strong>{n.title}</strong>
                  {body && <span>{body}</span>}
                  {quote && <span className="quote">{quote}</span>}
                  <span className="muted small">
                    {formatWhen(n.createdAt)}
                    {n.role && n.role !== 'employee' ? ` · as ${ROLE_LABELS[n.role]}` : ''}
                  </span>
                </span>
                {!n.readAt && <span className="unread-dot" aria-label="Unread" />}
              </button>
            </li>
          );
        })}
        {result && result.data.length === 0 && (
          <li className="empty">
            {unreadOnly ? 'You have read everything.' : 'No notifications yet.'}
          </li>
        )}
      </ul>

      {meta && meta.totalPages > 1 && (
        <nav className="pager" aria-label="Pages">
          <button
            className="btn btn-secondary"
            disabled={meta.page <= 1}
            onClick={() => show({ ...(unreadOnly && { unread: 'true' }), page: String(page - 1) })}
          >
            Previous
          </button>
          <span>
            Page {meta.page} of {meta.totalPages}
          </span>
          <button
            className="btn btn-secondary"
            disabled={meta.page >= meta.totalPages}
            onClick={() => show({ ...(unreadOnly && { unread: 'true' }), page: String(page + 1) })}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}
