import {
  APP_TIME_ZONE,
  APPROVAL_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  type VoucherDetail,
} from '@ticketmanager/shared';
import { eq } from 'drizzle-orm';
import { zipSync, type Zippable } from 'fflate';
import type { AuthContext } from '../auth/middleware.js';
import type { DbOrTx } from '../db/client.js';
import { files, voucherAttachments, vouchers } from '../db/schema.js';
import { renderVoucherPdf } from '../vouchers/pdf.js';
import { getVoucherDetail } from '../vouchers/queries.js';
import { canView } from '../vouchers/workflow.js';

/** Largest ZIP the app builds. */
export const EXPORT_MAX_BYTES = 250 * 1024 * 1024;

export class ExportTooLargeError extends Error {}
export class NoVouchersError extends Error {}

/** Safe in a file name on Windows, macOS and Linux. */
export function safeName(name: string, max = 80): string {
  const cleaned = name
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- control characters are what we strip
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  return (cleaned || 'file').slice(0, max);
}

/** CSV cell, guarded against spreadsheet formulas. */
function cell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  // The BOM makes Excel read the file as UTF-8.
  return '\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const rupees = (paise: number | null) => (paise === null ? '' : (paise / 100).toFixed(2));
const istDate = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIME_ZONE }).format(new Date(iso)) : '';

const MANIFEST_HEADER = [
  'Voucher',
  'Employee',
  'Employee code',
  'Department',
  'Purpose',
  'Submitted on',
  'Approval status',
  'Payment status',
  'Claimed (Rs)',
  'Approved (Rs)',
  'Paid (Rs)',
  'Lines',
  'Folder',
  'Files',
];

export interface ZipResult {
  data: Buffer;
  vouchers: number;
  files: number;
}

/**
 * One folder per voucher with its PDF and (optionally) every uploaded bill, plus manifest.csv
 * listing each voucher and the files in its folder. Vouchers the person can't open are skipped.
 */
export async function buildVoucherZip(
  db: DbOrTx,
  auth: AuthContext,
  voucherIds: string[],
  includeProofs: boolean,
): Promise<ZipResult> {
  const zip: Zippable = {};
  const manifest: (string | number | null)[][] = [MANIFEST_HEADER];
  let bytes = 0;
  let fileCount = 0;
  const add = (path: string, data: Uint8Array, compress: boolean) => {
    bytes += data.length;
    if (bytes > EXPORT_MAX_BYTES) throw new ExportTooLargeError('The export is larger than 250 MB');
    zip[path] = [data, { level: compress ? 6 : 0 }];
    fileCount += 1;
  };
  const usedFolders = new Set<string>();

  for (const id of voucherIds) {
    const [row] = await db.select().from(vouchers).where(eq(vouchers.id, id));
    if (!row || !canView(auth, row)) continue;
    const v = await getVoucherDetail(db, id, auth);
    if (!v) continue;
    const number = v.number ?? `draft-${v.id.slice(0, 8)}`;
    let folder = safeName(`${number} ${v.employee.name}`);
    for (let n = 2; usedFolders.has(folder); n++)
      folder = safeName(`${number} ${v.employee.name} (${n})`);
    usedFolders.add(folder);

    const listed: string[] = [];
    add(`${folder}/${number}.pdf`, await renderVoucherPdf(v), false);
    listed.push(`${number}.pdf`);
    if (includeProofs) {
      for (const [path, data] of await proofs(db, v)) {
        add(`${folder}/${path}`, data, false);
        listed.push(path);
      }
    }
    manifest.push(manifestRow(v, folder, listed));
  }

  add('manifest.csv', Buffer.from(toCsv(manifest), 'utf8'), true);
  if (manifest.length === 1) throw new NoVouchersError('No vouchers you can open match');
  return {
    data: Buffer.from(zipSync(zip)),
    vouchers: manifest.length - 1,
    files: fileCount,
  };
}

function manifestRow(v: VoucherDetail, folder: string, listed: string[]) {
  return [
    v.number,
    v.employee.name,
    v.employee.employeeCode,
    v.department?.name ?? null,
    v.purpose,
    istDate(v.submittedAt),
    APPROVAL_STATUS_LABELS[v.approvalStatus],
    PAYMENT_STATUS_LABELS[v.paymentStatus],
    rupees(v.totalPaise),
    rupees(v.approvedTotalPaise),
    rupees(v.paidPaise),
    v.lines.length,
    folder,
    listed.join('; '),
  ];
}

/** "proofs/line-1-taxi-bill.pdf", numbered by line, with repeated names made unique. */
async function proofs(db: DbOrTx, v: VoucherDetail): Promise<[string, Uint8Array][]> {
  const rows = await db
    .select({ id: voucherAttachments.id, data: files.data })
    .from(voucherAttachments)
    .innerJoin(files, eq(files.id, voucherAttachments.fileId))
    .where(eq(voucherAttachments.voucherId, v.id));
  const data = new Map(rows.map((r) => [r.id, r.data]));
  const out: [string, Uint8Array][] = [];
  const used = new Set<string>();
  for (const line of v.lines) {
    for (const a of line.attachments) {
      const bytes = data.get(a.id);
      if (!bytes) continue;
      const dot = a.filename.lastIndexOf('.');
      const stem = safeName(dot > 0 ? a.filename.slice(0, dot) : a.filename, 60);
      const ext = dot > 0 ? safeName(a.filename.slice(dot + 1), 10).toLowerCase() : 'bin';
      let name = `proofs/line-${line.position + 1}-${stem}.${ext}`;
      for (let n = 2; used.has(name); n++)
        name = `proofs/line-${line.position + 1}-${stem}-${n}.${ext}`;
      used.add(name);
      out.push([name, bytes]);
    }
  }
  return out;
}
