import type { Job } from 'bullmq';
import type { Transporter } from 'nodemailer';
import { emailJobSchema, QUEUES } from '@ticketmanager/shared';

export { QUEUES };

/** Sends one email. BullMQ retries with backoff when this throws. */
export function makeEmailProcessor(transport: Transporter, from: string) {
  return async (job: Job) => {
    const mail = emailJobSchema.parse(job.data);
    const info = await transport.sendMail({ from, ...mail });
    return { messageId: info.messageId };
  };
}
