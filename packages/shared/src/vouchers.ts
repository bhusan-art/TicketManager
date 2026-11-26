import { z } from 'zod';
import type { Ref } from './auth.js';
import type { Payment } from './payments.js';
import type { VoucherEvent, VoucherPermissions } from './workflow.js';
import { MAX_AMOUNT_PAISE } from './money.js';

/** Dates (financial years, voucher numbers, "today") are reckoned in Indian time. */
export const APP_TIME_ZONE = 'Asia/Kolkata';

/** Today's date as YYYY-MM-DD in Indian time. */
export function todayIso(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIME_ZONE }).format(now);
}

// ---- Statuses ----

/**
 * Approval and payment are two separate status fields (decision C1).
 * Phase 2 uses draft, the three "pending" entry points and cancelled; later phases use the rest.
 */
export const APPROVAL_STATUSES = [
  'draft',
  'pending_manager',
  'manager_query',
  'pending_accounts',
  'accounts_query',
  'pending_director',
  'director_query',
  'returned',
  'approved',
  'partially_approved',
  'manager_rejected',
  'accounts_rejected',
  'director_rejected',
  'cancelled',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  draft: 'Draft',
  pending_manager: 'Pending manager',
  manager_query: 'Manager query',
  pending_accounts: 'Pending accounts',
  accounts_query: 'Accounts query',
  pending_director: 'Pending director',
  director_query: 'Director query',
  returned: 'Returned',
  approved: 'Approved',
  partially_approved: 'Partially approved',
  manager_rejected: 'Rejected by manager',
  accounts_rejected: 'Rejected by accounts',
  director_rejected: 'Rejected by director',
  cancelled: 'Cancelled',
};

export const PAYMENT_STATUSES = [
  'not_due',
  'payment_pending',
  'payment_processing',
  'partially_paid',
  'paid',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  not_due: 'Not due',
  payment_pending: 'Payment pending',
  payment_processing: 'Payment processing',
  partially_paid: 'Partially paid',
  paid: 'Paid',
};

/** The tabs on My Expenses. Each groups several approval statuses. */
export const VOUCHER_STATUS_GROUPS = {
  draft: ['draft'],
  pending: [
    'pending_manager',
    'manager_query',
    'pending_accounts',
    'accounts_query',
    'pending_director',
    'director_query',
    'returned',
  ],
  approved: ['approved', 'partially_approved'],
  rejected: ['manager_rejected', 'accounts_rejected', 'director_rejected'],
  cancelled: ['cancelled'],
} as const satisfies Record<string, readonly ApprovalStatus[]>;
export type VoucherStatusGroup = keyof typeof VOUCHER_STATUS_GROUPS;
export const VOUCHER_STATUS_GROUP_NAMES = Object.keys(
  VOUCHER_STATUS_GROUPS,
) as VoucherStatusGroup[];

/** Statuses an employee may still cancel from, as long as Accounts has not started review. */
export const CANCELLABLE_STATUSES: readonly ApprovalStatus[] = [
  'pending_manager',
  'manager_query',
  'pending_accounts',
  'pending_director',
  'returned',
];

// ---- Categories ----

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const CATEGORY_STATUSES = ['active', 'inactive'] as const;

export const categorySchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(60),
  description: optionalText(200),
  status: z.enum(CATEGORY_STATUSES).optional(),
});
export const updateCategorySchema = categorySchema.partial();

export interface Category {
  id: string;
  name: string;
  description: string | null;
  status: (typeof CATEGORY_STATUSES)[number];
}

// ---- Vouchers ----

/** GSTIN: 2-digit state, 10-character PAN, entity number, 'Z', check character. */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const paise = z.number().int('Amounts are whole paise').min(0).max(MAX_AMOUNT_PAISE);

/**
 * One expense line. Drafts may be incomplete, so nearly everything is optional here;
 * `voucherSubmitIssues` decides whether a voucher can be submitted.
 */
export const voucherLineInputSchema = z.object({
  /** Leave out for a new line. Lines left out of an update are removed. */
  id: z.uuid().optional(),
  categoryId: z.uuid().nullable().optional(),
  expenseDate: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD').nullable().optional(),
  description: optionalText(500),
  vendorName: optionalText(120),
  amountPaise: paise.default(0),
  isGst: z.boolean().default(false),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .max(15)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  invoiceNumber: optionalText(40),
  cgstPaise: paise.default(0),
  sgstPaise: paise.default(0),
  igstPaise: paise.default(0),
  /** Why there is no bill. Needed for a line without proof. */
  missingProofReason: optionalText(500),
});
export type VoucherLineInput = z.input<typeof voucherLineInputSchema>;

export const createVoucherSchema = z.object({
  purpose: optionalText(200),
  lines: z.array(voucherLineInputSchema).max(50, 'A voucher can have at most 50 lines').default([]),
});
export type CreateVoucherInput = z.input<typeof createVoucherSchema>;

/** Updates replace the voucher's lines. `version` must match, or the update is rejected. */
export const updateVoucherSchema = createVoucherSchema.extend({
  version: z.number().int().min(1),
});
export type UpdateVoucherInput = z.input<typeof updateVoucherSchema>;

export const voucherActionSchema = z.object({ version: z.number().int().min(1) });

export const cancelVoucherSchema = voucherActionSchema.extend({
  reason: z.string().trim().min(3, 'Tell us why you are cancelling').max(500),
});

