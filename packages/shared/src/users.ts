import { z } from 'zod';
import { emailSchema, type Ref } from './auth.js';
import { ROLES, type Role } from './roles.js';
import { whatsappNumberField } from './whatsapp.js';

export const USER_STATUSES = ['active', 'inactive'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const optionalId = z.uuid().nullable().optional();

export const createUserSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1, 'Enter a name').max(120),
  employeeCode: optionalText(40),
  designation: optionalText(120),
  /** Mobile number linked to WhatsApp, for click-to-chat messages. */
  whatsappNumber: whatsappNumberField,
  departmentId: optionalId,
  managerId: optionalId,
  roles: z.array(z.enum(ROLES)).min(1, 'Pick at least one role'),
  /** Email the user a link to set their password. */
  sendInvite: z.boolean().default(true),
});
export type CreateUserInput = z.input<typeof createUserSchema>;

export const updateUserSchema = createUserSchema
  .omit({ sendInvite: true })
  .partial()
  .extend({ status: z.enum(USER_STATUSES).optional() });
export type UpdateUserInput = z.input<typeof updateUserSchema>;

export const listUsersQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  role: z.enum(ROLES).optional(),
  departmentId: z.uuid().optional(),
  status: z.enum(USER_STATUSES).optional(),
});

export interface UserSummary {
  id: string;
  email: string;
  name: string;
  employeeCode: string | null;
  designation: string | null;
  /** International digits, e.g. 919876543210. */
  whatsappNumber: string | null;
  roles: Role[];
  status: UserStatus;
  department: Ref | null;
  manager: Ref | null;
  hasPassword: boolean;
  googleLinked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export const departmentSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(80),
  code: optionalText(20),
  headId: optionalId,
  status: z.enum(USER_STATUSES).optional(),
});
export const updateDepartmentSchema = departmentSchema.partial();

export interface DepartmentSummary {
  id: string;
  name: string;
  code: string | null;
  head: Ref | null;
  status: UserStatus;
  activeMembers: number;
}
