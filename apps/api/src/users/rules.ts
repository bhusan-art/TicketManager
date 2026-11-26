import { CONTRACTUAL_NEEDS_MANAGER, type EmploymentType, type Role } from '@ticketmanager/shared';
import { and, arrayContains, eq, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { departments, users } from '../db/schema.js';
import { AppError, conflict } from '../http/errors.js';

type Tx = DbOrTx;

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_FAILED', message, [{ path, message }]);

export async function assertDepartmentUsable(tx: Tx, departmentId: string) {
  const [dept] = await tx
    .select({ status: departments.status })
    .from(departments)
    .where(eq(departments.id, departmentId));
  if (!dept) throw invalid('departmentId', 'Department not found');
  if (dept.status !== 'active') throw invalid('departmentId', 'That department is inactive');
}

/**
 * A reporting manager must be an active user with the Manager role, and the reporting chain
 * can't loop back to the user.
 */
export async function assertManagerUsable(tx: Tx, userId: string | null, managerId: string) {
  if (userId && managerId === userId)
    throw invalid('managerId', 'A user cannot report to themselves');
  const [manager] = await tx
    .select({ status: users.status, roles: users.roles })
    .from(users)
    .where(eq(users.id, managerId));
  if (!manager) throw invalid('managerId', 'Manager not found');
  if (manager.status !== 'active') throw invalid('managerId', 'That manager is inactive');
  if (!manager.roles.includes('manager')) {
    throw invalid('managerId', 'The reporting manager must have the Manager role');
  }
  if (!userId) return;

  // Walk up from the new manager; reaching the user would make a loop.
  const result = await tx.execute<{ id: string }>(sql`
    with recursive chain(id, manager_id, depth) as (
      select id, manager_id, 1 from users where id = ${managerId}
      union all
      select u.id, u.manager_id, c.depth + 1 from users u
      join chain c on u.id = c.manager_id where c.depth < 50
    )
    select id from chain where id = ${userId} limit 1
  `);
  if (result.rows.length > 0) {
    throw invalid(
      'managerId',
      'That would make a reporting loop: this manager reports to the user',
    );
  }
}

/** Contractual employees always have a reporting manager; regular ones may not. */
export function assertContractualHasManager(type: EmploymentType, managerId: string | null) {
  if (type === 'contractual' && !managerId) throw invalid('managerId', CONTRACTUAL_NEEDS_MANAGER);
}

export async function countActiveReports(tx: Tx, managerId: string) {
  return tx.$count(users, and(eq(users.managerId, managerId), eq(users.status, 'active')));
}

/** Keeps at least one active admin, so nobody locks everyone out of the admin screens. */
export async function assertNotLastAdmin(tx: Tx, userId: string) {
  const others = await tx.$count(
    users,
    and(arrayContains(users.roles, ['admin']), eq(users.status, 'active'), ne(users.id, userId)),
  );
  if (others === 0) throw conflict('There must be at least one active admin');
}

export function hasRole(roles: readonly Role[], role: Role) {
  return roles.includes(role);
}
