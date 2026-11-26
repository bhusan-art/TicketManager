import { formatRupees, type AccountsDashboard } from '@ticketmanager/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, apiGet } from '../lib/api';
import { FormError } from './forms';

const monthLabel = new Intl.DateTimeFormat('en-IN', { month: 'short' });
const shortMonth = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return monthLabel.format(new Date(y!, m! - 1, 1));
};

/** Compact rupees for chart labels: ₹1.2L, ₹45K. */
function compact(paise: number) {
  const r = paise / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(1)}Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(1)}L`;
  if (r >= 1e3) return `₹${Math.round(r / 1e3)}K`;
  return `₹${Math.round(r)}`;
}

/** Accounts' home: what to verify, what to pay, how old the unpaid claims are. */
export function AccountsOverview({ showLinks }: { showLinks: boolean }) {
  const [data, setData] = useState<AccountsDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<AccountsDashboard>('/accounts/dashboard').then(
      (d) => active && setData(d),
      (e: unknown) =>
        active && setError(e instanceof ApiError ? e.message : 'Could not load the dashboard'),
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
    tone?: string;
  }[] = [
    {
      label: 'To verify',
      ...data.toVerify,
      to: '/verification',
      hint: ['claim waiting for Accounts', 'claims waiting for Accounts'],
    },
    {
      label: 'Approved, not paid',
      ...data.awaitingPayment,
      to: '/payments',
      hint: ['claim owed to an employee', 'claims owed to employees'],
      tone: 'warn',
    },
    {
      label: 'Paid this month',
      ...data.paidThisMonth,
      to: '/payments?view=paid',
      hint: ['payment', 'payments'],
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
      tone: data.openAdvances.overdue > 0 ? 'warn' : undefined,
    },
    {
      label: 'Claimed this month',
      ...data.claimedThisMonth,
      to: '/reports',
      hint: ['voucher', 'vouchers'],
    },
  ];
  const peak = Math.max(1, ...data.monthly.flatMap((m) => [m.approvedPaise, m.paidPaise]));
  const owed = Math.max(1, ...data.liabilityAging.map((b) => b.amountPaise));

  return (
    <>
      <div className="stat-grid">
        {cards.map((c) => {
          const body = (
            <>
              <span className="muted small">{c.label}</span>
              <strong>{formatRupees(c.amountPaise)}</strong>
              <span className="muted small">
                {c.count} {c.hint[c.count === 1 ? 0 : 1]}
              </span>
            </>
          );
          return showLinks ? (
            <Link key={c.label} to={c.to} className={`card stat link ${c.tone ?? ''}`}>
              {body}
            </Link>
          ) : (
            <div key={c.label} className={`card stat ${c.tone ?? ''}`}>
              {body}
            </div>
          );
        })}
      </div>

      <div className="detail-grid">
        <div className="card wide">
          <h2>Approved and paid, last 6 months</h2>
          <div className="legend small">
            <span>
              <i className="swatch approved" /> Approved
            </span>
            <span>
              <i className="swatch paid" /> Paid
            </span>
          </div>
          <div className="bars" role="img" aria-label="Approved and paid amounts by month">
            {data.monthly.map((m) => (
              <div key={m.month} className="bar-group">
                <div className="bar-pair">
                  <div
                    className="bar approved"
                    style={{ height: `${(m.approvedPaise / peak) * 100}%` }}
                    title={`Approved ${formatRupees(m.approvedPaise)}`}
                  />
                  <div
                    className="bar paid"
                    style={{ height: `${(m.paidPaise / peak) * 100}%` }}
                    title={`Paid ${formatRupees(m.paidPaise)}`}
                  />
                </div>
                <span className="muted small">{shortMonth(m.month)}</span>
                <span className="small">{compact(m.approvedPaise)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card wide">
          <h2>Unpaid claims by age</h2>
          <p className="muted small">Days since final approval.</p>
          <ul className="aging">
            {data.liabilityAging.map((b) => (
              <li
                key={b.bucket}
                className={b.bucket === '31-60' || b.bucket === '60+' ? 'old' : ''}
              >
                <span>{b.bucket} days</span>
                <span className="aging-track">
                  <span style={{ width: `${(b.amountPaise / owed) * 100}%` }} />
                </span>
                <span className="num">
                  {formatRupees(b.amountPaise)}
                  <span className="muted small"> · {b.count}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
