import type { Job } from 'bullmq';
import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { makeEmailProcessor } from '../src/jobs.js';

const job = (data: unknown) => ({ data }) as Job;

describe('email processor', () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const process = makeEmailProcessor(transport, 'TicketManager <no-reply@example.com>');

  it('sends a valid email', async () => {
    const result = await process(
      job({
        to: 'employee@example.com',
        cc: ['manager@example.com'],
        subject: 'Query',
        text: 'Hi',
      }),
    );
    expect(result.messageId).toBeTruthy();
  });

  it('rejects a job with a bad address', async () => {
    await expect(process(job({ to: 'not-an-email', subject: 's', text: 't' }))).rejects.toThrow();
  });
});
