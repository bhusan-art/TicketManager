import { QUEUES, type EmailJob } from '@ticketmanager/shared';
import { Queue } from 'bullmq';

/** Sends email by queueing it for the worker, which retries failed sends. */
export interface Mailer {
  send(mail: EmailJob): Promise<void>;
}

export function createQueueMailer(redisUrl: string): Mailer & { close(): Promise<void> } {
  const queue = new Queue(QUEUES.email, {
    connection: { url: redisUrl },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
  return {
    async send(mail) {
      await queue.add('send', mail);
    },
    close: () => queue.close(),
  };
}

/** Keeps sent mail in memory. For tests. */
export function createMemoryMailer(): Mailer & { sent: EmailJob[] } {
  const sent: EmailJob[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}
