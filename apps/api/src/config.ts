import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_VERSION: z.string().default('0.1.0'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  MONGO_URL: z.string().min(1).default('mongodb://localhost:27017/ticketmanager?replicaSet=rs0'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  S3_ENDPOINT: z.string().url().default('http://localhost:8333'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().default('ticketmanager'),
  S3_SECRET_KEY: z.string().default('ticketmanager-secret'),
  S3_BUCKET: z.string().default('ticketmanager'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
