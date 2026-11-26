import {
  DOWNLOAD_LINK_HOURS,
  EXPORT_KEEP_DAYS,
  EXPORT_MAX_VOUCHERS,
  EXPORT_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUSES,
  ROLE_LABELS,
  formatRupees,
  type DownloadLink,
  type ExportFilters,
  type ExportJob,
  type ExportPreview,
  type ExportStatus,
  type Paginated,
  type Ref,
} from '@ticketmanager/shared';
import { Copy, Download, FileArchive, Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useUser } from '../../auth/AuthContext';
import { Field, FormError } from '../../components/forms';
import { formatBytes, formatWhen } from '../../components/VoucherStatus';
import { ApiError, apiGet, apiPost, fetchFile } from '../../lib/api';

const STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
] as const;

const TONE: Record<ExportStatus, string> = {
  queued: 'pending',
  running: 'pending',
  ready: 'up',
  failed: 'down',
  expired: '',
};

const SCOPE: Record<string, string> = {
  employee: 'Your own submitted claims.',
  manager: 'Claims from people who report to you.',
  accounts: 'Every submitted claim.',
  director: 'Every submitted claim.',
};

type Form = Record<'from' | 'to' | 'status' | 'paymentStatus' | 'departmentId' | 'search', string>;
const EMPTY: Form = {
  from: '',
  to: '',
  status: '',
  paymentStatus: '',
  departmentId: '',
  search: '',
};

function toFilters(f: Form): ExportFilters {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (v.trim()) out[k] = v.trim();
  return out as ExportFilters;
}

