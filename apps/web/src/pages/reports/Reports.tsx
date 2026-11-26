import {
  APPROVAL_STATUS_LABELS,
  formatRupees,
  type LiabilityRow,
  type Ref,
  type ReportResponse,
} from '@ticketmanager/shared';
import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useUser } from '../../auth/AuthContext';
import { Field, FormError } from '../../components/forms';
import { ProjectSelect, useProjects } from '../../components/ProjectFilter';
import { PaymentStatusPill, formatWhen } from '../../components/VoucherStatus';
import { ApiError, apiGet } from '../../lib/api';
import { csvRupees, downloadCsv, toCsv } from '../../lib/csv';

type Tab = 'department' | 'project' | 'employee' | 'category' | 'liability';

const TABS: { key: Tab; label: string }[] = [
  { key: 'department', label: 'By department' },
  { key: 'project', label: 'By project' },
  { key: 'employee', label: 'By employee' },
  { key: 'category', label: 'By category' },
  { key: 'liability', label: 'Approved, not paid' },
];

/** One row of the department or employee table, ready for the screen and for CSV. */
type MoneyRow = ReportResponse['byDepartment'][number];

const MONEY_HEAD = [
  'Vouchers',
  'Claimed',
  'In review',
  'Rejected',
  'Approved',
  'Paid',
  'Outstanding',
];
const moneyCsv = (r: MoneyRow) => [
  r.vouchers,
  csvRupees(r.claimedPaise),
  csvRupees(r.inReviewPaise),
  csvRupees(r.rejectedPaise),
  csvRupees(r.approvedPaise),
  csvRupees(r.paidPaise),
  csvRupees(r.outstandingPaise),
];

function MoneyCells({ r }: { r: Omit<MoneyRow, 'key'> }) {
  return (
    <>
      <td className="num">{r.vouchers}</td>
      <td className="num">{formatRupees(r.claimedPaise)}</td>
      <td className="num">{formatRupees(r.inReviewPaise)}</td>
      <td className="num">{formatRupees(r.rejectedPaise)}</td>
      <td className="num">{formatRupees(r.approvedPaise)}</td>
      <td className="num">{formatRupees(r.paidPaise)}</td>
      <td className="num">
        <strong>{formatRupees(r.outstandingPaise)}</strong>
      </td>
    </>
  );
}

