import {
  formatRupees,
  type Paginated,
  type PaymentQueueItem,
  type PaymentQueueView,
} from '@ticketmanager/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ProjectSelect, useProjects } from '../../components/ProjectFilter';
import { FormError } from '../../components/forms';
import { PaymentStatusPill, formatWhen } from '../../components/VoucherStatus';
import { ApiError, apiGet } from '../../lib/api';

const TABS: { key: PaymentQueueView; label: string }[] = [
  { key: 'due', label: 'To pay' },
  { key: 'paid', label: 'Paid' },
  { key: 'all', label: 'All approved' },
];

/** Accounts' payment queue: approved claims, oldest approval first. */
export function PaymentQueue() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [result, setResult] = useState<Paginated<PaymentQueueItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(params.get('search') ?? '');
  const projects = useProjects();
  const view = (params.get('view') ?? 'due') as PaymentQueueView;

  const query = params.toString();
  useEffect(() => {
    let active = true;
    apiGet<Paginated<PaymentQueueItem>>(`/payments?${query}`).then(
      (r) => {
        if (!active) return;
        setResult(r);
        setError(null);
      },
      (e: unknown) =>
        active && setError(e instanceof ApiError ? e.message : 'Could not load payments'),
    );
    return () => {
      active = false;
    };
  }, [query]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value && !(key === 'view' && value === 'due')) next.set(key, value);
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

  const meta = result?.meta;
  const owed = result?.data.reduce((s, v) => s + v.outstandingPaise, 0) ?? 0;
  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Payments</h1>
          <p className="muted">
            Approved claims waiting for money. Pay the oldest approvals first.
          </p>
        </div>
      </div>

      <div className="tabs" role="tablist" aria-label="Payments">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={view === t.key}
            className={`tab${view === t.key ? ' active' : ''}`}
            onClick={() => setFilter('view', t.key)}
          >
            {t.label}
            {t.key === 'due' && view === 'due' && meta && (
              <span className="tab-count">{meta.total}</span>
            )}
          </button>
        ))}
      </div>

      <div className="filters">
        <input
          type="search"
          placeholder="Search voucher number, employee or UTR"
          aria-label="Search payments"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ProjectSelect
          aria-label="Project"
          projects={projects}
          value={params.get('projectId') ?? ''}
          onChange={(value) => setFilter('projectId', value)}
        />
      </div>

      <FormError message={error} />
      <div className="card table-card">
        <table className="table clickable">
          <thead>
            <tr>
              <th>Voucher no.</th>
              <th>Employee</th>
              <th>{view === 'paid' ? 'Paid' : 'Approved'}</th>
              <th className="num">Approved</th>
              <th className="num">Paid</th>
              <th className="num">Outstanding</th>
              <th>Payment</th>
            </tr>
          </thead>
          <tbody>
            {result?.data.map((v) => (
              <tr key={v.id} onClick={() => navigate(`/payments/${v.id}`)}>
                <td>
                  <Link to={`/payments/${v.id}`} onClick={(e) => e.stopPropagation()}>
                    {v.number}
                  </Link>
                  <div className="muted small">
                    {[v.purpose, v.project?.name].filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td>
                  {v.employee.name}
                  <div className="muted small">
                    {[v.employee.employeeCode, v.department?.name].filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td>{formatWhen(view === 'paid' ? v.paidAt : v.decidedAt)}</td>
                <td className="num">{formatRupees(v.approvedPaise)}</td>
                <td className="num">{formatRupees(v.paidPaise)}</td>
                <td className="num">
                  <strong>{formatRupees(v.outstandingPaise)}</strong>
                </td>
                <td>
                  <PaymentStatusPill status={v.paymentStatus} />
                </td>
              </tr>
            ))}
            {result && result.data.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  {view === 'due' && !params.get('search')
                    ? 'Nothing is waiting for payment.'
                    : 'No vouchers match.'}
                </td>
              </tr>
            )}
          </tbody>
          {view === 'due' && result && result.data.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={5}>Outstanding on this page</td>
                <td className="num">{formatRupees(owed)}</td>
                <td />
              </tr>
            </tfoot>
          )}
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
            Page {meta.page} of {meta.totalPages} · {meta.total} vouchers
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