export const listVouchersQuerySchema = z.object({
  status: z
    .enum(VOUCHER_STATUS_GROUP_NAMES as [VoucherStatusGroup, ...VoucherStatusGroup[]])
    .optional(),
  /** Matches voucher number or purpose. */
  search: z.string().trim().max(100).optional(),
});

export const ATTACHMENT_TYPES = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
} as const;
export type AttachmentType = keyof typeof ATTACHMENT_TYPES;
export const MAX_ATTACHMENTS_PER_LINE = 5;

export interface VoucherAttachment {
  id: string;
  lineId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface VoucherLine {
  id: string;
  position: number;
  category: Ref | null;
  expenseDate: string | null;
  description: string | null;
  vendorName: string | null;
  amountPaise: number;
  isGst: boolean;
  gstin: string | null;
  invoiceNumber: string | null;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  missingProofReason: string | null;
  /** What the approvers allowed for this line. Null until someone approves. */
  approvedPaise: number | null;
  /** Why an approver reduced the line. */
  reviewNote: string | null;
  attachments: VoucherAttachment[];
}

export interface VoucherEmployee extends Ref {
  email: string;
  employeeCode: string | null;
  designation: string | null;
}

export interface VoucherDetail {
  id: string;
  /** EXP-2026-00001. Null until the voucher is submitted. */
  number: string | null;
  purpose: string | null;
  approvalStatus: ApprovalStatus;
  paymentStatus: PaymentStatus;
  totalPaise: number;
  version: number;
  employee: VoucherEmployee;
  department: Ref | null;
  /** Reporting manager at the time of submission. */
  manager: Ref | null;
  submittedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  lines: VoucherLine[];
  /** Sum of the approved line amounts, once someone has approved. */
  approvedTotalPaise: number | null;
  /** Set when Accounts opened the voucher. After that the employee can't cancel. */
  accountsReviewStartedAt: string | null;
  /** Who holds the voucher now, e.g. "Amit Verma" or "Accounts". Null when nobody does. */
  waitingOn: string | null;
  events: VoucherEvent[];
  /** Instalments, newest last, reversed ones included. */
  payments: Payment[];
  paidPaise: number;
  /** Approved but not yet paid. */
  outstandingPaise: number;
  paidAt: string | null;
  /** What the caller may do now. */
  can: VoucherPermissions;
}

export interface VoucherSummary {
  id: string;
  number: string | null;
  purpose: string | null;
  approvalStatus: ApprovalStatus;
  paymentStatus: PaymentStatus;
  totalPaise: number;
  lineCount: number;
  /** Earliest expense date on the voucher. */
  expenseDate: string | null;
  categories: string[];
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  path: string;
  message: string;
}

/** The fields of a line that submission checks. */
export type SubmittableLine = Pick<
  VoucherLine,
  | 'expenseDate'
  | 'description'
  | 'amountPaise'
  | 'isGst'
  | 'gstin'
  | 'invoiceNumber'
  | 'cgstPaise'
  | 'sgstPaise'
  | 'igstPaise'
  | 'missingProofReason'
> & { categoryId: string | null; attachmentCount: number };

/**
 * Everything that stops a voucher from being submitted, with field paths like `lines.0.gstin`.
 * The web app shows these on the review step; the API runs the same check on submit.
 */
export function voucherSubmitIssues(
  voucher: { purpose: string | null; lines: SubmittableLine[] },
  today = todayIso(),
): Issue[] {
  const issues: Issue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  if (!voucher.purpose) add('purpose', 'Enter the purpose of this expense');
  if (voucher.lines.length === 0) add('lines', 'Add at least one expense line');

  voucher.lines.forEach((line, i) => {
    const at = (field: string) => `lines.${i}.${field}`;
    if (!line.categoryId) add(at('categoryId'), 'Choose a category');
    if (!line.expenseDate) add(at('expenseDate'), 'Enter the date of the expense');
    else if (line.expenseDate > today) add(at('expenseDate'), 'The date cannot be in the future');
    if (!line.description) add(at('description'), 'Describe the expense');
    if (line.amountPaise <= 0) add(at('amountPaise'), 'Enter an amount above zero');

    if (line.isGst) {
      if (!line.gstin) add(at('gstin'), 'Enter the supplier GSTIN');
      else if (!GSTIN_PATTERN.test(line.gstin)) add(at('gstin'), 'This GSTIN is not valid');
      if (!line.invoiceNumber) add(at('invoiceNumber'), 'Enter the invoice number');
      const intra = line.cgstPaise + line.sgstPaise;
      const tax = intra + line.igstPaise;
      if (tax === 0) add(at('cgstPaise'), 'Enter CGST and SGST, or IGST');
      else if (intra > 0 && line.igstPaise > 0) {
        add(at('igstPaise'), 'Use CGST and SGST for the same state, or IGST, not both');
      } else if (line.cgstPaise !== line.sgstPaise) {
        add(at('sgstPaise'), 'CGST and SGST must be equal');
      } else if (tax >= line.amountPaise && line.amountPaise > 0) {
        add(at('cgstPaise'), 'Tax must be less than the line amount');
      }
    }

    if (line.attachmentCount === 0 && !line.missingProofReason) {
      add(at('proof'), 'Attach a bill, or explain why there is none');
    }
  });
  return issues;
}

/** Sum of the line amounts. */
export const voucherTotal = (lines: { amountPaise: number }[]) =>
  lines.reduce((sum, l) => sum + l.amountPaise, 0);
