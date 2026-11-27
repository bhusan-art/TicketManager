import {
  formatRupees,
  type AdvanceStatus,
  type ApprovalStatus,
  type SearchHit,
  type SearchResponse,
} from '@ticketmanager/shared';
import { FileText, HandCoins, Search as SearchIcon, User, X, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { apiGet } from '../lib/api';
import { AdvanceStatusPill, VoucherStatus } from './VoucherStatus';

export interface SearchPage {
  to: string;
  label: string;
  icon: LucideIcon;
}

interface Row {
  key: string;
  group: string;
  path: string;
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  end?: React.ReactNode;
}

const MIN = 2;

/**
 * The search box in the top bar. Finds pages by name straight away, and claims, advances and
 * (for admins) people from the server as you type. Arrow keys move, Enter opens, Escape closes.
 * Press "/" anywhere to jump to it.
 */
export function GlobalSearch({
  pages,
  onDone,
  autoFocus = false,
}: {
  pages: SearchPage[];
  onDone?: () => void;
  autoFocus?: boolean;
}) {
  const navigate = useNavigate();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<{ q: string; data: SearchResponse } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const term = q.trim();

  // Ask the server a moment after typing stops.
  useEffect(() => {
    if (term.length < MIN) return;
    let live = true;
    const timer = setTimeout(() => {
      apiGet<SearchResponse>(`/search?q=${encodeURIComponent(term)}`).then(
        (data) => {
          if (!live) return;
          setResult({ q: term, data });
          setFailed(null);
        },
        () => live && setFailed(term),
      );
    }, 220);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [term]);

  // "/" focuses the box, like most apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key !== '/' || el.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Close when clicking elsewhere.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    if (term.length < MIN) return [];
    const lower = term.toLowerCase();
    const out: Row[] = pages
      .filter((p) => p.label.toLowerCase().includes(lower))
      .slice(0, 4)
      .map((p) => ({
        key: `page-${p.to}`,
        group: 'Pages',
        path: p.to,
        title: p.label,
        icon: p.icon,
      }));
    const data = result?.q === term ? result.data : null;
    if (data) {
      const add = (
        group: string,
        icon: LucideIcon,
        hits: SearchHit[],
        pill?: (s: string) => React.ReactNode,
      ) =>
        hits.forEach((h) =>
          out.push({
            key: `${group}-${h.id}`,
            group,
            path: h.path,
            title: h.title,
            subtitle: h.subtitle,
            icon,
            end: (
              <>
                {h.amountPaise !== undefined && (
                  <span className="num">{formatRupees(h.amountPaise)}</span>
                )}
                {h.status && pill?.(h.status)}
              </>
            ),
          }),
        );
      add('Claims', FileText, data.claims, (s) => <VoucherStatus status={s as ApprovalStatus} />);
      add('Advances', HandCoins, data.advances, (s) => (
        <AdvanceStatusPill status={s as AdvanceStatus} />
      ));
      add('People', User, data.people);
    }
    return out;
  }, [term, pages, result]);

  const waiting = term.length >= MIN && result?.q !== term && failed !== term;
  const current = Math.min(active, Math.max(0, rows.length - 1));

  function go(row: Row | undefined) {
    if (!row) return;
    navigate(row.path);
    setQ('');
    setOpen(false);
    input.current?.blur();
    onDone?.();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (rows.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((current + step + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(rows[current]);
    } else if (e.key === 'Escape') {
      if (q) setQ('');
      else {
        setOpen(false);
        input.current?.blur();
        onDone?.();
      }
    }
  }

  const showList = open && term.length >= MIN;

  return (
    <div className="global-search" ref={box}>
      <SearchIcon size={16} className="global-search-icon" aria-hidden />
      <input
        ref={input}
        className="search"
        type="search"
        placeholder="Search claims, advances, pages…"
        aria-label="Search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && rows[current] ? `${listId}-${current}` : undefined}
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {q ? (
        <button
          type="button"
          className="global-search-clear"
          aria-label="Clear search"
          onClick={() => {
            setQ('');
            input.current?.focus();
          }}
        >
          <X size={14} aria-hidden />
        </button>
      ) : (
        <kbd className="global-search-key" aria-hidden>
          /
        </kbd>
      )}
      {showList && (
        <div className="search-results">
          <ul id={listId} role="listbox" aria-label="Search results">
            {rows.map((row, i) => {
              const head = i === 0 || rows[i - 1]!.group !== row.group;
              const Icon = row.icon;
              return (
                <li key={row.key} role="presentation">
                  {head && <div className="search-group">{row.group}</div>}
                  <div
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === current}
                    className={`search-row${i === current ? ' on' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => go(row)}
                  >
                    <span className="search-row-icon" aria-hidden>
                      <Icon size={16} />
                    </span>
                    <span className="search-row-main">
                      <strong>{row.title}</strong>
                      {row.subtitle && <span className="muted small">{row.subtitle}</span>}
                    </span>
                    {row.end && <span className="search-row-end">{row.end}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
          {waiting && <p className="search-note">Searching…</p>}
          {failed === term && <p className="search-note">Search isn&apos;t available right now.</p>}
          {!waiting && failed !== term && rows.length === 0 && (
            <p className="search-note">Nothing matches “{term}”.</p>
          )}
        </div>
      )}
    </div>
  );
}
