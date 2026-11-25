import { pino } from 'pino';

export function createLogger(level: string, pretty = false) {
  return pino({
    level,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty' } } : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
