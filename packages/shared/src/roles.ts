/** Roles a user can hold. A user may hold several and switch between them in the UI. */
export const ROLES = ['employee', 'manager', 'accounts', 'admin', 'director'] as const;
export type Role = (typeof ROLES)[number];
