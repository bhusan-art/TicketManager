/** Roles a user can hold. A user may hold several and switch between them in the UI. */
export const ROLES = ['employee', 'manager', 'accounts', 'director', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  employee: 'Employee',
  manager: 'Manager',
  accounts: 'Accounts',
  director: 'Director',
  admin: 'Admin',
};
