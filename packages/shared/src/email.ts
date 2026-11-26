import { z } from 'zod';

/** Queue names. The API adds jobs and the worker processes them. */
export const QUEUES = { email: 'email' } as const;

export const emailJobSchema = z.object({
  to: z.union([z.email(), z.array(z.email()).min(1)]),
  cc: z.array(z.email()).optional(),
  subject: z.string().min(1),
  text: z.string().min(1),
  html: z.string().optional(),
});
export type EmailJob = z.infer<typeof emailJobSchema>;
