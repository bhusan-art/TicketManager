import type { AuthUser, Role, UserSummary } from '@ticketmanager/shared';
import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.js';
import { departments, users } from '../db/schema.js';

export const managers = alias(users, 'manager');

/** Columns for a user plus their department and manager names. Use with `userWithRefs()`. */
export const userColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  employeeCode: users.employeeCode,
  designation: users.designation,
  roles: users.roles,
  status: users.status,
  passwordHash: users.passwordHash,
  googleSub: users.googleSub,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  departmentId: departments.id,
  departmentName: departments.name,
  managerId: managers.id,
  managerName: managers.name,
};

export function userWithRefs(db: Db) {
  return db
    .select(userColumns)
    .from(users)
    .leftJoin(departments, eq(users.departmentId, departments.id))
    .leftJoin(managers, eq(users.managerId, managers.id));
}

type Row = Awaited<ReturnType<ReturnType<typeof userWithRefs>['execute']>>[number];

const ref = (id: string | null, name: string | null) => (id && name ? { id, name } : null);

export function toUserSummary(row: Row): UserSummary {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    employeeCode: row.employeeCode,
    designation: row.designation,
    roles: row.roles,
    status: row.status,
    department: ref(row.departmentId, row.departmentName),
    manager: ref(row.managerId, row.managerName),
    hasPassword: Boolean(row.passwordHash),
    googleLinked: Boolean(row.googleSub),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getUserSummary(db: Db, id: string) {
  const [row] = await userWithRefs(db).where(eq(users.id, id));
  return row ? toUserSummary(row) : undefined;
}

export async function getAuthUser(db: Db, id: string, activeRole: Role): Promise<AuthUser> {
  const summary = await getUserSummary(db, id);
  if (!summary) throw new Error(`User ${id} not found`);
  return {
    id: summary.id,
    email: summary.email,
    name: summary.name,
    employeeCode: summary.employeeCode,
    designation: summary.designation,
    roles: summary.roles,
    activeRole,
    department: summary.department,
    manager: summary.manager,
    hasPassword: summary.hasPassword,
    googleLinked: summary.googleLinked,
  };
}

/** The role a user lands in after signing in: the one they used last, else the most senior. */
const SIGN_IN_PRIORITY: Role[] = ['admin', 'director', 'accounts', 'manager', 'employee'];
export function defaultRole(roles: Role[], lastActiveRole: Role | null): Role {
  if (lastActiveRole && roles.includes(lastActiveRole)) return lastActiveRole;
  return SIGN_IN_PRIORITY.find((r) => roles.includes(r)) ?? roles[0]!;
}
