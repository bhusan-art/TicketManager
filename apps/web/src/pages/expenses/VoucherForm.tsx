import {
  ATTACHMENT_TYPES,
  MAX_ATTACHMENTS_PER_LINE,
  formatRupees,
  paiseToInput,
  parseRupees,
  projectLabel,
  todayIso,
  voucherSubmitIssues,
  type Category,
  type LinkableAdvance,
  type Project,
  type Issue,
  type VoucherAttachment,
  type VoucherDetail,
  type VoucherLineInput,
} from '@ticketmanager/shared';
import { FileText, Paperclip, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Field, FormError } from '../../components/forms';
import { formatBytes, formatDay } from '../../components/VoucherStatus';
import {
  ApiError,
  api,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiUpload,
  fetchFile,
  idempotencyKey,
} from '../../lib/api';

/** What the person is typing for one line. Amounts stay as text until saved. */
interface LineForm {
  key: string;
  id?: string;
  categoryId: string;
  expenseDate: string;
  description: string;
  vendorName: string;
  amount: string;
  isGst: boolean;
  gstin: string;
  invoiceNumber: string;
  cgst: string;
  sgst: string;
  igst: string;
  missingProofReason: string;
  /** No bill: the person ticked "I don't have a bill". */
  noBill: boolean;
  attachments: VoucherAttachment[];
}

const STEPS = [
  { key: 'details', label: 'Details' },
  { key: 'proofs', label: 'Attachments' },
  { key: 'review', label: 'Review' },
] as const;
type Step = (typeof STEPS)[number]['key'];

let keySeq = 0;
const newKey = () => `line-${++keySeq}`;

const blankLine = (): LineForm => ({
  key: newKey(),
  categoryId: '',
  expenseDate: todayIso(),
  description: '',
  vendorName: '',
  amount: '',
  isGst: false,
  gstin: '',
  invoiceNumber: '',
  cgst: '',
  sgst: '',
  igst: '',
  missingProofReason: '',
  noBill: false,
  attachments: [],
});

const money = (paise: number) => (paise ? paiseToInput(paise) : '');

function fromVoucher(v: VoucherDetail): LineForm[] {
  return v.lines.map((l) => ({
    key: l.id,
    id: l.id,
    categoryId: l.category?.id ?? '',
    expenseDate: l.expenseDate ?? '',
    description: l.description ?? '',
    vendorName: l.vendorName ?? '',
    amount: money(l.amountPaise),
    isGst: l.isGst,
    gstin: l.gstin ?? '',
    invoiceNumber: l.invoiceNumber ?? '',
    cgst: money(l.cgstPaise),
    sgst: money(l.sgstPaise),
    igst: money(l.igstPaise),
    missingProofReason: l.missingProofReason ?? '',
    noBill: Boolean(l.missingProofReason),
    attachments: l.attachments,
  }));
}

/** Converts typed amounts to paise. Returns errors for amounts that don't parse. */
function toInput(lines: LineForm[]) {
  const errors: Record<string, string> = {};
  const amount = (value: string, path: string) => {
    if (!value.trim()) return 0;
    const paise = parseRupees(value);
    if (paise === null) errors[path] = 'Enter an amount like 1250 or 1250.50';
    return paise ?? 0;
  };
  const out = lines.map((l, i): VoucherLineInput & { amountPaise: number } => ({
    id: l.id,
    categoryId: l.categoryId || null,
    expenseDate: l.expenseDate || null,
    description: l.description,
    vendorName: l.vendorName,
    amountPaise: amount(l.amount, `lines.${i}.amountPaise`),
    isGst: l.isGst,
    gstin: l.isGst ? l.gstin : null,
    invoiceNumber: l.invoiceNumber,
    cgstPaise: l.isGst ? amount(l.cgst, `lines.${i}.cgstPaise`) : 0,
    sgstPaise: l.isGst ? amount(l.sgst, `lines.${i}.sgstPaise`) : 0,
    igstPaise: l.isGst ? amount(l.igst, `lines.${i}.igstPaise`) : 0,
    missingProofReason: l.noBill ? l.missingProofReason : null,
  }));
  return { lines: out, errors };
}

