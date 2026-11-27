import {
  formatRupees,
  type Paginated,
  type VoucherStatusGroup,
  type VoucherSummary,
} from '@ticketmanager/shared';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { FormError } from '../../components/forms';
import { PaperFormButton } from '../../components/PaperFormButton';
import { VoucherStatus, formatDay } from '../../components/VoucherStatus';
import { ApiError, apiGet } from '../../lib/api';

const TABS: { key: VoucherStatusGroup | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Drafts' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'cancelled', label: 'Cancelled' },
];

export function MyExpenses() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [result, setResult] = useState<Paginated<VoucherSummary> | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(params.get('search') ?? '');
  const tab = params.get('status') ?? 'all';

  const query = params.toString();
  useEffect(() => {
    let active = true;
    apiGet<Paginated<VoucherSummary>>(`/vouchers?${query}`).then(
      (r) => active && setResult(r),
      (e: unknown) =>
        active && setError(e instanceof ApiError ? e.message : 'Could not load your expenses'),
    );
    return () => {
      active = false;
    };
  }, [query]);

  useEffect(() => {
    apiGet<Record<string, number>>('/vouchers/counts').then(setCounts, () => {});
  }, []);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(key, value);
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
  return (
    <section>
      <div className="page-head">
        <div>
          <h1>My expenses</h1>
          <p className="muted">Your expense vouchers, from draft to payment.</p>
        </div>
        <div className="actions">
          <PaperFormButton />
          <Link to="/expenses/new" className="btn btn-primary">
            <Plus size={16} aria-hidden /> New expense
          </Link>
        </div>
      </div>

      <div className="tabs" role="tablist" aria-label="Status">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`tab${tab === t.key ? ' active' : ''}`}
            onClick={() => setFilter('status', t.key)}
          >
            {t.label}
            {counts && <span className="tab-count">{counts[t.key] ?? 0}</span>}
          </button>
        ))}
      </div>

      <div className="filters">
        <input
          type="search"
          placeholder="Search by voucher number or purpose"
          aria-label="Search expenses"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <FormError message={error} />
      <div className="card table-card">
        <table className="table clickable">
          <thead>
            <tr>
              <th>Voucher no.</th>
              <th>Purpose</th>
              <th>Expense date</th>
              <th>Category</th>
              <th className="num">Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {result?.data.map((v) => (
              <tr key={v.id} onClick={() => navigate(`/expenses/${v.id}`)}>
                <td>
                  <Link to={`/expenses/${v.id}`} onClick={(e) => e.stopPropagation()}>
                    {v.number ?? 'Draft'}
                  </Link>
                </td>
                <td>{v.purpose ?? <span className="muted">No purpose yet</span>}</td>
                <td>{formatDay(v.expenseDate)}</td>
                <td>
                  {v.categories.length > 1
                    ? `${v.categories[0]} +${v.categories.length - 1}`
                    : (v.categories[0] ?? '—')}
                </td>
                <td className="num">{formatRupees(v.totalPaise)}</td>
                <td>
                  <VoucherStatus status={v.approvalStatus} />
                </td>
              </tr>
            ))}
            {result && result.data.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  {tab === 'all' && !params.get('search') ? (
                    <>
                      No expenses yet. <Link to="/expenses/new">Submit your first expense</Link>.
                    </>
                  ) : (
                    'No expenses match.'
                  )}
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
