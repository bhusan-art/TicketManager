import {
  APP_TIME_ZONE,
  APPROVAL_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  formatAmount,
  rupeesInWords,
  type VoucherDetail,
} from '@ticketmanager/shared';
import PDFDocument from 'pdfkit';

const GREEN = '#0B7F5B';
const INK = '#1F2933';
const MUTED = '#6B7280';
const RULE = '#D9DEE3';
const SHADE = '#F3F6F5';

// The built-in PDF fonts have no ₹ glyph, so amounts read "Rs. 1,234.50".
const rs = (paise: number) => `Rs. ${formatAmount(paise)}`;

const dateFormat = new Intl.DateTimeFormat('en-IN', {
  timeZone: APP_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
const dateTimeFormat = new Intl.DateTimeFormat('en-IN', {
  timeZone: APP_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
/** "2026-11-18" → "18 Nov 2026" without time-zone shifts. */
const day = (iso: string | null) =>
  iso ? dateFormat.format(new Date(`${iso}T12:00:00+05:30`)) : '-';
const when = (iso: string | null) => (iso ? dateTimeFormat.format(new Date(iso)) : '-');

/** The printable voucher: header, claimant, lines, GST summary, proofs and signature boxes. */
export function renderVoucherPdf(v: VoucherDetail): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    bufferPages: true,
    info: {
      Title: `Expense voucher ${v.number ?? '(draft)'}`,
      Author: v.employee.name,
      Creator: 'TicketManager',
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 30;
  const ensure = (height: number) => {
    if (doc.y + height > bottom()) doc.addPage();
  };

  // ---- Header ----
  doc.rect(left, 40, width, 4).fill(GREEN);
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(16).text('TicketManager', left, 56);
  doc.fillColor(INK).fontSize(12).text('Expense Voucher', left, 76);
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(v.number ?? 'DRAFT', left, 56, { width, align: 'right' });
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text(
      `${APPROVAL_STATUS_LABELS[v.approvalStatus]} · ${PAYMENT_STATUS_LABELS[v.paymentStatus]}`,
      left,
      76,
      { width, align: 'right' },
    );
  doc.y = 104;

  // ---- Claimant ----
  const facts: [string, string][] = [
    ['Employee', v.employee.name],
    ['Employee code', v.employee.employeeCode ?? '-'],
    ['Designation', v.employee.designation ?? '-'],
    ['Department', v.department?.name ?? '-'],
    ['Reporting manager', v.manager?.name ?? '-'],
    ['Submitted', when(v.submittedAt)],
  ];
  const col = width / 2;
  const top = doc.y;
  doc.rect(left, top, width, 70).fill(SHADE);
  facts.forEach(([label, value], i) => {
    const x = left + 10 + (i % 2) * col;
    const y = top + 8 + Math.floor(i / 2) * 20;
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(label, x, y);
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(9)
      .text(value, x, y + 9, { width: col - 20, lineBreak: false, ellipsis: true });
  });
  doc.y = top + 80;
  doc.fillColor(MUTED).font('Helvetica').fontSize(8).text('Purpose', left);
  doc
    .fillColor(INK)
    .font('Helvetica')
    .fontSize(10)
    .text(v.purpose ?? '-', left, doc.y + 2, { width });
  doc.moveDown(0.8);

  // ---- Lines ----
  const cols = [
    { title: '#', w: 22, align: 'left' as const },
    { title: 'Date', w: 66, align: 'left' as const },
    { title: 'Category', w: 90, align: 'left' as const },
    { title: 'Description', w: 0, align: 'left' as const },
    { title: 'GST', w: 92, align: 'left' as const },
    { title: 'Amount', w: 78, align: 'right' as const },
  ];
  cols[3]!.w = width - cols.reduce((s, c) => s + c.w, 0);
  const pad = 4;

  const header = () => {
    const y = doc.y;
    doc.rect(left, y, width, 18).fill(GREEN);
    let x = left;
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8);
    for (const c of cols) {
      doc.text(c.title, x + pad, y + 5, { width: c.w - pad * 2, align: c.align });
      x += c.w;
    }
    doc.y = y + 18;
  };
  ensure(40);
  header();

  v.lines.forEach((line, i) => {
    const description = [
      line.description ?? '-',
      line.vendorName ? `Vendor: ${line.vendorName}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const gst = line.isGst
      ? [
          line.gstin ?? '',
          line.invoiceNumber ? `Inv ${line.invoiceNumber}` : '',
          line.igstPaise
            ? `IGST ${formatAmount(line.igstPaise)}`
            : `CGST ${formatAmount(line.cgstPaise)} / SGST ${formatAmount(line.sgstPaise)}`,
        ]
          .filter(Boolean)
          .join('\n')
      : 'Non-GST';
    const cells = [
      String(i + 1),
      day(line.expenseDate),
      line.category?.name ?? '-',
      description,
      gst,
      formatAmount(line.amountPaise),
    ];
    doc.font('Helvetica').fontSize(8);
    const height =
      Math.max(
        ...cells.map((text, c) => doc.heightOfString(text, { width: cols[c]!.w - pad * 2 })),
      ) +
      pad * 2;
    if (doc.y + height > bottom()) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    if (i % 2 === 1) doc.rect(left, y, width, height).fill(SHADE);
    let x = left;
    doc.fillColor(INK);
    cells.forEach((text, c) => {
      doc.text(text, x + pad, y + pad, { width: cols[c]!.w - pad * 2, align: cols[c]!.align });
      x += cols[c]!.w;
    });
    doc.y = y + height;
    doc
      .moveTo(left, doc.y)
      .lineTo(left + width, doc.y)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
  });

  // ---- Totals ----
  ensure(60);
  doc.moveDown(0.5);
  const totalsY = doc.y;
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(INK)
    .text(`Total claimed: ${rs(v.totalPaise)}`, left, totalsY, { width, align: 'right' });
  doc
    .font('Helvetica-Oblique')
    .fontSize(8)
    .fillColor(MUTED)
    .text(rupeesInWords(v.totalPaise), left, doc.y + 2, { width, align: 'right' });
  doc.moveDown(1);

  const gstLines = v.lines.filter((l) => l.isGst);
  if (gstLines.length) {
    const sum = (k: 'cgstPaise' | 'sgstPaise' | 'igstPaise') =>
      gstLines.reduce((s, l) => s + l[k], 0);
    const tax = sum('cgstPaise') + sum('sgstPaise') + sum('igstPaise');
    const gross = gstLines.reduce((s, l) => s + l.amountPaise, 0);
    ensure(50);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('GST summary', left);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(INK)
      .text(
        `Taxable value ${rs(gross - tax)}   CGST ${rs(sum('cgstPaise'))}   SGST ${rs(sum('sgstPaise'))}   IGST ${rs(sum('igstPaise'))}   Total GST ${rs(tax)}`,
        left,
        doc.y + 2,
        { width },
      );
    doc.moveDown(0.8);
  }

  const missing = v.lines
    .map((l, i) => ({ n: i + 1, reason: l.missingProofReason, files: l.attachments.length }))
    .filter((l) => l.files === 0 && l.reason);
  if (missing.length) {
    ensure(40);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Lines without a bill', left);
    doc.font('Helvetica').fontSize(8);
    for (const m of missing) doc.text(`Line ${m.n}: ${m.reason}`, left, doc.y + 2, { width });
    doc.moveDown(0.8);
  }

  const proofs = v.lines.flatMap((l, i) =>
    l.attachments.map((a) => `Line ${i + 1}: ${a.filename}`),
  );
  ensure(30);
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(INK)
    .text(`Proofs attached (${proofs.length})`, left);
  doc
    .font('Helvetica')
    .fontSize(8)
    .text(proofs.length ? proofs.join('\n') : 'None', left, doc.y + 2, { width });
  doc.moveDown(1);

  if (v.cancelledAt) {
    ensure(30);
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#B42318')
      .text(`Cancelled on ${when(v.cancelledAt)}: ${v.cancelReason ?? ''}`, left, doc.y, { width });
    doc.moveDown(1);
  }

  // ---- Signatures ----
  ensure(70);
  const boxW = (width - 20) / 3;
  const sigY = Math.max(doc.y + 10, bottom() - 50);
  ['Employee', 'Reporting manager', 'Accounts'].forEach((label, i) => {
    const x = left + i * (boxW + 10);
    doc
      .moveTo(x, sigY + 30)
      .lineTo(x + boxW, sigY + 30)
      .strokeColor(INK)
      .lineWidth(0.5)
      .stroke();
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(label, x, sigY + 34, { width: boxW });
  });

  // ---- Footer and draft mark on every page ----
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    if (!v.number) {
      doc.save();
      doc
        .rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] })
        .font('Helvetica-Bold')
        .fontSize(90)
        .fillColor('#B42318')
        .opacity(0.08)
        .text('DRAFT', 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center' });
      doc.restore();
    }
    const footerY = doc.page.height - doc.page.margins.bottom - 10;
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor(MUTED)
      .text(`Generated ${when(new Date().toISOString())} by TicketManager`, left, footerY, {
        width,
        lineBreak: false,
      })
      .text(`Page ${p - range.start + 1} of ${range.count}`, left, footerY, {
        width,
        align: 'right',
        lineBreak: false,
      });
  }
  doc.end();
  return done;
}