/** Spend by department, employee and category, and what is approved but still unpaid. */
export function Reports() {
  const user = useUser();
  const canOpen = user.activeRole === 'accounts' || user.activeRole === 'director';
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'department') as Tab;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const departmentId = params.get('departmentId') ?? '';
  const projectId = params.get('projectId') ?? '';
  const projects = useProjects();
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [liability, setLiability] = useState<LiabilityRow[] | null>(null);
  const [departments, setDepartments] = useState<Ref[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ data: Ref[] }>('/reports/departments').then(
      (r) => setDepartments(r.data),
      () => {},
    );
  }, []);

  useEffect(() => {
    let active = true;
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (departmentId) q.set('departmentId', departmentId);
    if (projectId) q.set('projectId', projectId);
    const fail = (e: unknown) =>
      active && setError(e instanceof ApiError ? e.message : 'Could not load the report');
    apiGet<ReportResponse>(`/reports?${q}`).then((r) => {
      if (!active) return;
      setReport(r);
      setError(null);
    }, fail);
    const lq = new URLSearchParams();
    if (departmentId) lq.set('departmentId', departmentId);
    if (projectId) lq.set('projectId', projectId);
    apiGet<{ data: LiabilityRow[] }>(`/reports/liability?${lq}`).then(
      (r) => active && setLiability(r.data),
      fail,
    );
    return () => {
      active = false;
    };
  }, [from, to, departmentId, projectId]);

  function set(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value && !(key === 'tab' && value === 'department')) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  function exportCsv() {
    if (!report || !liability) return;
    const range = [from || 'start', to || 'today'].join('_to_');
    if (tab === 'department') {
      downloadCsv(
        `spend-by-department-${range}.csv`,
        toCsv(
          ['Department', ...MONEY_HEAD],
          report.byDepartment.map((r) => [r.key?.name ?? 'No department', ...moneyCsv(r)]),
        ),
      );
    } else if (tab === 'project') {
      downloadCsv(
        `spend-by-project-${range}.csv`,
        toCsv(
          ['Project', 'Code', 'Employees', ...MONEY_HEAD],
          report.byProject.map((r) => [
            r.key?.name ?? 'No project',
            r.code,
            r.employees,
            ...moneyCsv(r),
          ]),
        ),
      );
    } else if (tab === 'employee') {
      downloadCsv(
        `spend-by-employee-${range}.csv`,
        toCsv(
          ['Employee', 'Employee code', 'Department', ...MONEY_HEAD],
          report.byEmployee.map((r) => [r.key?.name, r.employeeCode, r.department, ...moneyCsv(r)]),
        ),
      );
    } else if (tab === 'category') {
      downloadCsv(
        `spend-by-category-${range}.csv`,
        toCsv(
          ['Category', 'Vouchers', 'Claimed', 'Approved'],
          report.byCategory.map((r) => [
            r.key?.name ?? 'No category',
            r.vouchers,
            csvRupees(r.claimedPaise),
            csvRupees(r.approvedPaise),
          ]),
        ),
      );
    } else {
      downloadCsv(
        `approved-not-paid.csv`,
        toCsv(
          [
            'Voucher',
            'Employee',
            'Department',
            'Approval',
            'Approved on',
            'Days waiting',
            'Approved',
            'Paid',
            'Outstanding',
          ],
          liability.map((r) => [
            r.number,
            r.employee.name,
            r.department?.name,
            APPROVAL_STATUS_LABELS[r.approvalStatus],
            r.decidedAt?.slice(0, 10),
            r.ageDays,
            csvRupees(r.approvedPaise),
            csvRupees(r.paidPaise),
            csvRupees(r.outstandingPaise),
          ]),
        ),
      );
    }
  }

  const t = report?.totals;
  const owed = liability?.reduce((s, r) => s + r.outstandingPaise, 0) ?? 0;
  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p className="muted">
            Claims by submission date. Cancelled claims and drafts are left out.
          </p>
        </div>
        <div className="actions">
          <button
            className="btn btn-secondary"
            disabled={!report || !liability}
            onClick={exportCsv}
          >
            <Download size={16} aria-hidden /> Download CSV
          </button>
        </div>
      </div>

      <div className="filters report-filters">
        <Field label="From">
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => set('from', e.target.value)}
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => set('to', e.target.value)}
          />
        </Field>
        <Field label="Project">
          <ProjectSelect
            projects={projects}
            value={projectId}
            onChange={(v) => set('projectId', v)}
          />
        </Field>
        <Field label="Department">
          <select value={departmentId} onChange={(e) => set('departmentId', e.target.value)}>
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <FormError message={error} />

      {t && (
        <div className="stat-grid">
          <div className="card stat">
            <span className="muted small">Claimed</span>
            <strong>{formatRupees(t.claimedPaise)}</strong>
            <span className="muted small">{t.vouchers} vouchers</span>
          </div>
          <div className="card stat">
            <span className="muted small">Approved</span>
            <strong>{formatRupees(t.approvedPaise)}</strong>
            <span className="muted small">{formatRupees(t.inReviewPaise)} still in review</span>
          </div>
          <div className="card stat">
            <span className="muted small">Paid</span>
            <strong>{formatRupees(t.paidPaise)}</strong>
            <span className="muted small">{formatRupees(t.rejectedPaise)} rejected</span>
          </div>
          <div className="card stat warn">
            <span className="muted small">Approved, not paid</span>
            <strong>{formatRupees(t.outstandingPaise)}</strong>
            <span className="muted small">in this period</span>
          </div>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Report">
        {TABS.map((x) => (
          <button
            key={x.key}
            role="tab"
            aria-selected={tab === x.key}
            className={`tab${tab === x.key ? ' active' : ''}`}
            onClick={() => set('tab', x.key)}
          >
            {x.label}
          </button>
        ))}
      </div>

      <div className="card table-card">
        {report && tab === 'department' && (
          <table className="table">
            <thead>
              <tr>
                <th>Department</th>
                {MONEY_HEAD.map((h) => (
                  <th key={h} className="num">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.byDepartment.map((r) => (
                <tr key={r.key?.id ?? 'none'}>
                  <td>{r.key?.name ?? <span className="muted">No department</span>}</td>
                  <MoneyCells r={r} />
                </tr>
              ))}
              {report.byDepartment.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">
                    No claims in this period.
                  </td>
                </tr>
              )}
            </tbody>
            {report.byDepartment.length > 0 && (
              <tfoot>
                <tr>
                  <td>Total</td>
                  <MoneyCells r={report.totals} />
                </tr>
              </tfoot>
            )}
          </table>
        )}

        {report && tab === 'project' && (
          <table className="table">
            <thead>
              <tr>
                <th>Project</th>
                <th className="num">People</th>
                {MONEY_HEAD.map((h) => (
                  <th key={h} className="num">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.byProject.map((r) => (
                <tr key={r.key?.id ?? 'none'}>
                  <td>
                    {r.key ? (
                      <>
                        {r.key.name}
                        {r.code && <div className="muted small">{r.code}</div>}
                      </>
                    ) : (
                      <span className="muted">No project</span>
                    )}
                  </td>
                  <td className="num">{r.employees}</td>
                  <MoneyCells r={r} />
                </tr>
              ))}
              {report.byProject.length === 0 && (
                <tr>
                  <td colSpan={9} className="empty">
                    No claims in this period.
                  </td>
                </tr>
              )}
            </tbody>
            {report.byProject.length > 0 && (
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td />
                  <MoneyCells r={report.totals} />
                </tr>
              </tfoot>
            )}
          </table>
        )}

        {report && tab === 'employee' && (
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                {MONEY_HEAD.map((h) => (
                  <th key={h} className="num">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.byEmployee.map((r) => (
                <tr key={r.key?.id}>
                  <td>
                    {r.key?.name}
                    <div className="muted small">
                      {[r.employeeCode, r.department].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <MoneyCells r={r} />
                </tr>
              ))}
              {report.byEmployee.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">
                    No claims in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {report && tab === 'category' && (
          <table className="table">
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Vouchers</th>
                <th className="num">Claimed</th>
                <th className="num">Approved</th>
              </tr>
            </thead>
            <tbody>
              {report.byCategory.map((r) => (
                <tr key={r.key?.id ?? 'none'}>
                  <td>{r.key?.name ?? <span className="muted">No category</span>}</td>
                  <td className="num">{r.vouchers}</td>
                  <td className="num">{formatRupees(r.claimedPaise)}</td>
                  <td className="num">{formatRupees(r.approvedPaise)}</td>
                </tr>
              ))}
              {report.byCategory.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No claims in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {liability && tab === 'liability' && (
          <table className="table">
            <thead>
              <tr>
                <th>Voucher no.</th>
                <th>Employee</th>
                <th>Approved on</th>
                <th className="num">Days waiting</th>
                <th className="num">Approved</th>
                <th className="num">Paid</th>
                <th className="num">Outstanding</th>
                <th>Payment</th>
              </tr>
            </thead>
            <tbody>
              {liability.map((r) => (
                <tr key={r.id}>
                  <td>{canOpen ? <Link to={`/payments/${r.id}`}>{r.number}</Link> : r.number}</td>
                  <td>
                    {r.employee.name}
                    {r.department && <div className="muted small">{r.department.name}</div>}
                  </td>
                  <td>{formatWhen(r.decidedAt)}</td>
                  <td className={`num${r.ageDays > 30 ? ' owed' : ''}`}>{r.ageDays}</td>
                  <td className="num">{formatRupees(r.approvedPaise)}</td>
                  <td className="num">{formatRupees(r.paidPaise)}</td>
                  <td className="num">
                    <strong>{formatRupees(r.outstandingPaise)}</strong>
                  </td>
                  <td>
                    <PaymentStatusPill status={r.paymentStatus} />
                  </td>
                </tr>
              ))}
              {liability.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">
                    Every approved claim is paid.
                  </td>
                </tr>
              )}
            </tbody>
            {liability.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={6}>Owed to employees today (all dates)</td>
                  <td className="num">{formatRupees(owed)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>
    </section>
  );
}