/** Bulk ZIP exports of vouchers and their bills, and the person's export history. */
export function Documents() {
  const user = useUser();
  const seesAll = user.activeRole === 'accounts' || user.activeRole === 'director';
  const [form, setForm] = useState<Form>(EMPTY);
  const [includeProofs, setIncludeProofs] = useState(true);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [departments, setDepartments] = useState<Ref[]>([]);
  const [jobs, setJobs] = useState<ExportJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, DownloadLink>>({});
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!seesAll) return;
    apiGet<{ data: Ref[] }>('/reports/departments').then(
      (r) => setDepartments(r.data),
      () => {},
    );
  }, [seesAll]);

  const query = new URLSearchParams(toFilters(form) as Record<string, string>).toString();
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      apiGet<ExportPreview>(`/exports/preview?${query}`).then(
        (p) => active && setPreview(p),
        (e: unknown) => {
          if (!active) return;
          setPreview(null);
          setError(e instanceof ApiError ? e.message : 'Could not count the vouchers');
        },
      );
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);

  const working = jobs?.some((j) => j.status === 'queued' || j.status === 'running') ?? false;
  useEffect(() => {
    let active = true;
    const load = () =>
      apiGet<Paginated<ExportJob>>('/exports?pageSize=20').then(
        (r) => active && setJobs(r.data),
        () => {},
      );
    void load();
    // Check every two seconds while an export is being prepared.
    const timer = working ? setInterval(load, 2000) : undefined;
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [reload, working]);

  const set = (key: keyof Form, value: string) => {
    setError(null);
    setForm((f) => ({ ...f, [key]: value }));
  };

  async function create() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiPost<ExportJob>('/exports', { filters: toFilters(form), includeProofs });
      setNotice('Preparing your ZIP. It appears below when it is ready.');
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start the export');
    } finally {
      setBusy(false);
    }
  }

  async function download(job: ExportJob) {
    setError(null);
    try {
      await fetchFile(`/exports/${job.id}/download`, 'save', job.filename);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not download the ZIP');
    }
  }

  async function makeLink(job: ExportJob) {
    setError(null);
    try {
      const link = await apiPost<DownloadLink>(`/exports/${job.id}/link`);
      setLinks((l) => ({ ...l, [job.id]: link }));
      try {
        await navigator.clipboard.writeText(link.url);
        setNotice('Link copied. Anyone with it can download this ZIP until it expires.');
      } catch {
        setNotice('Link created. Copy it from the box below.');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create a link');
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Document centre</h1>
          <p className="muted">
            Download voucher PDFs and their bills as one ZIP, with a manifest.csv that lists every
            voucher. {SCOPE[user.activeRole] ?? ''} Drafts are never included.
          </p>
        </div>
      </div>

      <div className="card">
        <h2>New export</h2>
        <div className="filters report-filters">
          <Field label="Submitted from">
            <input
              type="date"
              value={form.from}
              max={form.to || undefined}
              onChange={(e) => set('from', e.target.value)}
            />
          </Field>
          <Field label="Submitted to">
            <input
              type="date"
              value={form.to}
              min={form.from || undefined}
              onChange={(e) => set('to', e.target.value)}
            />
          </Field>
          <Field label="Approval">
            <select value={form.status} onChange={(e) => set('status', e.target.value)}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Payment">
            <select
              value={form.paymentStatus}
              onChange={(e) => set('paymentStatus', e.target.value)}
            >
              <option value="">Any payment status</option>
              {PAYMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PAYMENT_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          {seesAll && (
            <Field label="Department">
              <select
                value={form.departmentId}
                onChange={(e) => set('departmentId', e.target.value)}
              >
                <option value="">All departments</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Search">
            <input
              type="search"
              placeholder="Voucher, purpose or employee"
              value={form.search}
              maxLength={100}
              onChange={(e) => set('search', e.target.value)}
            />
          </Field>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={includeProofs}
            onChange={(e) => setIncludeProofs(e.target.checked)}
          />
          <span>Include the uploaded bills, not just the voucher PDFs</span>
        </label>

        <div className="export-summary" role="status" aria-live="polite">
          {preview &&
            (preview.vouchers === 0 ? (
              <span className="muted">No vouchers match these filters.</span>
            ) : (
              <span>
                <strong>
                  {preview.vouchers} {preview.vouchers === 1 ? 'voucher' : 'vouchers'}
                </strong>{' '}
                · {formatRupees(preview.totalPaise)}
                {includeProofs &&
                  ` · ${preview.proofs} ${preview.proofs === 1 ? 'bill' : 'bills'} (${formatBytes(preview.proofBytes)})`}
                {preview.tooMany && (
                  <span className="error-text">
                    {' '}
                    · An export holds up to {EXPORT_MAX_VOUCHERS}. Narrow the dates or filters.
                  </span>
                )}
              </span>
            ))}
        </div>
        <FormError message={error} />
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        <div className="actions">
          <button
            className="btn btn-primary"
            disabled={busy || !preview || preview.vouchers === 0 || preview.tooMany}
            onClick={() => void create()}
          >
            <FileArchive size={16} aria-hidden /> {busy ? 'Starting…' : 'Create ZIP'}
          </button>
        </div>
      </div>

      <h2>Your exports</h2>
      <p className="muted small">
        ZIPs are kept for {EXPORT_KEEP_DAYS} days. A shareable link works for {DOWNLOAD_LINK_HOURS}{' '}
        hours without signing in; making a new one stops the old one.
      </p>
      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Requested</th>
              <th>File</th>
              <th>Status</th>
              <th className="num">Vouchers</th>
              <th className="num">Size</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs?.map((j) => (
              <tr key={j.id}>
                <td className="nowrap">
                  {formatWhen(j.createdAt)}
                  <div className="muted small">As {ROLE_LABELS[j.role]}</div>
                </td>
                <td>
                  {j.filename}
                  <div className="muted small">
                    {j.includeProofs ? 'PDFs and bills' : 'PDFs only'}
                    {j.downloads > 0 &&
                      ` · downloaded ${j.downloads} ${j.downloads === 1 ? 'time' : 'times'}`}
                  </div>
                  {links[j.id] && (
                    <div className="share-link">
                      <input
                        readOnly
                        aria-label="Download link"
                        value={links[j.id]!.url}
                        onFocus={(e) => e.target.select()}
                      />
                      <span className="muted small">
                        Works until {formatWhen(links[j.id]!.expiresAt)}
                      </span>
                    </div>
                  )}
                </td>
                <td>
                  <span className={`pill ${TONE[j.status]}`}>{EXPORT_STATUS_LABELS[j.status]}</span>
                  {j.status === 'ready' && j.expiresAt && (
                    <div className="muted small">Until {formatWhen(j.expiresAt)}</div>
                  )}
                  {j.error && <div className="small error-text">{j.error}</div>}
                </td>
                <td className="num">{j.vouchers ?? '—'}</td>
                <td className="num">{j.sizeBytes != null ? formatBytes(j.sizeBytes) : '—'}</td>
                <td>
                  {j.status === 'ready' && (
                    <div className="row-actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => void download(j)}>
                        <Download size={14} aria-hidden /> Download
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => void makeLink(j)}
                        aria-label={`Copy a download link for ${j.filename}`}
                      >
                        {links[j.id] ? (
                          <Copy size={14} aria-hidden />
                        ) : (
                          <Link2 size={14} aria-hidden />
                        )}{' '}
                        {links[j.id] ? 'New link' : 'Copy link'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {jobs && jobs.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No exports yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
