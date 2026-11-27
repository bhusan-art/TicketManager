import { formatRupees, type Paginated, type VoucherSummary } from '@ticketmanager/shared';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { FormError } from '../../components/forms';
import { VoucherStatus, formatDay } from '../../components/VoucherStatus';
import { ApiError, apiGet } from '../../lib/api';

/** Accounts: the paper claims they typed in for employees, newest first. */
export function PaperClaims() {
  const navigate = useNavigate();
  const [result, setResult] = useState<Paginated<VoucherSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<Paginated<VoucherSummary>>('/vouchers?entered=true&pageSize=50').then(
      (r) => active && setResult(r),
      (e: unknown) =>
        active && setError(e instanceof ApiError ? e.message : 'Could not load paper claims'),
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Paper claims</h1>
          <p className="muted">
            Claims handed in on paper. Type one in for the employee, attach the scanned form and
            bills, and send it. It then goes through the usual approvals, and the employee can
            follow it in the app.
          </p>
        </div>
        <Link to="/paper-claims/new" className="btn btn-primary">
          <Plus size={16} aria-hidden /> Enter a paper claim
        </Link>
      </div>

      <FormError message={error} />
      <div className="card table-card">
        <table className="table clickable">
          <thead>
            <tr>
              <th>Voucher no.</th>
              <th>Employee</th>
              <th>Purpose</th>
              <th>Expense date</th>
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
                <td>{v.employeeName ?? '—'}</td>
                <td>{v.purpose ?? <span className="muted">No purpose yet</span>}</td>
                <td>{formatDay(v.expenseDate)}</td>
                <td className="num">{formatRupees(v.totalPaise)}</td>
                <td>
                  <VoucherStatus status={v.approvalStatus} />
                </td>
              </tr>
            ))}
            {result && result.data.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No paper claims yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