/** Which step fixes a problem at this path. */
const stepFor = (path: string): Step =>
  path.endsWith('.proof') || path.endsWith('.missingProofReason') ? 'proofs' : 'details';

export function VoucherForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const step = (STEPS.find((s) => s.key === params.get('step'))?.key ?? 'details') as Step;

  const [categories, setCategories] = useState<Category[]>([]);
  const [voucher, setVoucher] = useState<VoucherDetail | null>(null);
  const [purpose, setPurpose] = useState('');
  const [advanceId, setAdvanceId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [linkable, setLinkable] = useState<LinkableAdvance[]>([]);
  const [lines, setLines] = useState<LineForm[]>(() => (id ? [] : [blankLine()]));
  const [loading, setLoading] = useState(Boolean(id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    apiGet<{ data: Category[] }>('/categories').then(
      (r) => setCategories(r.data),
      () => {},
    );
    apiGet<{ data: Project[] }>('/projects').then(
      (r) => setProjects(r.data),
      () => {},
    );
    apiGet<{ data: LinkableAdvance[] }>('/advances/linkable').then(
      (r) => setLinkable(r.data),
      () => {},
    );
  }, []);

  function load(v: VoucherDetail) {
    setVoucher(v);
    setPurpose(v.purpose ?? '');
    setAdvanceId(v.advance?.id ?? '');
    setProjectId(v.project?.id ?? '');
    setLines(fromVoucher(v));
  }

  useEffect(() => {
    if (!id) return;
    let active = true;
    apiGet<VoucherDetail>(`/vouchers/${id}`).then(
      (v) => {
        if (!active) return;
        if (!v.can.edit) {
          navigate(`/expenses/${v.id}`, { replace: true });
          return;
        }
        load(v);
        setLoading(false);
      },
      (e: unknown) => {
        if (!active) return;
        setError(e instanceof ApiError ? e.message : 'Could not load this voucher');
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [id, navigate]);

  const goTo = (next: Step, voucherId = voucher?.id) => {
    window.scrollTo({ top: 0 });
    const search = next === 'details' ? '' : `?step=${next}`;
    if (voucherId && voucherId !== id) navigate(`/expenses/${voucherId}/edit${search}`);
    else setParams(next === 'details' ? {} : { step: next }, { replace: false });
  };

  function updateLine(key: string, change: Partial<LineForm>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...change } : l)));
  }

  function fail(err: unknown, fallback: string) {
    if (err instanceof ApiError) {
      setFieldErrors(err.fieldErrors);
      setError(
        err.status === 409 && err.body?.error.details
          ? `${err.message} (Reload the page to get the latest version.)`
          : err.message,
      );
    } else setError(fallback);
  }

  /** Saves the draft (creating it the first time). Returns the saved voucher, or null on error. */
  async function save(): Promise<VoucherDetail | null> {
    setError(null);
    setFieldErrors({});
    const { lines: input, errors } = toInput(lines);
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      setError('Some amounts are not valid numbers.');
      return null;
    }
    setBusy(true);
    try {
      const saved = voucher
        ? await apiPatch<VoucherDetail>(`/vouchers/${voucher.id}`, {
            version: voucher.version,
            purpose,
            advanceId: advanceId || null,
            projectId: projectId || null,
            lines: input,
          })
        : await apiPost<VoucherDetail>('/vouchers', {
            purpose,
            advanceId: advanceId || null,
            projectId: projectId || null,
            lines: input,
          });
      load(saved);
      return saved;
    } catch (err) {
      fail(err, 'Could not save. Check your connection and try again.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveAndGo(next: Step | 'list') {
    const saved = await save();
    if (!saved) return;
    if (next === 'list') navigate(`/expenses/${saved.id}`, { state: { notice: 'Draft saved.' } });
    else goTo(next, saved.id);
  }

  async function submit() {
    if (!voucher) return;
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    try {
      const done = await api<VoucherDetail>(
        'POST',
        `/vouchers/${saved.id}/submit`,
        { version: saved.version },
        { 'Idempotency-Key': idempotencyKey() },
      );
      navigate(`/expenses/${done.id}`, {
        state: {
          notice:
            voucher.approvalStatus === 'returned'
              ? `Resubmitted ${done.number}.`
              : `Submitted as ${done.number}.`,
        },
      });
    } catch (err) {
      fail(err, 'Could not submit. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  // ---- Proofs ----

  async function upload(line: LineForm, file: File) {
    if (!voucher || !line.id) return;
    setError(null);
    if (file.type && !(file.type in ATTACHMENT_TYPES)) {
      setError(`"${file.name}" is not a PDF, JPG, PNG or WEBP file.`);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError(`"${file.name}" is larger than 10 MB.`);
      return;
    }
    setBusy(true);
    try {
      const res = await apiUpload<{ attachment: VoucherAttachment; version: number }>(
        `/vouchers/${voucher.id}/lines/${line.id}/attachments`,
        file,
      );
      setVoucher((v) => v && { ...v, version: res.version });
      updateLine(line.key, {
        attachments: [...line.attachments, res.attachment],
        noBill: false,
      });
    } catch (err) {
      fail(err, 'Upload failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function removeAttachment(line: LineForm, attachment: VoucherAttachment) {
    if (!voucher) return;
    setBusy(true);
    try {
      const res = await apiDelete<{ version: number }>(
        `/vouchers/${voucher.id}/attachments/${attachment.id}`,
      );
      setVoucher((v) => v && { ...v, version: res.version });
      updateLine(line.key, {
        attachments: line.attachments.filter((a) => a.id !== attachment.id),
      });
    } catch (err) {
      fail(err, 'Could not remove the file. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="page-loading">Loading…</p>;
  if (id && !voucher) {
    return (
      <section>
        <FormError message={error ?? 'Voucher not found'} />
        <Link to="/expenses">Back to my expenses</Link>
      </section>
    );
  }

  const { lines: preview } = toInput(lines);
  const total = preview.reduce((s, l) => s + l.amountPaise, 0);
  const issues: Issue[] = voucherSubmitIssues({
    purpose: purpose.trim() || null,
    lines: preview.map((l, i) => ({
      categoryId: l.categoryId ?? null,
      expenseDate: l.expenseDate ?? null,
      description: l.description?.trim() || null,
      amountPaise: l.amountPaise,
      isGst: l.isGst ?? false,
      gstin: l.gstin?.trim().toUpperCase() || null,
      invoiceNumber: l.invoiceNumber?.trim() || null,
      cgstPaise: l.cgstPaise ?? 0,
      sgstPaise: l.sgstPaise ?? 0,
      igstPaise: l.igstPaise ?? 0,
      missingProofReason: l.missingProofReason?.trim() || null,
      attachmentCount: lines[i]!.attachments.length,
    })),
  });
  const err = (path: string) => fieldErrors[path];
  const categoryName = (cid: string) =>
    categories.find((c) => c.id === cid)?.name ??
    voucher?.lines.find((l) => l.category?.id === cid)?.category?.name ??
    '—';

  return (
    <section>
      <Link to={voucher ? `/expenses/${voucher.id}` : '/expenses'} className="back-link">
        ← {voucher ? 'Back to voucher' : 'My expenses'}
      </Link>
      <div className="page-head">
        <div>
          <h1>{voucher ? 'Edit expense' : 'Submit expense'}</h1>
          <p className="muted">
            {voucher?.number ?? 'New voucher'} · Total {formatRupees(total)}
          </p>
        </div>
      </div>

      <ol className="stepper" aria-label="Steps">
        {STEPS.map((s, i) => {
          const current = STEPS.findIndex((x) => x.key === step);
          return (
            <li
              key={s.key}
              className={i === current ? 'current' : i < current ? 'done' : undefined}
              aria-current={i === current ? 'step' : undefined}
            >
              <span className="step-dot">{i + 1}</span> {s.label}
            </li>
          );
        })}
      </ol>

      <FormError message={error} />

      {step === 'details' && (
        <div className="voucher-form">
          <div className="card wide">
            <Field label="Purpose" error={err('purpose')} hint="e.g. Client visit to Bengaluru">
              <input
                value={purpose}
                maxLength={200}
                onChange={(e) => setPurpose(e.target.value)}
                autoFocus={!voucher}
              />
            </Field>
            {(projects.length > 0 || projectId) && (
              <Field
                label="Project"
                error={err('projectId')}
                hint="The company project this expense was for. Leave it as “No project” for general expenses."
              >
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">No project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {projectLabel(p)}
                    </option>
                  ))}
                  {projectId && !projects.some((p) => p.id === projectId) && (
                    <option value={projectId}>
                      {voucher?.project?.name ?? 'Project'} (closed)
                    </option>
                  )}
                </select>
              </Field>
            )}
            {(linkable.length > 0 || advanceId) && (
              <Field
                label="Settle against an advance"
                error={err('advanceId')}
                hint="Choose your advance if this expense was paid from it. It is then settled there, not paid to you separately."
              >
                <select value={advanceId} onChange={(e) => setAdvanceId(e.target.value)}>
                  <option value="">No, pay me for this claim</option>
                  {linkable.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.number} · {a.purpose} ({formatRupees(a.disbursedPaise)})
                    </option>
                  ))}
                  {advanceId && !linkable.some((a) => a.id === advanceId) && (
                    <option value={advanceId}>
                      {voucher?.advance?.number ?? 'Advance'} (no longer open)
                    </option>
                  )}
                </select>
              </Field>
            )}
          </div>

          {lines.map((line, i) => (
            <fieldset key={line.key} className="card wide line-card">
              <legend className="line-title">
                Expense {i + 1}
                {lines.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-link danger"
                    onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}
                    aria-label={`Remove expense ${i + 1}`}
                  >
                    <Trash2 size={15} aria-hidden /> Remove
                  </button>
                )}
              </legend>
              <div className="line-grid">
                <Field label="Category" error={err(`lines.${i}.categoryId`)}>
                  <select
                    value={line.categoryId}
                    onChange={(e) => updateLine(line.key, { categoryId: e.target.value })}
                  >
                    <option value="">Choose…</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                    {line.categoryId && !categories.some((c) => c.id === line.categoryId) && (
                      <option value={line.categoryId}>
                        {categoryName(line.categoryId)} (no longer in use)
                      </option>
                    )}
                  </select>
                </Field>
                <Field label="Date of expense" error={err(`lines.${i}.expenseDate`)}>
                  <input
                    type="date"
                    value={line.expenseDate}
                    max={todayIso()}
                    onChange={(e) => updateLine(line.key, { expenseDate: e.target.value })}
                  />
                </Field>
                <Field label="Amount (₹)" error={err(`lines.${i}.amountPaise`)} hint="Tax included">
                  <input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={line.amount}
                    onChange={(e) => updateLine(line.key, { amount: e.target.value })}
                  />
                </Field>
                <Field label="Description" error={err(`lines.${i}.description`)}>
                  <input
                    value={line.description}
                    maxLength={500}
                    placeholder="What was this for?"
                    onChange={(e) => updateLine(line.key, { description: e.target.value })}
                  />
                </Field>
                <Field label="Vendor" hint="Optional">
                  <input
                    value={line.vendorName}
                    maxLength={120}
                    onChange={(e) => updateLine(line.key, { vendorName: e.target.value })}
                  />
                </Field>
                <label className="check gst-toggle">
                  <input
                    type="checkbox"
                    checked={line.isGst}
                    onChange={(e) => updateLine(line.key, { isGst: e.target.checked })}
                  />
                  <span>
                    GST bill
                    <span className="muted small"> · the bill shows the supplier's GSTIN</span>
                  </span>
                </label>
              </div>
              {line.isGst && (
                <div className="line-grid gst-grid">
                  <Field label="Supplier GSTIN" error={err(`lines.${i}.gstin`)}>
                    <input
                      value={line.gstin}
                      maxLength={15}
                      placeholder="29ABCDE1234F1Z5"
                      style={{ textTransform: 'uppercase' }}
                      onChange={(e) => updateLine(line.key, { gstin: e.target.value })}
                    />
                  </Field>
                  <Field label="Invoice number" error={err(`lines.${i}.invoiceNumber`)}>
                    <input
                      value={line.invoiceNumber}
                      maxLength={40}
                      onChange={(e) => updateLine(line.key, { invoiceNumber: e.target.value })}
                    />
                  </Field>
                  <Field label="CGST (₹)" error={err(`lines.${i}.cgstPaise`)}>
                    <input
                      inputMode="decimal"
                      value={line.cgst}
                      onChange={(e) => updateLine(line.key, { cgst: e.target.value })}
                    />
                  </Field>
                  <Field label="SGST (₹)" error={err(`lines.${i}.sgstPaise`)}>
                    <input
                      inputMode="decimal"
                      value={line.sgst}
                      onChange={(e) => updateLine(line.key, { sgst: e.target.value })}
                    />
                  </Field>
                  <Field
                    label="IGST (₹)"
                    error={err(`lines.${i}.igstPaise`)}
                    hint="Only for a supplier in another state"
                  >
                    <input
                      inputMode="decimal"
                      value={line.igst}
                      onChange={(e) => updateLine(line.key, { igst: e.target.value })}
                    />
                  </Field>
                </div>
              )}
            </fieldset>
          ))}

          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setLines((ls) => [...ls, blankLine()])}
            disabled={lines.length >= 50}
          >
            <Plus size={16} aria-hidden /> Add another expense
          </button>

          <StepActions>
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void saveAndGo('list')}
            >
              Save as draft
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || lines.length === 0}
              onClick={() => void saveAndGo('proofs')}
            >
              Next: Attachments →
            </button>
          </StepActions>
        </div>
      )}

      {step === 'proofs' && voucher && (
        <div className="voucher-form">
          <p className="muted">
            Attach the bill for each expense: PDF, JPG, PNG or WEBP, up to 10 MB each. If you have
            no bill, say why.
          </p>
          {lines.map((line, i) => (
            <ProofCard
              key={line.key}
              index={i}
              line={line}
              categoryName={categoryName(line.categoryId)}
              busy={busy}
              error={err(`lines.${i}.proof`) ?? err(`lines.${i}.missingProofReason`)}
              onUpload={(file) => void upload(line, file)}
              onRemove={(a) => void removeAttachment(line, a)}
              onOpen={(a) =>
                void fetchFile(`/vouchers/${voucher.id}/attachments/${a.id}`, 'open').catch(
                  (e: unknown) => fail(e, 'Could not open the file'),
                )
              }
              onChange={(change) => updateLine(line.key, change)}
            />
          ))}
          <StepActions>
            <button className="btn btn-secondary" disabled={busy} onClick={() => goTo('details')}>
              ← Back
            </button>
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void saveAndGo('list')}
            >
              Save as draft
            </button>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void saveAndGo('review')}
            >
              Next: Review →
            </button>
          </StepActions>
        </div>
      )}

      {step === 'review' && voucher && (
        <div className="voucher-form">
          <div className="card wide">
            <h2>Expense summary</h2>
            <dl className="details">
              <dt>Purpose</dt>
              <dd>{purpose || '—'}</dd>
              {projectId && (
                <>
                  <dt>Project</dt>
                  <dd>
                    {(() => {
                      const p = projects.find((x) => x.id === projectId);
                      return p ? projectLabel(p) : voucher.project?.name;
                    })()}
                  </dd>
                </>
              )}
              {advanceId && (
                <>
                  <dt>Advance</dt>
                  <dd>
                    {linkable.find((a) => a.id === advanceId)?.number ?? voucher.advance?.number}
                  </dd>
                </>
              )}
              <dt>Expenses</dt>
              <dd>{lines.length}</dd>
              <dt>Total</dt>
              <dd>
                <strong>{formatRupees(total)}</strong>
              </dd>
            </dl>
            <table className="table compact">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Description</th>
                  <th>Bill</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.key}>
                    <td>{i + 1}</td>
                    <td>{formatDay(l.expenseDate)}</td>
                    <td>{l.categoryId ? categoryName(l.categoryId) : '—'}</td>
                    <td>
                      {l.description || '—'}
                      {l.isGst && <div className="muted small">GST · {l.gstin.toUpperCase()}</div>}
                    </td>
                    <td>
                      {l.attachments.length
                        ? `${l.attachments.length} file${l.attachments.length > 1 ? 's' : ''}`
                        : l.noBill
                          ? 'No bill'
                          : '—'}
                    </td>
                    <td className="num">{formatRupees(preview[i]!.amountPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {issues.length > 0 && (
            <div className="card wide issues" role="alert">
              <h2>Fix these before you submit</h2>
              <ul>
                {issues.map((issue) => (
                  <li key={issue.path}>
                    {describePath(issue.path)}: {issue.message}.{' '}
                    <button className="btn btn-link" onClick={() => goTo(stepFor(issue.path))}>
                      Fix
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <label className="check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>I confirm the above information is correct.</span>
          </label>

          <StepActions>
            <button className="btn btn-secondary" disabled={busy} onClick={() => goTo('proofs')}>
              ← Back
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || !confirmed || issues.length > 0}
              onClick={() => void submit()}
            >
              {voucher.approvalStatus === 'returned' ? 'Resubmit expense' : 'Submit expense'}
            </button>
          </StepActions>
        </div>
      )}
    </section>
  );
}

function StepActions({ children }: { children: ReactNode }) {
  return <div className="step-actions">{children}</div>;
}

/** "lines.1.gstin" → "Expense 2". */
function describePath(path: string) {
  const m = /^lines\.(\d+)\./.exec(path);
  if (m) return `Expense ${Number(m[1]) + 1}`;
  if (path === 'purpose') return 'Purpose';
  if (path === 'advanceId') return 'Advance';
  if (path === 'projectId') return 'Project';
  return 'Voucher';
}

function ProofCard({
  index,
  line,
  categoryName,
  busy,
  error,
  onUpload,
  onRemove,
  onOpen,
  onChange,
}: {
  index: number;
  line: LineForm;
  categoryName: string;
  busy: boolean;
  error?: string;
  onUpload: (file: File) => void;
  onRemove: (a: VoucherAttachment) => void;
  onOpen: (a: VoucherAttachment) => void;
  onChange: (change: Partial<LineForm>) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const full = line.attachments.length >= MAX_ATTACHMENTS_PER_LINE;
  const amount = parseRupees(line.amount) ?? 0;

  return (
    <div className="card wide line-card">
      <div className="line-title">
        <span>
          Expense {index + 1} · {categoryName} · {formatRupees(amount)}
        </span>
        <span className="muted small">{line.description}</span>
      </div>

      {!line.noBill && (
        <div
          className={`dropzone${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            for (const file of Array.from(e.dataTransfer.files)) onUpload(file);
          }}
        >
          <Upload size={22} aria-hidden />
          <span>
            Drag and drop the bill here, or{' '}
            <button
              type="button"
              className="btn btn-link"
              disabled={busy || full}
              onClick={() => input.current?.click()}
            >
              browse files
            </button>
          </span>
          <span className="muted small">PDF, JPG, PNG or WEBP · up to 10 MB</span>
          <input
            ref={input}
            type="file"
            hidden
            aria-label={`Attach a bill for expense ${index + 1}`}
            accept={Object.keys(ATTACHMENT_TYPES).join(',')}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUpload(file);
              e.target.value = '';
            }}
          />
        </div>
      )}

      {line.attachments.length > 0 && (
        <ul className="file-list">
          {line.attachments.map((a) => (
            <li key={a.id}>
              {a.contentType === 'application/pdf' ? (
                <FileText size={18} aria-hidden />
              ) : (
                <Paperclip size={18} aria-hidden />
              )}
              <button type="button" className="btn btn-link" onClick={() => onOpen(a)}>
                {a.filename}
              </button>
              <span className="muted small">{formatBytes(a.sizeBytes)}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${a.filename}`}
                disabled={busy}
                onClick={() => onRemove(a)}
              >
                <Trash2 size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {line.attachments.length === 0 && (
        <label className="check">
          <input
            type="checkbox"
            checked={line.noBill}
            onChange={(e) => onChange({ noBill: e.target.checked })}
          />
          <span>I don't have a bill for this expense</span>
        </label>
      )}
      {line.noBill && line.attachments.length === 0 && (
        <Field label="Why is there no bill?" hint="Accounts will see this">
          <textarea
            rows={2}
            maxLength={500}
            value={line.missingProofReason}
            placeholder="e.g. Auto driver did not give a receipt"
            onChange={(e) => onChange({ missingProofReason: e.target.value })}
          />
        </Field>
      )}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
