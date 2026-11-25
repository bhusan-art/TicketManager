import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

describe('health', () => {
  it('reports ok when every dependency is up', async () => {
    const app = testApp({ healthChecks: { mongo: async () => true, redis: async () => true } });
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { mongo: 'up', redis: 'up' } });
  });

  it('reports degraded with 503 when a dependency fails', async () => {
    const app = testApp({
      healthChecks: {
        mongo: async () => true,
        storage: async () => {
          throw new Error('unreachable');
        },
      },
    });
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: 'degraded',
      checks: { mongo: 'up', storage: 'down' },
    });
  });

  it('liveness does not touch dependencies', async () => {
    const res = await request(testApp()).get('/api/v1/health/live');
    expect(res.status).toBe(200);
  });
});
