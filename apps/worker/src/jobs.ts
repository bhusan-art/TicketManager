import type { Job } from 'bullmq';
import type { Transporter } from 'nodemailer';
import { z } from 'zod';

/** Queue names shared with the API, which adds jobs. */
export const QUEUES = { email: 'email', system: 'system' } as const;

export const emailJobSchema = z.object({
  to: z.union([z.email(), z.array(z.email()).min(1)]),
  cc: z.array(z.email()).optional(),
  subject: z.string().min(1),
  text: z.string().min(1),
  html: z.string().optional(),
});
export type EmailJob = z.infer<typeof emailJobSchema>;

/** Sends one email. BullMQ retries with backoff when this throws. */
export function makeEmailProcessor(transport: Transporter, from: string) {
  return async (job: Job) => {
    const mail = emailJobSchema.parse(job.data);
    const info = await transport.sendMail({ from, ...mail });
    return { messageId: info.messageId };
  };
}
