import type { AccessTokens } from './auth/accessToken.js';
import type { GoogleClient } from './auth/google.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { ExportRunner } from './documents/runner.js';
import type { Mailer } from './mail/mailer.js';

/** Everything route handlers need, created once in server.ts (or a test). */
export interface Services {
  db: Db;
  config: Config;
  mailer: Mailer;
  /** Builds bulk ZIP exports in the background. */
  exports: ExportRunner;
  tokens: AccessTokens;
  /** null when Google sign-in isn't configured. */
  google: GoogleClient | null;
}
