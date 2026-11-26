import {
  formatRupees,
  type AdvanceSummary,
  type AdvanceView,
  type Paginated,
  type Role,
} from '@ticketmanager/shared';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useUser } from '../../auth/AuthContext';
import { FormError } from '../../components/forms';
import { AdvanceStatusPill, formatDay } from '../../components/VoucherStatus';
import { ApiError, apiGet } from '../../lib/api';

type Tab = { key: AdvanceView; label: string; count?: 'review' | 'disburse' };

/** The tabs each role sees. Employees see their own advances. */
const TABS: Partial<Record<Role, Tab[]>> = {
  manager: [
    { key: 'review', label: 'Waiting for me', count: 'review' },
    { key: 'all', label: 'My team' },
  ],
  director: [
    { key: 'review', label: 'Waiting for me', count: 'review' },
    { key: 'all', label: 'All' },
  ],
  accounts: [
    { key: 'review', label: 'To review', count: 'review' },
    { key: 'disburse', label: 'To pay out', count: 'disburse' },
    { key: 'open', label: 'Open' },
    { key: 'closed', label: 'Settled' },
    { key: 'all', label: 'All' },
  ],
};

/**
 * Advances, from the employee's or an approver's side. The Settlements page is the same list,
 * starting on open advances and showing each balance.
 */
export function AdvanceList({ settlements = false }: { settlements?: boolean }) {
  const user = useUser();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tabs = TABS[user.activeRole] ?? [];
  const fallback: AdvanceView = tabs.length ? (settlements ? 'open' : tabs[0]!.key) : 'mine';
  const view = (params.get('view') as AdvanceView | null) ?? fallback;
  const [result, setResult] = useState<Paginated<AdvanceSummary> | null>(null);
  const [counts, setCounts] = useState<{
    review: number;
    disburse: number;
    overdue: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(params.get('search') ?? '');

  const q = new URLSearchParams(params);
  q.set('view', view);
  const query = q.toString();
  useEffect(() => {
    let active = true;
    apiGet<Paginated<AdvanceSummary>>(`/advances?${query}`).then(
      (r) => {
        if (!active) return;
        setResult(r);
        setError(null);
      },
      (e: unknown) =>
        active && setError(e instanceof ApiError ? e.message : 'Could not load advances'),
    );
    return () => {
      active = false;
    };
  }, [query, user.activeRole]);

  useEffect(() => {
    if (!tabs.length) return;
    apiGet<{ review: number; disburse: number; overdue: number }>('/advances/counts').then(
      setCounts,
      () => {},
    );
  }, [tabs.length, user.activeRole]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next);
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      if (search !== (params.get('search') ?? '')) setFilter('search', search.trim());
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const mine = view === 'mine';
  const showBalance = settlements || view === 'open' || view === 'closed' || mine;
  const meta = result?.meta;
  const title = settlements ? 'Settlements' : mine ? 'My advances' : 'Advances';
  const intro = settlements
    ? 'Paid-out advances and what is left to settle: claims tagged to them, money due back, and any shortfall to pay.'
    : mine
      ? 'Ask for money before a trip, then tag your expense claims to it. Any unused amount is returned.'
      : 'Advance requests from employees, and advances paid out.';

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="muted">{intro}</p>
        </div>
        {mine && user.roles.includes('employee') && (
          <div className="actions">
            <Link to="/advances/new" className="btn btn-primary">
              <Plus size={16} aria-hidden /> Request advance
            </Link>
          </div>
        )}
      </div>

      {tabs.length > 0 && (
        <div className="tabs" role="tablist" aria-label="Advances">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={view === t.key}
              className={`tab${view === t.key ? ' active' : ''}`}
              onClick={() => setFilter('view', t.key)}
            >
              {t.label}
              {counts && t.count && <span className="tab-count">{counts[t.count]}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="filters">
        <input
          type="search"
          placeholder={
            mine ? 'Search advance number or purpose' : 'Search number, purpose or employee'
          }
          aria-label="Search advances"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {!mine && user.activeRole === 'accounts' && (
          <label className="filter-toggle">
            <input
              type="checkbox"
              checked={params.get('overdue') === 'true'}
              onChange={(e) => setFilter('overdue', e.target.checked ? 'true' : '')}
            />
            Overdue only{counts ? ` (${counts.overdue})` : ''}
          </label>
        )}
      </div>

      <FormError message={error} />
      <div className="card table-card">
        <table className="table clickable">
          <thead>
            <tr>
              <th>Advance no.</th>
              {!mine && <th>Employee</th>}
              <th>Purpose</th>
              <th>{showBalance ? 'Settle by' : 'Expected'}</th>
              <th className="num">{showBalance ? 'Paid out' : 'Requested'}</th>
              {showBalance && <th className="num">Claims approved</th>}
              {showBalance && <th className="num">Balance</th>}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {result?.data.map((a) => {
              const s = a.settlement;
              return (
                <tr key={a.id} onClick={() => navigate(`/advances/${a.id}`)}>
                  <td className="nowrap">
                    <Link to={`/advances/${a.id}`} onClick={(e) => e.stopPropagation()}>
                      {a.number ?? 'Draft'}
                    </Link>
                  </td>
                  {!mine && (
                    <td>
                      {a.employee.name}
                      <div className="muted small">
                        {[a.employee.employeeCode, a.department?.name].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                  )}
                  <td>{a.purpose}</td>
                  <td>
                    {formatDay(showBalance ? (a.settleBy ?? a.expectedDate) : a.expectedDate)}
                  </td>
                  <td className="num">
                    {formatRupees(
                      showBalance && s ? s.disbursedPaise : (a.approvedPaise ?? a.requestedPaise),
                    )}
                  </td>
                  {showBalance && (
                    <td className="num">{s ? formatRupees(s.approvedExpensesPaise) : '—'}</td>
                  )}
                  {showBalance && (
                    <td className="num">
                      <Balance settlement={s} />
                    </td>
                  )}
                  <td>
                    <AdvanceStatusPill status={a.status} overdue={a.overdue} />
                  </td>
                </tr>
              );
            })}
            {result && result.data.length === 0 && (
              <tr>
                <td colSpan={8} className="empty">
                  {mine
                    ? 'You have no advances yet.'
                    : view === 'review'
                      ? 'Nothing is waiting for you.'
                      : 'No advances here.'}
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
            Page {meta.page} of {meta.totalPages} · {meta.total} advances
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

/** "₹6,000 due back", "₹2,500 to pay", "Balanced". */
export function Balance({ settlement: s }: { settlement: AdvanceSummary['settlement'] }) {
  if (!s) return <>—</>;
  if (s.dueBackPaise > 0) {
    return (
      <span className="owed">
        {formatRupees(s.dueBackPaise)}
        <div className="muted small">due back</div>
      </span>
    );
  }
  if (s.payablePaise > 0) {
    return (
      <span className="owed">
        {formatRupees(s.payablePaise)}
        <div className="muted small">to pay employee</div>
      </span>
    );
  }
  return <span>Balanced</span>;
}
