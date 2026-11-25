import { Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { makeEmailProcessor, QUEUES } from './jobs.js';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const connection = { url: config.REDIS_URL };

const transport = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE,
  auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
});

const emailWorker = new Worker(QUEUES.email, makeEmailProcessor(transport, config.MAIL_FROM), {
  connection,
  concurrency: 5,
});

emailWorker.on('completed', (job) => logger.info({ jobId: job.id }, 'Email sent'));
emailWorker.on('failed', (job, err) =>
  logger.warn({ jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'Email failed'),
);
emailWorker.on('ready', () => logger.info('Worker connected to Redis'));

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down worker');
  await emailWorker.close();
  transport.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
