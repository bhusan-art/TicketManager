import { EMAIL_MAX_ATTEMPTS } from '@ticketmanager/shared';
import type pg from 'pg';

/** Minutes to wait before each retry: 1, 5, 15, 60, then 180. */
export const RETRY_MINUTES = [1, 5, 15, 60, 180];

/** How long a claimed email stays reserved while it is being sent. */
const LEASE_MINUTES = 5;

export interface OutboxEmail {
  id: string;
  kind: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  link: string | null;
  attempts: number;
}

export interface Mail {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
}

export type SendMail = (mail: Mail) => Promise<{ messageId?: string }>;

export interface DeliveryResult {
  sent: number;
  retrying: number;
  failed: number;
}

/** The text as sent: a full link to the app, and a sign-off for workflow emails. */
export function renderText(email: OutboxEmail, publicUrl: string): string {
  let text = email.text;
  if (email.link)
    text += `\n\nOpen it in TicketManager:\n${publicUrl.replace(/\/$/, '')}${email.link}`;
  if (email.kind === 'notification' || email.kind === 'follow_up') {
    text += '\n\nTicketManager';
  }
  return text;
}

/**
 * Claims emails that are due (FOR UPDATE SKIP LOCKED, so several workers never send the same one)
 * and reserves them for a few minutes. A worker that dies mid-send leaves the email to be
 * picked up again once the reservation runs out.
 */
async function claim(pool: pg.Pool, limit: number): Promise<OutboxEmail[]> {
  const { rows } = await pool.query<OutboxEmail>(
    `update email_outbox
        set attempts = attempts + 1,
            next_attempt_at = now() + make_interval(mins => $2),
            updated_at = now()
      where id in (
        select id from email_outbox
         where status = 'pending' and next_attempt_at <= now()
         order by next_attempt_at
         limit $1
         for update skip locked)
      returning id, kind, "to", cc, subject, text, link, attempts`,
    [limit, LEASE_MINUTES],
  );
  return rows;
}

/** Sends every email that is due. Failures retry with backoff, then are marked failed. */
export async function deliverDue(
  pool: pg.Pool,
  send: SendMail,
  options: {
    publicUrl: string;
    batch?: number;
    onError?: (email: OutboxEmail, err: Error) => void;
  },
): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, retrying: 0, failed: 0 };
  for (;;) {
    const batch = await claim(pool, options.batch ?? 20);
    if (batch.length === 0) return result;
    for (const email of batch) {
      try {
        const info = await send({
          to: email.to,
          cc: email.cc.length ? email.cc : undefined,
          subject: email.subject,
          text: renderText(email, options.publicUrl),
        });
        await pool.query(
          `update email_outbox
              set status = 'sent', sent_at = now(), message_id = $2, last_error = null,
                  updated_at = now()
            where id = $1`,
          [email.id, info.messageId ?? null],
        );
        result.sent += 1;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        options.onError?.(email, err);
        const giveUp = email.attempts >= EMAIL_MAX_ATTEMPTS;
        const wait = RETRY_MINUTES[Math.min(email.attempts - 1, RETRY_MINUTES.length - 1)]!;
        await pool.query(
          `update email_outbox
              set status = $2, last_error = $3, updated_at = now(),
                  next_attempt_at = now() + make_interval(mins => $4)
            where id = $1`,
          [email.id, giveUp ? 'failed' : 'pending', err.message.slice(0, 1000), wait],
        );
        if (giveUp) result.failed += 1;
        else result.retrying += 1;
      }
    }
  }
}
