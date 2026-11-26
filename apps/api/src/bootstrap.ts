import { passwordSchema } from '@ticketmanager/shared';
import { recordAudit } from './audit/audit.js';
import { hashPassword } from './auth/crypto.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { users } from './db/schema.js';
import type { Logger } from './lib/logger.js';

/**
 * Creates the first admin from BOOTSTRAP_ADMIN_* when the database has no users yet.
 * Does nothing once any user exists, so the variables can stay set safely.
 */
export async function bootstrapAdmin(db: Db, config: Config, logger: Logger) {
  const email = config.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = config.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) return false;
  if ((await db.$count(users)) > 0) return false;

  const check = passwordSchema.safeParse(password);
  if (!check.success) {
    throw new Error(
      `BOOTSTRAP_ADMIN_PASSWORD is too weak: ${check.error.issues.map((i) => i.message).join(', ')}`,
    );
  }
  const [admin] = await db
    .insert(users)
    .values({
      email,
      name: config.BOOTSTRAP_ADMIN_NAME,
      roles: ['admin', 'employee'],
      passwordHash: await hashPassword(password),
      passwordChangedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (!admin) return false;
  await recordAudit(db, { action: 'user.bootstrapped', entityType: 'user', entityId: admin.id });
  logger.info({ email }, 'Created the first admin user');
  return true;
}
