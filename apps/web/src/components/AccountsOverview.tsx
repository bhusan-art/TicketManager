import { formatRupees, type AccountsDashboard, type ReportResponse } from '@ticketmanager/shared';
import {
  BadgeCheck,
  CalendarClock,
  FileCheck2,
  HandCoins,
  ReceiptIndianRupee,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, apiGet } from '../lib/api';
import { initials } from '../lib/initials';
import { Columns, compactRupees, Donut, HBars, Ring, SERIES } from './charts';
import { FormError } from './forms';
import { Kpi } from './Kpi';

const monthLabel = new Intl.DateTimeFormat('en-IN', { month: 'short' });
const shortMonth = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return monthLabel.format(new Date(y!, m! - 1, 1));
};

/** First day of the month five months back: the same six months as the monthly chart. */
function sixMonthsAgo() {
  const d = new Date();
  const start = new Date(d.getFullYear(), d.getMonth() - 5, 1);
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`;
}

/** Most categories get their own colour; the rest fold into "Other". */
const TOP_CATEGORIES = 5;

/** Accounts' home: what to verify, what to pay, how old the unpaid claims are, where money goes. */
export function AccountsOverview({ showLinks }: { showLinks: boolean }) {
  const [data, setData] = useState<AccountsDashboard | null>(null);
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<AccountsDashboard>('/accounts/dashboard').then(
      (d) => active && setData(d),
      (e: unknown) =>
        active && setError(e instanceof ApiError ? e.message : 'Could not load the dashboard'),
    );
    // The spend breakdowns are extra: the dashboard still works without them.
    apiGet<ReportResponse>(`/reports?from=${sixMonthsAgo()}`).then(
      (r) => active && setReport(r),
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);

  if (error) return <FormError message={error} />;
  if (!data) return <p className="page-loading">Loading…</p>;

  const cards: {
    label: string;
    count: number;
    amountPaise: number;
    to: string;
    hint: [string, string];
    icon: LucideIcon;
    tone: string;
  }[] = [
    {
      label: 'To verify',
      ...data.toVerify,
      to: '/verification',
      hint: ['claim waiting for Accounts', 'claims waiting for Accounts'],
      icon: FileCheck2,
      tone: 'c4',
    },
    {
      label: 'Approved, not paid',
      ...data.awaitingPayment,
      to: '/payments',
      hint: ['claim owed to an employee', 'claims owed to employees'],
      icon: CalendarClock,
      tone: 'c3',
    },
    {
      label: 'Paid this month',
      ...data.paidThisMonth,
      to: '/payments?view=paid',
      hint: ['payment', 'payments'],
      icon: BadgeCheck,
      tone: 'c1',
    },
    {
      label: 'Open advances',
      count: data.openAdvances.count,
      amountPaise: data.openAdvances.amountPaise,
      to: '/settlements',
      hint:
        data.openAdvances.overdue > 0
          ? [
              `open, ${data.openAdvances.overdue} overdue`,
              `open, ${data.openAdvances.overdue} overdue`,
            ]
          : ['advance not yet settled', 'advances not yet settled'],
      icon: HandCoins,
      tone: data.openAdvances.overdue > 0 ? 'warn' : 'c2',
    },
    {
      label: 'Claimed this month',
      ...data.claimedThisMonth,
      to: '/reports',
      hint: ['voucher', 'vouchers'],
      icon: ReceiptIndianRupee,
      tone: 'c6',
    },
  ];

  const sixMonthApproved = data.monthly.reduce((s, m) => s + m.approvedPaise, 0);
  const sixMonthPaid = data.monthly.reduce((s, m) => s + m.paidPaise, 0);

  const categories = [...(report?.byCategory ?? [])].sort(
    (a, b) => b.claimedPaise - a.claimedPaise,
  );
  const slices = categories.slice(0, TOP_CATEGORIES).map((c, i) => ({
    label: c.key?.name ?? 'Uncategorised',
    value: c.claimedPaise,
    color: SERIES[i]!,
  }));
  const rest = categories.slice(TOP_CATEGORIES).reduce((s, c) => s + c.claimedPaise, 0);
  if (rest > 0) slices.push({ label: 'Other', value: rest, color: 'var(--quiet)' });

  const departments = [...(report?.byDepartment ?? [])]
    .sort((a, b) => b.claimedPaise - a.claimedPaise)
    .slice(0, 6);
  const employees = [...(report?.byEmployee ?? [])]
    .sort((a, b) => b.claimedPaise - a.claimedPaise)
    .slice(0, 5);
  const agingTone: Record<string, string> = {
    '0-7': 'var(--c1)',
    '8-30': 'var(--c4)',
    '31-60': 'var(--warn-strong)',
    '60+': 'var(--danger)',
  };

  return (
    <>
      <div className="kpi-grid">
        {cards.map((c) => (
          <Kpi
            key={c.label}
            label={c.label}
            value={formatRupees(c.amountPaise)}
            sub={`${c.count} ${c.hint[c.count === 1 ? 0 : 1]}`}
            icon={c.icon}
            tone={c.tone}
            to={showLinks ? c.to : undefined}
          />
        ))}
      </div>

      <div className="dash-grid">
        <section className="panel span-2">
          <header className="panel-head">
            <div>
              <h2>Approved and paid, last 6 months</h2>
              <p className="muted small">
                {formatRupees(sixMonthApproved)} approved · {formatRupees(sixMonthPaid)} paid
              </p>
            </div>
          </header>
          <Columns
            label="Approved and paid amounts by month"
            series={[
              { name: 'Approved', color: 'var(--c2)' },
              { name: 'Paid', color: 'var(--c1)' },
            ]}
            groups={data.monthly.map((m) => ({
              label: shortMonth(m.month),
              values: [m.approvedPaise, m.paidPaise],
            }))}
            format={compactRupees}
          />
        </section>

        <section className="panel">
          <header className="panel-head">
            <div>
              <h2>Spend by category</h2>
              <p className="muted small">Claimed, last 6 months</p>
            </div>
            {showLinks && (
              <Link to="/reports" className="panel-link">
                Reports
              </Link>
            )}
          </header>
          {slices.length > 0 ? (
            <Donut
              label="Claimed amount by category"
              slices={slices}
              format={compactRupees}
              centerLabel="Total claimed"
            />
          ) : (
            <p className="empty-note">{report ? 'No claims in the last 6 months.' : 'Loading…'}</p>
          )}
        </section>

        <section className="panel">
          <header className="panel-head">
            <div>
              <h2>Unpaid claims by age</h2>
              <p className="muted small">Days since final approval.</p>
            </div>
          </header>
          <HBars
            format={formatRupees}
            rows={data.liabilityAging.map((b) => ({
              key: b.bucket,
              label: `${b.bucket} days`,
              value: b.amountPaise,
              sub: `${b.count} ${b.count === 1 ? 'claim' : 'claims'}`,
              color: agingTone[b.bucket],
            }))}
          />
        </section>

        <section className="panel">
          <header className="panel-head">
            <div>
              <h2>Advances</h2>
              <p className="muted small">Paid out, not yet settled</p>
            </div>
          </header>
          <div className="ring-row">
            <Ring
              label={`${data.openAdvances.overdue} of ${data.openAdvances.count} open advances overdue`}
              value={data.openAdvances.count - data.openAdvances.overdue}
              max={data.openAdvances.count}
              color={data.openAdvances.overdue > 0 ? 'var(--warn-strong)' : 'var(--c1)'}
            >
              <strong>{data.openAdvances.count}</strong>
              <span>open</span>
            </Ring>
            <dl className="ring-facts">
              <div>
                <dt>Outstanding</dt>
                <dd>{formatRupees(data.openAdvances.amountPaise)}</dd>
              </div>
              <div>
                <dt>On time</dt>
                <dd>{data.openAdvances.count - data.openAdvances.overdue}</dd>
              </div>
              <div className={data.openAdvances.overdue > 0 ? 'bad' : ''}>
                <dt>Overdue</dt>
                <dd>{data.openAdvances.overdue}</dd>
              </div>
            </dl>
          </div>
        </section>

        {departments.length > 0 && (
          <section className="panel">
            <header className="panel-head">
              <div>
                <h2>By department</h2>
                <p className="muted small">Claimed, last 6 months</p>
              </div>
            </header>
            <HBars
              format={compactRupees}
              color="var(--c4)"
              rows={departments.map((d) => ({
                key: d.key?.id ?? 'none',
                label: d.key?.name ?? 'No department',
                value: d.claimedPaise,
                sub: `${d.vouchers} ${d.vouchers === 1 ? 'claim' : 'claims'}`,
              }))}
            />
          </section>
        )}

        {employees.length > 0 && (
          <section className="panel">
            <header className="panel-head">
              <div>
                <h2>Top claimants</h2>
                <p className="muted small">Claimed, last 6 months</p>
              </div>
            </header>
            <ul className="people">
              {employees.map((e, i) => (
                <li key={e.key?.id ?? i}>
                  <span className={`avatar-sm tone-${(i % 6) + 1}`} aria-hidden>
                    {initials(e.key?.name ?? '?')}
                  </span>
                  <span className="people-name">
                    <strong>{e.key?.name ?? 'Unknown'}</strong>
                    <span className="muted small">
                      {e.department ?? 'No department'} · {e.vouchers}{' '}
                      {e.vouchers === 1 ? 'claim' : 'claims'}
                    </span>
                  </span>
                  <span className="num">{compactRupees(e.claimedPaise)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
