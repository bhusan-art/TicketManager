import { z } from 'zod';
import type { Ref } from './auth.js';
import { ISO_DATE } from './vouchers.js';
import type { ApprovalStatus, PaymentStatus, VoucherSummary } from './vouchers.js';

/**
 * Payments against approved vouchers. A voucher can be paid in instalments; the paid total can
 * never exceed the approved total. A payment is never deleted: a mistake is reversed, with a
 * reason, and the reversal stays on record.
 */

export const PAYMENT_MODES = ['bank_transfer', 'upi', 'cheque', 'cash'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  bank_transfer: 'Bank transfer (NEFT/RTGS/IMPS)',
  upi: 'UPI',
  cheque: 'Cheque',
  cash: 'Cash',
};

/** Modes that need a reference: the UTR for transfers and UPI, the cheque number for cheques. */
export const REFERENCE_LABELS: Partial<Record<PaymentMode, string>> = {
  bank_transfer: 'UTR number',
  upi: 'UPI reference (UTR)',
  cheque: 'Cheque number',
};

export const recordPaymentSchema = z
  .object({
    version: z.number().int().min(1),
    amountPaise: z.number().int().min(1, 'Enter an amount above zero'),
    paidOn: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD'),
    mode: z.enum(PAYMENT_MODES),
    reference: z
      .string()
      .trim()
      .toUpperCase()
      .max(40)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
    note: z
      .string()
      .trim()
      .max(500)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
  })
  .superRefine((p, ctx) => {
    const label = REFERENCE_LABELS[p.mode];
    if (label && !p.reference) {
      ctx.addIssue({ code: 'custom', path: ['reference'], message: `Enter the ${label}` });
    }
  });
export type RecordPaymentInput = z.input<typeof recordPaymentSchema>;

export const reversePaymentSchema = z.object({
  version: z.number().int().min(1),
  reason: z.string().trim().min(3, 'Say why this payment is being reversed').max(500),
});

export interface Payment {
  id: string;
  /** PAY-2026-00001 */
  number: string;
  amountPaise: number;
  paidOn: string;
  mode: PaymentMode;
  reference: string | null;
  note: string | null;
  recordedBy: Ref | null;
  createdAt: string;
  reversedAt: string | null;
  reversedBy: Ref | null;
  reversalReason: string | null;
}

/** Money on a voucher, in paise. */
export interface VoucherMoney {
  approvedPaise: number;
  paidPaise: number;
  outstandingPaise: number;
}

export const PAYMENT_QUEUE_VIEWS = ['due', 'paid', 'all'] as const;
export type PaymentQueueView = (typeof PAYMENT_QUEUE_VIEWS)[number];

export const paymentQueueQuerySchema = z.object({
  view: z.enum(PAYMENT_QUEUE_VIEWS).default('due'),
  search: z.string().trim().max(100).optional(),
});

export interface PaymentQueueItem extends VoucherSummary, VoucherMoney {
  employee: Ref & { employeeCode: string | null };
  department: Ref | null;
  decidedAt: string | null;
  paidAt: string | null;
}

// ---- Dashboard and reports ----

export interface AccountsDashboard {
  toVerify: { count: number; amountPaise: number };
  awaitingPayment: { count: number; amountPaise: number };
  paidThisMonth: { count: number; amountPaise: number };
  claimedThisMonth: { count: number; amountPaise: number };
  /** Approved but unpaid, by how long ago it was approved. */
  liabilityAging: {
    bucket: '0-7' | '8-30' | '31-60' | '60+';
    count: number;
    amountPaise: number;
  }[];
  /** Approved and paid per month, last 6 months (oldest first). */
  monthly: { month: string; approvedPaise: number; paidPaise: number }[];
}

export const reportQuerySchema = z.object({
  /** Vouchers submitted on or after this date. */
  from: z.string().regex(ISO_DATE).optional(),
  /** Vouchers submitted on or before this date. */
  to: z.string().regex(ISO_DATE).optional(),
  departmentId: z.uuid().optional(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export interface ReportRow extends VoucherMoney {
  key: Ref | null;
  vouchers: number;
  claimedPaise: number;
  /** Still waiting for a decision. */
  inReviewPaise: number;
  rejectedPaise: number;
}

export interface ReportResponse {
  byDepartment: ReportRow[];
  byEmployee: (ReportRow & { employeeCode: string | null; department: string | null })[];
  byCategory: Omit<
    ReportRow,
    'inReviewPaise' | 'rejectedPaise' | 'paidPaise' | 'outstandingPaise'
  >[];
  totals: Omit<ReportRow, 'key'>;
}

/** Approved, unpaid vouchers: what the company owes its people right now. */
export interface LiabilityRow {
  id: string;
  number: string;
  employee: Ref;
  department: Ref | null;
  approvalStatus: ApprovalStatus;
  paymentStatus: PaymentStatus;
  decidedAt: string | null;
  ageDays: number;
  approvedPaise: number;
  paidPaise: number;
  outstandingPaise: number;
}
