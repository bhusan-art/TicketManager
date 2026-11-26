import type { AuditEntry, AuditFacets, Paginated } from '@ticketmanager/shared';
import { ChevronDown, ChevronRight, Download } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Field, FormError } from '../../components/forms';
import { formatWhen } from '../../components/VoucherStatus';
import { ApiError, apiGet, fetchFile } from '../../lib/api';

const FILTERS = ['from', 'to', 'actorId', 'entityType', 'action', 'entityId'] as const;

/** "voucher.approved" → "Voucher approved". */
export const actionLabel = (action: string) => {
  const s = action.replace(/[._]/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** The groups of actions offered in the filter, e.g. "voucher." for every voucher action. */
function actionOptions(actions: string[]) {
  const prefixes = [...new Set(actions.map((a) => a.split('.')[0]!))].sort();
  return { prefixes, actions };
}

const show = (v: unknown) => (v == null ? '' : JSON.stringify(v, null, 2));

/** Who did what, and when. Every change in the app writes a row here. */
export function AuditLog() {
  const [params, setParams] = useSearchParams();
  const [log, setLog] = useState<Paginated<AuditEntry> | null>(null);
  const [facets, setFacets] = useState<AuditFacets | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = params.toString();

  useEffect(() => {
    apiGet<AuditFacets>('/audit/facets').then(setFacets, () => {});
  }, []);

  useEffect(() => {
    let active = true;
    apiGet<Paginated<AuditEntry>>(`/audit?${query}`).then(
      (r) => {
        if (!active) return;
        setLog(r);
        setError(null);
      },
      (e: unknown) => active && setError(e instanceof ApiError ? e.message : 'Could not load'),
    );
    return () => {
      active = false;
    };
  }, [query]);

  function set(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: key !== 'page' });
  }

  async function downloadCsv() {
    setError(null);
    const q = new URLSearchParams();
    for (const k of FILTERS) {
      const v = params.get(k);
      if (v) q.set(k, v);
    }
    try {
      await fetchFile(`/audit/csv?${q}`, 'save', 'audit-log.csv');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not download the CSV');
    }
  }

  const opts = actionOptions(facets?.actions ?? []);
  const meta = log?.meta;
  const filtered = FILTERS.some((k) => params.get(k));
  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="muted">
            Every change, approval, payment, download and sign-in, with who did it and in which
            role. Rows can&apos;t be edited or deleted.
          </p>
        </div>
        <div className="actions">
          <button className="btn btn-secondary" onClick={() => void downloadCsv()}>
            <Download size={16} aria-hidden /> Download CSV
          </button>
        </div>
      </div>

      <div className="filters report-filters">
        <Field label="From">
          <input
            type="date"
            value={params.get('from') ?? ''}
            onChange={(e) => set('from', e.target.value)}
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            value={params.get('to') ?? ''}
            onChange={(e) => set('to', e.target.value)}
          />
        </Field>
        <Field label="Who">
          <select
            value={params.get('actorId') ?? ''}
            onChange={(e) => set('actorId', e.target.value)}
          >
            <option value="">Anyone</option>
            {facets?.actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Record">
          <select
            value={params.get('entityType') ?? ''}
            onChange={(e) => set('entityType', e.target.value)}
          >
            <option value="">Any record</option>
            {facets?.entityTypes.map((t) => (
              <option key={t} value={t}>
                {actionLabel(t)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Action">
          <select
            value={params.get('action') ?? ''}
            onChange={(e) => set('action', e.target.value)}
          >
            <option value="">Any action</option>
            {opts.prefixes.map((p) => (
              <optgroup key={p} label={actionLabel(p)}>
                <option value={`${p}.`}>Every {p} action</option>
                {opts.actions
                  .filter((a) => a.startsWith(`${p}.`))
                  .map((a) => (
                    <option key={a} value={a}>
                      {actionLabel(a)}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </Field>
      </div>
      {filtered && (
        <button className="link-button small" onClick={() => setParams(new URLSearchParams())}>
          Clear filters
        </button>
      )}

      <FormError message={error} />
      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th />
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Record</th>
            </tr>
          </thead>
          <tbody>
            {log?.data.map((e) => {
              const expanded = open === e.id;
              return (
                <Fragment key={e.id}>
                  <tr>
                    <td>
                      <button
                        className="icon-button"
                        aria-expanded={expanded}
                        aria-label={expanded ? 'Hide details' : 'Show details'}
                        onClick={() => setOpen(expanded ? null : e.id)}
                      >
                        {expanded ? (
                          <ChevronDown size={16} aria-hidden />
                        ) : (
                          <ChevronRight size={16} aria-hidden />
                        )}
                      </button>
                    </td>
                    <td className="nowrap">{formatWhen(e.at)}</td>
                    <td>
                      {e.actor?.name ?? <span className="muted">System</span>}
                      {e.actorRole && <div className="muted small">{actionLabel(e.actorRole)}</div>}
                    </td>
                    <td>
                      {actionLabel(e.action)}
                      <div className="muted small mono">{e.action}</div>
                    </td>
                    <td>
                      {e.entityLabel ?? e.entityId ?? '—'}
                      <div className="muted small">{actionLabel(e.entityType)}</div>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="audit-detail">
                      <td />
                      <td colSpan={4}>
                        <div className="audit-diff">
                          {e.before != null && (
                            <div>
                              <strong className="small">Before</strong>
                              <pre>{show(e.before)}</pre>
                            </div>
                          )}
                          {e.after != null && (
                            <div>
                              <strong className="small">After</strong>
                              <pre>{show(e.after)}</pre>
                            </div>
                          )}
                          {e.meta && (
                            <div>
                              <strong className="small">Details</strong>
                              <pre>{show(e.meta)}</pre>
                            </div>
                          )}
                        </div>
                        <div className="muted small">
                          {e.ip && `IP ${e.ip}`}
                          {e.requestId && ` · Request ${e.requestId}`}
                          {e.entityId && ` · ID ${e.entityId}`}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {log && log.data.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  Nothing matches these filters.
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
            onClick={() => set('page', String(meta.page - 1))}
          >
            Previous
          </button>
          <span>
            Page {meta.page} of {meta.totalPages} · {meta.total} entries
          </span>
          <button
            className="btn btn-secondary"
            disabled={meta.page >= meta.totalPages}
            onClick={() => set('page', String(meta.page + 1))}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}
