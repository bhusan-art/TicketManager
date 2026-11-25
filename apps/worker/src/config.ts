import { z } from 'zod';

const envSchema = z.object({
  LOG_LEVEL: z.string().default('info'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
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
