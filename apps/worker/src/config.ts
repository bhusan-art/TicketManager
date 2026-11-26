import { z } from 'zod';

const envSchema = z.object({
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgres://ticketmanager:ticketmanager@localhost:5433/ticketmanager'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  /** Where people open the app; links in emails start with it. */
  PUBLIC_URL: z.url().default('http://localhost:8080'),
  /** How often the worker looks for due emails, besides being woken by the API. */
  OUTBOX_SWEEP_SECONDS: z.coerce.number().int().min(1).max(3600).default(15),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('TicketManager <no-reply@ticketmanager.local>'),
});

export type WorkerConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return envSchema.parse(env);
}
