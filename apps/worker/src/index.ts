import { writeFile } from 'node:fs/promises';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { makeEmailProcessor, QUEUES } from './jobs.js';
import { deliverDue } from './outbox.js';
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SECONDS } from '@ticketmanager/shared';

/** Docker's health check looks at this file's age. */
const HEARTBEAT_FILE = '/tmp/worker-heartbeat';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const connection = { url: config.REDIS_URL };
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 3 });

const transport = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE,
  auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
  // Fail fast when the mail server is unreachable, so one bad send doesn't hold up the rest.
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 30_000,
});

const queue = new Queue(QUEUES.email, { connection });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });

/**
 * Shows the worker is alive and its job loop is running: a Redis key the API's health check
 * reads, and a file Docker's health check looks at. Beats on every outbox sweep.
 */
async function beat() {
  const at = new Date().toISOString();
  try {
    await redis.set(WORKER_HEARTBEAT_KEY, at, 'EX', WORKER_HEARTBEAT_TTL_SECONDS);
    await writeFile(HEARTBEAT_FILE, at);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Heartbeat failed');
  }
}

// Emails jobs queued by an older API carry the email itself; finish those directly.
const legacy = makeEmailProcessor(transport, config.MAIL_FROM);

const emailWorker = new Worker(
  QUEUES.email,
  async (job) => {
    if (job.name === 'send') return legacy(job);
    await beat();
    const result = await deliverDue(
      pool,
      async (mail) => {
        const info = await transport.sendMail({ from: config.MAIL_FROM, ...mail });
        return { messageId: info.messageId };
      },
      {
        publicUrl: config.PUBLIC_URL,
        onError: (email, err) =>
          logger.warn(
            { emailId: email.id, attempt: email.attempts, err: err.message },
            'Email failed',
          ),
      },
    );
    if (result.sent || result.retrying || result.failed) logger.info(result, 'Outbox delivered');
    await beat();
    return result;
  },
  // One at a time: each run drains everything that is due.
  { connection, concurrency: 1 },
);

emailWorker.on('failed', (job, err) =>
  logger.warn({ jobId: job?.id, err: err.message }, 'Email job failed'),
);
emailWorker.on('ready', () => {
  logger.info('Worker connected to Redis');
  void beat();
});

// Sweep regularly, so retries go out and nothing waits on a lost wake-up.
await queue.upsertJobScheduler(
  'outbox-sweep',
  { every: config.OUTBOX_SWEEP_SECONDS * 1000 },
  { name: 'deliver', data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
);

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down worker');
  await emailWorker.close();
  await queue.close();
  redis.disconnect();
  await pool.end();
  transport.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
