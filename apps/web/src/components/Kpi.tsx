import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

/** A headline number: icon, label, the figure, and one line under it. A link when `to` is set. */
export function Kpi({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'c1',
  to,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon: LucideIcon;
  /** c1–c6 (series colours) or warn / bad. */
  tone?: string;
  to?: string;
}) {
  const body = (
    <>
      <span className="kpi-icon" aria-hidden>
        <Icon size={20} />
      </span>
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      {sub !== undefined && <span className="kpi-sub">{sub}</span>}
    </>
  );
  return to ? (
    <Link to={to} className={`kpi tone-${tone} link`}>
      {body}
    </Link>
  ) : (
    <div className={`kpi tone-${tone}`}>{body}</div>
  );
}
