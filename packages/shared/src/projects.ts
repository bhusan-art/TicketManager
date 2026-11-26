import { z } from 'zod';

/** Company projects. Each voucher can be booked to one, so Accounts can total spend per project. */
export const PROJECT_STATUSES = ['active', 'inactive'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const projectSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  /** Short code shown next to the name, e.g. PRJ-104. */
  code: optionalText(30),
  description: optionalText(200),
  status: z.enum(PROJECT_STATUSES).optional(),
});
export const updateProjectSchema = projectSchema.partial();

export interface Project {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  status: ProjectStatus;
}

/** "PRJ-104 · Metro line" or just the name. */
export const projectLabel = (p: { name: string; code?: string | null }) =>
  p.code ? `${p.code} · ${p.name}` : p.name;
