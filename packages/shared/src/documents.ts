import { z } from 'zod';
import type { Ref } from './auth.js';
import type { Role } from './roles.js';
import {
  ISO_DATE,
  PAYMENT_STATUSES,
  VOUCHER_STATUS_GROUP_NAMES,
  type VoucherStatusGroup,
} from './vouchers.js';

// ---- Bulk exports ----

/** Most vouchers in one ZIP. Narrow the filters for more. */
export const EXPORT_MAX_VOUCHERS = 500;
/** Finished ZIPs are deleted after this many days. */
export const EXPORT_KEEP_DAYS = 7;
/** A shareable download link works for this many hours. */
export const DOWNLOAD_LINK_HOURS = 24;

export const EXPORT_STATUSES = ['queued', 'running', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];
export const EXPORT_STATUS_LABELS: Record<ExportStatus, string> = {
  queued: 'Queued',
  running: 'Preparing',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired',
};

const date = z.string().regex(ISO_DATE, 'Use YYYY-MM-DD');

/** Which vouchers go into an export. Drafts never do. Dates are submission dates (IST). */
export const exportFiltersSchema = z
  .object({
    from: date.optional(),
    to: date.optional(),
    status: z
      .enum(VOUCHER_STATUS_GROUP_NAMES as [VoucherStatusGroup, ...VoucherStatusGroup[]])
      .exclude(['draft'])
      .optional(),
    paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
    departmentId: z.uuid().optional(),
    employeeId: z.uuid().optional(),
    search: z.string().trim().max(100).optional(),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, {
    message: 'The start date must be on or before the end date',
    path: ['to'],
  });
export type ExportFilters = z.infer<typeof exportFiltersSchema>;

export const createExportSchema = z.object({
  filters: exportFiltersSchema,
  /** Add the uploaded bills, not just the voucher PDFs. */
  includeProofs: z.boolean().default(true),
});

/** What an export would contain, before it is made. */
export interface ExportPreview {
  vouchers: number;
  totalPaise: number;
  proofs: number;
  proofBytes: number;
  /** True when there are more than EXPORT_MAX_VOUCHERS. */
  tooMany: boolean;
}

export interface ExportJob {
  id: string;
  status: ExportStatus;
  filters: ExportFilters;
  includeProofs: boolean;
  /** The role it was made in; it decides which vouchers were included. */
  role: Role;
  filename: string;
  vouchers: number | null;
  sizeBytes: number | null;
  error: string | null;
  downloads: number;
  createdAt: string;
  completedAt: string | null;
  /** When the ZIP is deleted. */
  expiresAt: string | null;
}

export interface DownloadLink {
  /** Absolute URL that works without signing in until it expires. */
  url: string;
  expiresAt: string;
}

// ---- Audit log ----

export const AUDIT_VIEWER_ROLES: readonly Role[] = ['admin', 'director', 'accounts'];

export const auditQuerySchema = z
  .object({
    from: date.optional(),
    to: date.optional(),
    actorId: z.uuid().optional(),
    entityType: z.string().trim().max(50).optional(),
    entityId: z.string().trim().max(100).optional(),
    /** An action, or the start of one: "voucher." matches every voucher action. */
    action: z.string().trim().max(100).optional(),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, {
    message: 'The start date must be on or before the end date',
    path: ['to'],
  });
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface AuditEntry {
  id: number;
  at: string;
  actor: Ref | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  /** A readable name for the entity, e.g. EXP-2026-00012 or a user's name. */
  entityLabel: string | null;
  before: unknown;
  after: unknown;
  meta: Record<string, unknown> | null;
  requestId: string | null;
  ip: string | null;
}

/** Values for the audit filters. */
export interface AuditFacets {
  entityTypes: string[];
  actions: string[];
  actors: Ref[];
}
