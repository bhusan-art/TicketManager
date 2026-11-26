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

  it('needs both Google settings or neither', () => {
    expect(() => loadConfig({ GOOGLE_CLIENT_ID: 'x' })).toThrow(/GOOGLE_CLIENT_SECRET/);
  });
});
