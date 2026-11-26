import {
  ATTACHMENT_TYPES,
  type VoucherAttachment,
  type VoucherDetail,
} from '@ticketmanager/shared';
import { Paperclip } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { ApiError, api, apiUpload } from '../../lib/api';
import { Field, FormError } from '../forms';

/** The employee's reply to a query, with the option to add a missing bill first. */
export function AnswerPanel({
  voucher,
  onChange,
  onDone,
}: {
  voucher: VoucherDetail;
  onChange: (v: VoucherDetail) => void;
  onDone: (v: VoucherDetail, notice: string) => void;
}) {
  const query = [...voucher.events].reverse().find((e) => e.type === 'queried');
  const [message, setMessage] = useState('');
  const [lineId, setLineId] = useState(voucher.lines[0]?.id ?? '');
  const [added, setAdded] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiUpload<{ attachment: VoucherAttachment; version: number }>(
        `/vouchers/${voucher.id}/lines/${lineId}/attachments`,
        file,
      );
      setAdded((a) => [...a, res.attachment.filename]);
      onChange({
        ...voucher,
        version: res.version,
        lines: voucher.lines.map((l) =>
          l.id === lineId ? { ...l, attachments: [...l.attachments, res.attachment] } : l,
        ),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function answer(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldError(undefined);
    try {
      const v = await api<VoucherDetail>('POST', `/vouchers/${voucher.id}/answer`, {
        version: voucher.version,
        message,
      });
      onDone(v, 'Answer sent.');
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldError(err.fieldErrors.message);
        setError(err.fieldErrors.message ? null : err.message);
      } else setError('Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card wide query-panel" onSubmit={answer} noValidate>
      <h2>{query?.actor?.name ?? 'An approver'} has a question</h2>
      {query?.message && <blockquote className="event-message queried">{query.message}</blockquote>}
      <FormError message={error} />

      <div className="attach-row">
        <label>
          <span className="muted small">Add a bill to</span>
          <select
            aria-label="Line for the new bill"
            value={lineId}
            onChange={(e) => setLineId(e.target.value)}
          >
            {voucher.lines.map((l, i) => (
              <option key={l.id} value={l.id}>
                Expense {i + 1}: {l.description ?? l.category?.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || !lineId}
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip size={16} aria-hidden /> Attach file
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          aria-label="Choose a bill file"
          accept={Object.keys(ATTACHMENT_TYPES).join(',')}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = '';
          }}
        />
        {added.length > 0 && <span className="muted small">Added: {added.join(', ')}</span>}
      </div>

      <Field label="Your answer" error={fieldError}>
        <textarea
          rows={3}
          maxLength={1000}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </Field>
      <div className="actions">
        <button className="btn btn-primary" disabled={busy || message.trim().length < 3}>
          Send answer
        </button>
      </div>
    </form>
  );
}
