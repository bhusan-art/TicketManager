import {
  formatRupees,
  type ApprovalQueueItem,
  type ApprovalView,
  type Paginated,
} from '@ticketmanager/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useUser } from '../../auth/AuthContext';
import { ProjectSelect, useProjects } from '../../components/ProjectFilter';
import { FormError } from '../../components/forms';
import { VoucherStatus, formatWhen } from '../../components/VoucherStatus';
import { ApiError, apiGet } from '../../lib/api';

const TABS: { key: ApprovalView; label: string }[] = [
  { key: 'pending', label: 'Waiting for me' },
  { key: 'queried', label: 'Queried' },
  { key: 'done', label: 'Handled by me' },
];

const INTRO: Record<string, { title: string; text: string }> = {
  manager: { title: 'Approvals', text: 'Expense claims from people who report to you.' },
  accounts: {
    title: 'Verification',
    text: 'Claims approved by managers, plus managers’ and directors’ own claims.',
  },
  director: { title: 'Approvals', text: 'Claims made by the Accounts team.' },
};

/** The approver's queue. The active role decides which claims appear. */
export function ApprovalQueue({ base }: { base: '/approvals' | '/verification' }) {
  const user = useUser();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [result, setResult] = useState<Paginated<ApprovalQueueItem> | null>(null);
  const [counts, setCounts] = useState<{ pending: number; queried: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(params.get('search') ?? '');
  const projects = useProjects();
  const view = (params.get('view') ?? 'pending') as ApprovalView;
  const intro = INTRO[user.activeRole] ?? INTRO.manager!;

  const query = params.toString();
  useEffect(() => {
    let active = true;
    apiGet<Paginated<ApprovalQueueItem>>(`/approvals?${query}`).then(
      (r) => {
        if (!active) return;
        setResult(r);
        setError(null);
      },
      (e: unknown) =>
        active && setError(e instanceof ApiError ? e.message : 'Could not load the queue'),
    );
    return () => {
      active = false;
    };
  }, [query, user.activeRole]);

  useEffect(() => {
    apiGet<{ pending: number; queried: number }>('/approvals/counts').then(setCounts, () => {});
  }, [user.activeRole]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value && !(key === 'view' && value === 'pending')) next.set(key, value);
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
          <h1>{intro.title}</h1>
          <p className="muted">{intro.text}</p>
        </div>
      </div>

      <div className="tabs" role="tablist" aria-label="Queue">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={view === t.key}
            className={`tab${view === t.key ? ' active' : ''}`}
            onClick={() => setFilter('view', t.key)}
          >
            {t.label}
            {counts && t.key !== 'done' && <span className="tab-count">{counts[t.key]}</span>}
          </button>
        ))}
      </div>

      <div className="filters">
        <input
          type="search"
          placeholder="Search voucher number, purpose or employee"
          aria-label="Search the queue"
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
              <th>Purpose</th>
              <th>Submitted</th>
              <th className="num">Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {result?.data.map((v) => (
              <tr key={v.id} onClick={() => navigate(`${base}/${v.id}`)}>
                <td>
                  <Link to={`${base}/${v.id}`} onClick={(e) => e.stopPropagation()}>
                    {v.number}
                  </Link>
                </td>
                <td>
                  {v.employee.name}
                  <div className="muted small">
                    {[v.employee.employeeCode, v.department?.name].filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td>
                  {v.purpose}
                  <div className="muted small">
                    {v.lineCount} {v.lineCount === 1 ? 'expense' : 'expenses'}
                    {v.categories.length > 0 && ` · ${v.categories.join(', ')}`}
                    {v.project && ` · ${v.project.name}`}
                  </div>
                </td>
                <td>{formatWhen(v.submittedAt)}</td>
                <td className="num">{formatRupees(v.totalPaise)}</td>
                <td>
                  <VoucherStatus status={v.approvalStatus} reviewStarted={v.reviewStarted} />
                </td>
              </tr>
            ))}
            {result && result.data.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  {view === 'pending' && !params.get('search')
                    ? 'Nothing is waiting for you.'
                    : 'No vouchers match.'}
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
