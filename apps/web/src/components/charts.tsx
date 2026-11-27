import { useState, type ReactNode } from 'react';

/** Series colours from styles.css, in a fixed order. Each entity keeps its slot. */
export const SERIES = [
  'var(--c1)',
  'var(--c2)',
  'var(--c3)',
  'var(--c4)',
  'var(--c5)',
  'var(--c6)',
];

/** Compact rupees for chart labels: ₹1.2Cr, ₹3.4L, ₹45K. */
export function compactRupees(paise: number) {
  const r = paise / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(1)}Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(1)}L`;
  if (r >= 1e3) return `₹${Math.round(r / 1e3)}K`;
  return `₹${Math.round(r)}`;
}

export interface Slice {
  label: string;
  value: number;
  color: string;
}

/**
 * A donut with its legend. Hovering (or focusing) a slice or its legend row shows that slice in
 * the middle; otherwise the middle shows the total.
 */
export function Donut({
  slices,
  format,
  centerLabel,
  label,
}: {
  slices: Slice[];
  format: (n: number) => string;
  centerLabel: string;
  label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = slices.reduce((s, x) => s + x.value, 0);
  const r = 42;
  const c = 2 * Math.PI * r;
  const gap = slices.filter((s) => s.value > 0).length > 1 ? 1.6 : 0;
  let offset = 0;
  const shown = hover === null ? null : slices[hover];

  return (
    <div className="donut">
      <div className="donut-figure">
        <svg viewBox="0 0 100 100" role="img" aria-label={label}>
          <circle cx="50" cy="50" r={r} className="donut-track" />
          {total > 0 &&
            slices.map((s, i) => {
              const len = (s.value / total) * c;
              const dash = Math.max(0, len - gap);
              const el = (
                <circle
                  key={s.label}
                  cx="50"
                  cy="50"
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={hover === i ? 13 : 10}
                  strokeDasharray={`${dash} ${c - dash}`}
                  strokeDashoffset={-offset}
                  strokeLinecap="butt"
                  transform="rotate(-90 50 50)"
                  className={`donut-slice${hover !== null && hover !== i ? ' dim' : ''}`}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                >
                  <title>{`${s.label}: ${format(s.value)}`}</title>
                </circle>
              );
              offset += len;
              return el;
            })}
        </svg>
        <div className="donut-center">
          <strong>{format(shown ? shown.value : total)}</strong>
          <span>{shown ? shown.label : centerLabel}</span>
        </div>
      </div>
      <ul className="donut-legend">
        {slices.map((s, i) => (
          <li
            key={s.label}
            className={hover === i ? 'on' : ''}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <i style={{ background: s.color }} aria-hidden />
            <span className="donut-name">{s.label}</span>
            <span className="num">{format(s.value)}</span>
            <span className="muted small num">
              {total > 0 ? Math.round((s.value / total) * 100) : 0}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface ColumnSeries {
  name: string;
  color: string;
}

/**
 * Grouped columns over time, one axis. Hover a group for its numbers. Each group's values are
 * in the same order as `series`.
 */
export function Columns({
  groups,
  series,
  format,
  label,
}: {
  groups: { label: string; values: number[] }[];
  series: ColumnSeries[];
  format: (n: number) => string;
  label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (groups.every((g) => g.values.every((v) => v === 0))) {
    return <p className="empty-note chart-empty">Nothing approved or paid in these months yet.</p>;
  }
  const W = 600;
  const H = 220;
  const pad = { top: 12, right: 8, bottom: 26, left: 52 };
  const peak = Math.max(1, ...groups.flatMap((g) => g.values));
  const step = niceStep(peak / 4);
  const top = Math.ceil(peak / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const band = plotW / Math.max(1, groups.length);
  const barW = Math.min(22, (band * 0.62) / series.length);
  const y = (v: number) => pad.top + plotH - (v / top) * plotH;

  return (
    <div className="columns">
      <div className="chart-legend small">
        {series.map((s) => (
          <span key={s.name}>
            <i style={{ background: s.color }} aria-hidden /> {s.name}
          </span>
        ))}
      </div>
      <div className="columns-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} className="grid-line" />
              <text x={pad.left - 8} y={y(t) + 4} className="axis-text" textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          {groups.map((g, gi) => {
            const x0 = pad.left + gi * band + (band - barW * series.length - 2) / 2;
            return (
              <g
                key={g.label}
                onMouseEnter={() => setHover(gi)}
                onMouseLeave={() => setHover(null)}
              >
                <rect
                  x={pad.left + gi * band}
                  y={pad.top}
                  width={band}
                  height={plotH}
                  className={`hover-band${hover === gi ? ' on' : ''}`}
                />
                {g.values.map((v, si) => {
                  const h = Math.max(v > 0 ? 2 : 0, y(0) - y(v));
                  return (
                    <path
                      key={si}
                      d={roundedTop(x0 + si * (barW + 2), y(0) - h, barW, h, Math.min(4, barW / 2))}
                      fill={series[si]!.color}
                      className="column"
                    />
                  );
                })}
                <text
                  x={pad.left + gi * band + band / 2}
                  y={H - 8}
                  className="axis-text"
                  textAnchor="middle"
                >
                  {g.label}
                </text>
              </g>
            );
          })}
          <line x1={pad.left} x2={W - pad.right} y1={y(0)} y2={y(0)} className="base-line" />
        </svg>
        {hover !== null && (
          <div
            className="chart-tip"
            style={{
              left: `${((pad.left + hover * band + band / 2) / W) * 100}%`,
            }}
          >
            <strong>{groups[hover]!.label}</strong>
            {series.map((s, si) => (
              <span key={s.name}>
                <i style={{ background: s.color }} aria-hidden /> {s.name}{' '}
                <b>{format(groups[hover]!.values[si] ?? 0)}</b>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function niceStep(raw: number) {
  if (raw <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  if (h <= 0) return '';
  const rr = Math.min(r, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** A progress ring with a number in the middle. */
export function Ring({
  value,
  max,
  color = 'var(--c1)',
  children,
  label,
}: {
  value: number;
  max: number;
  color?: string;
  children: ReactNode;
  label: string;
}) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const part = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className="ring">
      <svg viewBox="0 0 100 100" role="img" aria-label={label}>
        <circle cx="50" cy="50" r={r} className="donut-track" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${part * c} ${c}`}
          transform="rotate(-90 50 50)"
          className="ring-value"
        />
      </svg>
      <div className="donut-center">{children}</div>
    </div>
  );
}

/** Horizontal bars, one per row, scaled to the largest. */
export function HBars({
  rows,
  format,
  color = 'var(--c1)',
}: {
  rows: { label: ReactNode; value: number; sub?: ReactNode; key: string; color?: string }[];
  format: (n: number) => string;
  color?: string;
}) {
  const peak = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="hbars">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="hbar-head">
            <span className="hbar-label">{r.label}</span>
            <span className="num">
              {format(r.value)}
              {r.sub !== undefined && r.sub !== '' && (
                <span className="muted small"> · {r.sub}</span>
              )}
            </span>
          </div>
          <span className="hbar-track">
            <span
              style={{ width: `${(r.value / peak) * 100}%`, background: r.color ?? color }}
              title={format(r.value)}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}
