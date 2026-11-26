import type { FollowUpState } from '@ticketmanager/shared';
import { BellRing } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, apiGet, apiPost } from '../lib/api';
import { Field, FormError } from './forms';
import { formatWhen } from './VoucherStatus';

/**
 * Lets the employee remind whoever holds their claim or advance. Shown only to the employee,
 * and only while it waits on someone else. `path` is /vouchers/:id or /advances/:id.
 */
export function FollowUp<T>({
  path,
  version,
  onSent,
}: {
  path: string;
  /** Changes whenever the claim does, so the state is read again. */
  version: number;
  onSent: (updated: T, notice: string) => void;
}) {
  const [state, setState] = useState<FollowUpState | null>(null);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    apiGet<FollowUpState>(`${path}/follow-up`).then(
      (s) => active && setState(s),
      () => active && setState(null),
    );
    return () => {
      active = false;
    };
  }, [path, version]);

  if (!state?.waitingOn) return null;

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await apiPost<FollowUpState>(`${path}/follow-up`, {
        message: message.trim() || undefined,
      });
      setState(next);
      setOpen(false);
      setMessage('');
      onSent(await apiGet<T>(path), `Reminder sent to ${next.waitingOn ?? 'the approver'}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the reminder');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card wide follow-up" onSubmit={send} noValidate>
      <div className="follow-up-head">
        <div>
          <strong>Remind {state.waitingOn}</strong>
          <span className="muted small">
            {state.canSend
              ? `Send a reminder if it is taking too long. You can send one every ${state.cooldownHours} hours.`
              : state.nextAllowedAt
                ? `You can send a reminder from ${formatWhen(state.nextAllowedAt)}.`
                : ''}
            {state.lastSentAt ? ` Last reminder: ${formatWhen(state.lastSentAt)}.` : ''}
          </span>
        </div>
        {!open && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!state.canSend}
            onClick={() => setOpen(true)}
          >
            <BellRing size={16} aria-hidden /> Send reminder
          </button>
        )}
      </div>
      {open && (
        <>
          <Field label="Note (optional)">
            <textarea
              rows={2}
              maxLength={500}
              value={message}
              placeholder="e.g. I need this before the month closes"
              onChange={(e) => setMessage(e.target.value)}
              autoFocus
            />
          </Field>
          <FormError message={error} />
          <div className="actions">
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Back
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Send reminder to {state.waitingOn}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
