import { z } from 'zod';
import { ROLES, type Role } from './roles.js';
import type { EmploymentType } from './users.js';

/** Password rules, shown as a checklist on the reset and change password screens. */
export const PASSWORD_RULES = [
  { id: 'length', label: 'At least 8 characters', test: (p: string) => p.length >= 8 },
  { id: 'upper', label: 'One uppercase letter', test: (p: string) => /[A-Z]/.test(p) },
  { id: 'number', label: 'One number', test: (p: string) => /[0-9]/.test(p) },
  { id: 'special', label: 'One special character', test: (p: string) => /[^A-Za-z0-9]/.test(p) },
] as const;

export const passwordSchema = z
  .string()
  .max(128, 'Password is too long')
  .superRefine((p, ctx) => {
    for (const rule of PASSWORD_RULES) {
      if (!rule.test(p)) ctx.addIssue({ code: 'custom', message: rule.label });
    }
  });

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address'));

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(128),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  /** Not needed when the user has no password yet (e.g. signs in with Google only). */
  currentPassword: z.string().max(128).optional(),
  newPassword: passwordSchema,
});

export const switchRoleSchema = z.object({ role: z.enum(ROLES) });

export interface Ref {
  id: string;
  name: string;
}

/** The signed-in user, as returned by /auth/me and login. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  employeeCode: string | null;
  designation: string | null;
  whatsappNumber: string | null;
  employmentType: EmploymentType;
  roles: Role[];
  activeRole: Role;
  department: Ref | null;
  manager: Ref | null;
  hasPassword: boolean;
  googleLinked: boolean;
}

export interface SessionResponse {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: AuthUser;
}

export interface AuthConfigResponse {
  googleEnabled: boolean;
}

/** Error codes the Google sign-in callback puts on /login?error=… */
export const GOOGLE_LOGIN_ERRORS = {
  google_not_registered: 'This Google account is not registered. Ask your admin to add you first.',
  google_inactive: 'Your account is inactive. Contact your admin.',
  google_failed: 'Google sign-in did not complete. Please try again.',
} as const;
export type GoogleLoginError = keyof typeof GOOGLE_LOGIN_ERRORS;
