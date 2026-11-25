import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, forbidden } from '../src/http/errors.js';
import { parseBody } from '../src/http/validate.js';
import { testApp } from './helpers.js';

const router = Router();
router.get('/forbidden', () => {
  throw forbidden();
});
router.get('/boom', () => {
  throw new Error('secret internal detail');
});
router.get('/async-boom', async () => {
  await Promise.resolve();
  throw new AppError('CONFLICT', 'Already approved');
});
router.post('/validate', (req, res) => {
  const body = parseBody(z.object({ amount: z.number().positive() }), req);
  res.status(201).json(body);
});

const app = testApp({ routers: { '/t': router } });

describe('error responses', () => {
  it('uses the standard error shape with a request id', async () => {
    const res = await request(app).get('/api/v1/t/forbidden').set('X-Request-Id', 'req-12345678');
    expect(res.status).toBe(403);
    expect(res.headers['x-request-id']).toBe('req-12345678');
    expect(res.body).toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'You do not have permission to do this',
        requestId: 'req-12345678',
      },
    });
  });

  it('hides internal error details', async () => {
    const res = await request(app).get('/api/v1/t/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('catches errors thrown from async handlers', async () => {
    const res = await request(app).get('/api/v1/t/async-boom');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('turns validation failures into 400 with field details', async () => {
    const res = await request(app).post('/api/v1/t/validate').send({ amount: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details[0].path).toBe('amount');
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await request(app)
      .post('/api/v1/t/validate')
      .set('Content-Type', 'application/json')
      .send('{"amount":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns 404 in the standard shape for unknown routes', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('makes a request id when the caller sends an unsafe one', async () => {
    const res = await request(app).get('/api/v1/nope').set('X-Request-Id', '<script>');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
