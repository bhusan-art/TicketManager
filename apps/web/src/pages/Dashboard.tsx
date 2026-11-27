import {
  formatRupees,
  ROLE_LABELS,
  type ApprovalQueueItem,
  type HealthResponse,
  type Paginated,
  type Role,
  type VoucherSummary,
} from '@ticketmanager/shared';
import {
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  FilePen,
  FileStack,
  HandCoins,
  MessageCircleQuestion,
  Plus,
  ShieldCheck,
  Sparkles,
  Timer,
  UserPlus,
  Wallet,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useUser } from '../auth/AuthContext';
import { AccountsOverview } from '../components/AccountsOverview';
import { Donut } from '../components/charts';
import { Kpi } from '../components/Kpi';
import { CHECK_LABELS, SystemStatusCard } from '../components/SystemStatusCard';
import { formatDay, VoucherStatus } from '../components/VoucherStatus';
import { apiGet, getHealth } from '../lib/api';
import { initials } from '../lib/initials';

function greeting(hour: number) {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

const today = new Intl.DateTimeFormat('en-IN', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const ACTIONS: Record<Role, { to: string; label: string; icon: LucideIcon }[]> = {
  employee: [
    { to: '/expenses/new', label: 'New expense', icon: Plus },
    { to: '/advances/new', label: 'Request advance', icon: HandCoins },
  ],
  manager: [
    { to: '/approvals', label: 'Review approvals', icon: ShieldCheck },
    { to: '/advances', label: 'Advances', icon: HandCoins },
  ],
  accounts: [
    { to: '/verification', label: 'Verify claims', icon: ShieldCheck },
    { to: '/payments', label: 'Pay claims', icon: Wallet },
  ],
  director: [
    { to: '/approvals', label: 'Review approvals', icon: ShieldCheck },
    { to: '/reports', label: 'Reports', icon: Sparkles },
  ],
  admin: [
    { to: '/admin/users', label: 'Add a user', icon: UserPlus },
    { to: '/reports', label: 'Reports', icon: Sparkles },
  ],
};

export function Dashboard() {
  const user = useUser();
  const role = user.activeRole;
  const now = new Date();

  return (
    <section className="dashboard">
      <div className="hero">
        <div className="hero-text">
          <span className="hero-chip">
            <Sparkles size={14} aria-hidden /> {ROLE_LABELS[role]} · {today.format(now)}
          </span>
          <h1>
            {greeting(now.getHours())}, <span className="grad-text">{user.name.split(' ')[0]}</span>
          </h1>
          <p className="muted">You are viewing TicketManager as {ROLE_LABELS[role]}.</p>
        </div>
        <div className="hero-actions">
          {ACTIONS[role].map(({ to, label, icon: Icon }, i) => (
            <Link key={to} to={to} className={`btn ${i === 0 ? 'btn-primary' : 'btn-secondary'}`}>
              <Icon size={16} aria-hidden /> {label}
            </Link>
          ))}
        </div>
      </div>

      {role === 'employee' && <EmployeeOverview />}
      {(role === 'manager' || role === 'director') && <ApproverOverview />}
      {['accounts', 'director', 'admin'].includes(role) && (
        <AccountsOverview showLinks={role === 'accounts'} />
      )}
      {role === 'accounts' && <QueuePreview base="/verification" title="Verification queue" />}

      {role === 'admin' ? <SystemStatusCard /> : <ServiceStatus />}
    </section>
  );
}

/** An employee's own claims: counts per status, the mix, and the latest few. */
function EmployeeOverview() {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [recent, setRecent] = useState<VoucherSummary[] | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<Record<string, number>>('/vouchers/counts').then(
      (c) => active && setCounts(c),
      () => {},
    );
    apiGet<Paginated<VoucherSummary>>('/vouchers?pageSize=5').then(
      (r) => active && setRecent(r.data),
      () => active && setRecent([]),
    );
    return () => {
      active = false;
    };
  }, []);

  const n = (k: string) => counts?.[k] ?? 0;
  const slices = [
    { label: 'In progress', value: n('pending'), color: 'var(--c4)' },
    { label: 'Approved', value: n('approved'), color: 'var(--c1)' },
    { label: 'Rejected', value: n('rejected'), color: 'var(--c5)' },
    { label: 'Drafts', value: n('draft'), color: 'var(--quiet)' },
  ];

  return (
    <>
      <div className="kpi-grid">
        <Kpi
          label="All claims"
          value={counts ? n('all') : '…'}
          sub="every claim you've made"
          icon={FileStack}
          tone="c6"
          to="/expenses"
        />
        <Kpi
          label="In progress"
          value={counts ? n('pending') : '…'}
          sub="waiting for a decision"
          icon={Timer}
          tone="c4"
          to="/expenses?status=pending"
        />
        <Kpi
          label="Approved"
          value={counts ? n('approved') : '…'}
          sub="fully or partly"
          icon={CheckCircle2}
          tone="c1"
          to="/expenses?status=approved"
        />
        <Kpi
          label="Rejected"
          value={counts ? n('rejected') : '…'}
          sub="not approved"
          icon={XCircle}
          tone="c5"
          to="/expenses?status=rejected"
        />
        <Kpi
          label="Drafts"
          value={counts ? n('draft') : '…'}
          sub="not sent yet"
          icon={FilePen}
          tone="c2"
          to="/expenses?status=draft"
        />
      </div>

      <div className="dash-grid">
        <section className="panel">
          <header className="panel-head">
            <div>
              <h2>My claims by status</h2>
              <p className="muted small">Every claim you have made</p>
            </div>
          </header>
          {counts && n('all') > 0 ? (
            <Donut
              label="Your claims by status"
              slices={slices}
              format={(v) => String(v)}
              centerLabel="claims"
            />
          ) : (
            <EmptyNote
              text={counts ? 'No claims yet. Your first one takes a minute.' : 'Loading…'}
              to={counts ? '/expenses/new' : undefined}
              cta="New expense"
            />
          )}
        </section>

        <section className="panel span-2">
          <header className="panel-head">
            <div>
              <h2>Recent claims</h2>
              <p className="muted small">Your latest five</p>
            </div>
            <Link to="/expenses" className="panel-link">
              View all <ArrowRight size={14} aria-hidden />
            </Link>
          </header>
          {recent === null ? (
            <p className="empty-note">Loading…</p>
          ) : recent.length === 0 ? (
            <EmptyNote text="Nothing here yet." />
          ) : (
            <ul className="feed">
              {recent.map((v) => (
                <li key={v.id}>
                  <Link to={`/expenses/${v.id}`} className="feed-row">
                    <span className="feed-icon" aria-hidden>
                      <FileStack size={16} />
                    </span>
                    <span className="feed-main">
                      <strong>{v.purpose || v.categories.join(', ') || 'Untitled claim'}</strong>
                      <span className="muted small">
                        {v.number ?? 'Draft'} ·{' '}
                        {formatDay(v.expenseDate ?? v.createdAt.slice(0, 10))}
                      </span>
                    </span>
                    <span className="feed-end">
                      <span className="num">{formatRupees(v.totalPaise)}</span>
                      <VoucherStatus status={v.approvalStatus} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

/** Managers and the Director: what is waiting for them. */
function ApproverOverview() {
  const [counts, setCounts] = useState<{ pending: number; queried: number } | null>(null);
  const [advances, setAdvances] = useState<{ review: number } | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<{ pending: number; queried: number }>('/approvals/counts').then(
      (c) => active && setCounts(c),
      () => {},
    );
    apiGet<{ review: number }>('/advances/counts').then(
      (c) => active && setAdvances(c),
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <div className="kpi-grid three">
        <Kpi
          label="Waiting for you"
          value={counts ? counts.pending : '…'}
          sub="claims to approve"
          icon={ShieldCheck}
          tone="c1"
          to="/approvals"
        />
        <Kpi
          label="Queried"
          value={counts ? counts.queried : '…'}
          sub="waiting for the employee"
          icon={MessageCircleQuestion}
          tone="c3"
          to="/approvals?view=queried"
        />
        <Kpi
          label="Advances to review"
          value={advances ? advances.review : '…'}
          sub="requests for money upfront"
          icon={HandCoins}
          tone="c2"
          to="/advances"
        />
      </div>
      <QueuePreview base="/approvals" title="Waiting for your approval" />
    </>
  );
}

/** The first few claims in a review queue. */
function QueuePreview({ base, title }: { base: string; title: string }) {
  const [items, setItems] = useState<ApprovalQueueItem[] | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<Paginated<ApprovalQueueItem>>('/approvals?view=pending&pageSize=5').then(
      (r) => active && setItems(r.data),
      () => active && setItems([]),
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="panel queue-panel">
      <header className="panel-head">
        <div>
          <h2>{title}</h2>
          <p className="muted small">Oldest first</p>
        </div>
        <Link to={base} className="panel-link">
          Open queue <ArrowRight size={14} aria-hidden />
        </Link>
      </header>
      {items === null ? (
        <p className="empty-note">Loading…</p>
      ) : items.length === 0 ? (
        <EmptyNote text="All caught up. Nothing is waiting." icon={CheckCircle2} />
      ) : (
        <ul className="feed">
          {items.map((v) => (
            <li key={v.id}>
              <Link to={`${base}/${v.id}`} className="feed-row">
                <span className="avatar-sm tone-4" aria-hidden>
                  {initials(v.employee.name)}
                </span>
                <span className="feed-main">
                  <strong>{v.employee.name}</strong>
                  <span className="muted small">
                    {v.number} · {v.purpose || v.categories.join(', ')}
                    {v.department ? ` · ${v.department.name}` : ''}
                  </span>
                </span>
                <span className="feed-end">
                  <span className="num">{formatRupees(v.totalPaise)}</span>
                  <VoucherStatus status={v.approvalStatus} reviewStarted={v.reviewStarted} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EmptyNote({
  text,
  to,
  cta,
  icon: Icon = CircleDashed,
}: {
  text: string;
  to?: string;
  cta?: string;
  icon?: LucideIcon;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden>
        <Icon size={22} />
      </span>
      <p>{text}</p>
      {to && cta && (
        <Link to={to} className="btn btn-secondary btn-sm">
          {cta}
        </Link>
      )}
    </div>
  );
}

type Health =
  | { kind: 'loading' }
  | { kind: 'loaded'; health: HealthResponse }
  | { kind: 'error'; message: string };

/** Services at a glance for everyone but admins (who get the full system card). */
function ServiceStatus() {
  const [state, setState] = useState<Health>({ kind: 'loading' });
  useEffect(() => {
    let active = true;
    getHealth<HealthResponse>()
      .then((health) => active && setState({ kind: 'loaded', health }))
      .catch((err: Error) => active && setState({ kind: 'error', message: err.message }));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="card status-card" aria-live="polite">
      <h2>System status</h2>
      {state.kind === 'loading' && <p>Checking services…</p>}
      {state.kind === 'error' && <p className="status down">API unreachable: {state.message}</p>}
      {state.kind === 'loaded' && (
        <>
          <p className={`status ${state.health.status === 'ok' ? 'up' : 'down'}`}>
            {state.health.status === 'ok' ? 'All services up' : 'Some services are down'} · API v
            {state.health.version}
          </p>
          <ul className="checks">
            {Object.entries(state.health.checks).map(([name, status]) => (
              <li key={name}>
                <span>{CHECK_LABELS[name] ?? name}</span>
                <span className={`pill ${status}`}>{status === 'up' ? 'Up' : 'Down'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
