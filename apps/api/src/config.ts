import { z } from 'zod';

const DEV_JWT_SECRET = 'dev-only-secret-change-me-dev-only-secret-change-me';

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    APP_VERSION: z.string().default('0.1.0'),
    /** Where people open the app. Used for CORS, cookies and links in emails. */
    PUBLIC_URL: z.url().default('http://localhost:5173'),
    CORS_ORIGIN: optional,
    DATABASE_URL: z
      .string()
      .min(1)
      .default('postgres://ticketmanager:ticketmanager@localhost:5432/ticketmanager'),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

    JWT_SECRET: z
      .string()
      .min(32, 'JWT_SECRET must be at least 32 characters')
      .default(DEV_JWT_SECRET),
    ACCESS_TOKEN_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
    REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).max(90).default(30),

    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,

    /** Creates the first admin on an empty database. Remove after the first start. */
    BOOTSTRAP_ADMIN_EMAIL: optional,
    BOOTSTRAP_ADMIN_PASSWORD: optional,
    BOOTSTRAP_ADMIN_NAME: z.string().default('Administrator'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.JWT_SECRET === DEV_JWT_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'set a real secret in production',
      });
    }
    // On a real server (https), refuse the placeholder secrets from .env.example.
    if (env.NODE_ENV === 'production' && env.PUBLIC_URL.startsWith('https://')) {
      if (env.JWT_SECRET.includes('change-me')) {
        ctx.addIssue({
          code: 'custom',
          path: ['JWT_SECRET'],
          message: 'replace the example value (e.g. openssl rand -base64 48)',
        });
      }
      if (env.DATABASE_URL.includes('change-me')) {
        ctx.addIssue({
          code: 'custom',
          path: ['POSTGRES_PASSWORD'],
          message: 'replace the example database password before the first start',
        });
      }
    }
    if (Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_CLIENT_SECRET'],
        message: 'set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither',
      });
    }
  })
  .transform((env) => ({
    ...env,
    PUBLIC_URL: env.PUBLIC_URL.replace(/\/$/, ''),
    CORS_ORIGIN: env.CORS_ORIGIN ?? env.PUBLIC_URL.replace(/\/$/, ''),
  }));

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
