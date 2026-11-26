import { QUEUES, type EmailKind } from '@ticketmanager/shared';
import { Queue } from 'bullmq';
import type { Db, DbOrTx } from '../db/client.js';
import { emailOutbox } from '../db/schema.js';

/** An email to send. The worker adds the full URL for `link` (an app path) at the end. */
export interface OutgoingEmail {
  kind: EmailKind;
  to: string | string[];
  cc?: string[];
  subject: string;
  text: string;
  link?: string | null;
}

/**
 * Adds an email to the outbox. Pass the transaction that makes the change, so the email is sent
 * only if the change is saved. The worker delivers it within seconds and retries failures.
 */
export async function queueEmail(db: Pick<DbOrTx, 'insert'>, mail: OutgoingEmail) {
  await db.insert(emailOutbox).values({
    kind: mail.kind,
    to: Array.isArray(mail.to) ? mail.to : [mail.to],
    cc: mail.cc ?? [],
    subject: mail.subject,
    text: mail.text,
    link: mail.link ?? null,
  });
}

/** Sends email through the outbox. */
export interface Mailer {
  send(mail: OutgoingEmail): Promise<void>;
  /** Tells the worker there is new mail, so it doesn't wait for its next sweep. */
  wake(): void;
}

export function createOutboxMailer(db: Db, wake: () => void = () => {}): Mailer {
  return {
    async send(mail) {
      await queueEmail(db, mail);
      wake();
    },
    wake,
  };
}

/** Wakes the worker through Redis. Failures only delay delivery until the worker's next sweep. */
export function createWorkerWaker(redisUrl: string, onError: (err: unknown) => void) {
  const queue = new Queue(QUEUES.email, { connection: { url: redisUrl } });
  return {
    wake() {
      queue
        .add('deliver', {}, { jobId: 'wake', removeOnComplete: true, removeOnFail: true })
        .catch(onError);
    },
    close: () => queue.close(),
  };
}
