import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config', () => {
  it('uses PUBLIC_URL for CORS by default', () => {
    const c = loadConfig({ PUBLIC_URL: 'http://localhost:9080/' });
    expect(c.PUBLIC_URL).toBe('http://localhost:9080');
    expect(c.CORS_ORIGIN).toBe('http://localhost:9080');
  });

  it('refuses the development JWT secret in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
  });

  it('refuses the .env.example secrets on an https server', () => {
    const base = {
      NODE_ENV: 'production',
      PUBLIC_URL: 'https://expenses.example.com',
      JWT_SECRET: 'change-me-to-at-least-32-random-characters-please',
      DATABASE_URL: 'postgres://ticketmanager:change-me-to-a-long-random-string@postgres/tm',
    };
    expect(() => loadConfig(base)).toThrow(/JWT_SECRET[\s\S]*POSTGRES_PASSWORD/);
    // Fine on a local http trial run.
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'http://localhost:9080' })).not.toThrow();
    expect(() =>
      loadConfig({
        ...base,
        JWT_SECRET: 'a'.repeat(48),
        DATABASE_URL: 'postgres://ticketmanager:s3cret-long-password@postgres/tm',
      }),
    ).not.toThrow();
  });

  it('needs both Google settings or neither', () => {
    expect(() => loadConfig({ GOOGLE_CLIENT_ID: 'x' })).toThrow(/GOOGLE_CLIENT_SECRET/);
  });
});
