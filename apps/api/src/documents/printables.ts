import {
  ADVANCE_STATUS_LABELS,
  APP_TIME_ZONE,
  PAYMENT_MODE_LABELS,
  formatAmount,
  rupeesInWords,
  type AdvanceDetail,
  type AuthUser,
} from '@ticketmanager/shared';
import PDFDocument from 'pdfkit';

// Same look as the voucher PDF (vouchers/pdf.ts).
const GREEN = '#0B7F5B';
const INK = '#1F2933';
const MUTED = '#6B7280';
const RULE = '#D9DEE3';
const SHADE = '#F3F6F5';

// The built-in PDF fonts have no ₹ glyph.
const rs = (paise: number) => `Rs. ${formatAmount(paise)}`;
const dateFormat = new Intl.DateTimeFormat('en-IN', {
  timeZone: APP_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
const day = (iso: string | null) =>
  iso ? dateFormat.format(new Date(`${iso.slice(0, 10)}T12:00:00+05:30`)) : '-';
const stamp = (d = new Date()) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: APP_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);

type Doc = InstanceType<typeof PDFDocument>;

function start(title: string, author: string) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    bufferPages: true,
    info: { Title: title, Author: author, Creator: 'TicketManager' },
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
  return { doc, done, left, width, bottom };
}

function header(doc: Doc, left: number, width: number, title: string, right: string, sub: string) {
  doc.rect(left, 40, width, 4).fill(GREEN);
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(16).text('TicketManager', left, 56);
  doc.fillColor(INK).fontSize(12).text(title, left, 76);
  doc.font('Helvetica-Bold').fontSize(14).text(right, left, 56, { width, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(sub, left, 76, { width, align: 'right' });
  doc.y = 104;
}

/** Two columns of label/value pairs on a shaded box. A blank value leaves a line to write on. */
function facts(doc: Doc, left: number, width: number, rows: [string, string | null][]) {
  const col = width / 2;
  const top = doc.y;
  const height = Math.ceil(rows.length / 2) * 25 + 10;
  doc.rect(left, top, width, height).fill(SHADE);
  rows.forEach(([label, value], i) => {
    const x = left + 10 + (i % 2) * col;
    const y = top + 8 + Math.floor(i / 2) * 25;
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(label, x, y);
    if (value) {
      doc
        .fillColor(INK)
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(value, x, y + 9, { width: col - 20, lineBreak: false, ellipsis: true });
    } else {
      writeLine(doc, x, y + 19, col - 30);
    }
  });
  doc.y = top + height + 10;
}

function writeLine(doc: Doc, x: number, y: number, w: number) {
  doc
    .moveTo(x, y)
    .lineTo(x + w, y)
    .strokeColor(MUTED)
    .lineWidth(0.5)
    .stroke();
}

function signatures(doc: Doc, left: number, width: number, y: number, labels: string[]) {
  const boxW = (width - 10 * (labels.length - 1)) / labels.length;
  labels.forEach((label, i) => {
    const x = left + i * (boxW + 10);
    writeLine(doc, x, y + 30, boxW);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(`${label}: signature and date`, x, y + 34, { width: boxW });
  });
}

function footer(doc: Doc, left: number, width: number, note: string) {
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    const y = doc.page.height - doc.page.margins.bottom - 10;
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor(MUTED)
      .text(note, left, y, { width, lineBreak: false })
      .text(`Page ${p - range.start + 1} of ${range.count}`, left, y, {
        width,
        align: 'right',
        lineBreak: false,
      });
  }
}

/** How many empty lines the paper form has. */
export const BLANK_FORM_LINES = 12;

/**
 * A claim form to fill in by hand when the app can't be used: the person's details already
 * printed, empty lines for the expenses, the categories to choose from, and signature boxes.
 * Accounts types it into TicketManager later.
 */
export function renderBlankClaimForm(user: AuthUser, categoryNames: string[]): Promise<Buffer> {
  const { doc, done, left, width, bottom } = start('Expense claim form (paper)', user.name);
  header(doc, left, width, 'Expense Claim Form', 'Paper claim', 'Claim no. given by Accounts');
  doc.moveDown(0.2);

  facts(doc, left, width, [
    ['Employee', user.name],
    ['Employee code', user.employeeCode],
    ['Designation', user.designation],
    ['Department', user.department?.name ?? null],
    ['Reporting manager', user.manager?.name ?? null],
    ['Project (if any)', null],
  ]);

  doc.fillColor(MUTED).font('Helvetica').fontSize(8).text('Purpose of the expenses', left);
  writeLine(doc, left, doc.y + 14, width);
  doc.y += 22;

  const cols = [
    { title: '#', w: 20 },
    { title: 'Date', w: 58 },
    { title: 'Category', w: 80 },
    { title: 'Description and vendor', w: 0 },
    { title: 'GST bill? GSTIN / Invoice no.', w: 118 },
    { title: 'Amount (Rs.)', w: 70 },
  ];
  cols[3]!.w = width - cols.reduce((s, c) => s + c.w, 0);
  const rowH = 24;
  let y = doc.y;
  doc.rect(left, y, width, 18).fill(GREEN);
  let x = left;
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8);
  for (const c of cols) {
    doc.text(c.title, x + 4, y + 5, { width: c.w - 8, lineBreak: false, ellipsis: true });
    x += c.w;
  }
  y += 18;
  for (let i = 0; i < BLANK_FORM_LINES; i++) {
    if (i % 2 === 1) doc.rect(left, y, width, rowH).fill(SHADE);
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(8)
      .text(String(i + 1), left + 4, y + 8);
    x = left;
    for (const c of cols) {
      x += c.w;
      doc
        .moveTo(x, y)
        .lineTo(x, y + rowH)
        .strokeColor(RULE)
        .lineWidth(0.5)
        .stroke();
    }
    y += rowH;
    doc
      .moveTo(left, y)
      .lineTo(left + width, y)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
  }
  doc
    .rect(left, y - rowH * BLANK_FORM_LINES - 18, width, rowH * BLANK_FORM_LINES + 18)
    .strokeColor(RULE)
    .lineWidth(0.5)
    .stroke();
  doc.y = y + 10;

  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(INK)
    .text('Total claimed: Rs.', left, doc.y, {
      width: width - 130,
      align: 'right',
    });
  writeLine(doc, left + width - 120, doc.y + 2, 120);
  doc.moveDown(0.6);
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('Amount in words', left);
  writeLine(doc, left, doc.y + 12, width);
  doc.y += 22;

  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Categories', left);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(INK)
    .text(categoryNames.length ? categoryNames.join('  ·  ') : '-', left, doc.y + 2, { width });
  doc.moveDown(0.8);

  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('How to submit on paper', left);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(INK)
    .list(
      [
        'Write one expense per line. For a GST bill, write the supplier GSTIN and invoice number.',
        'Number every bill to match its line and staple them to this form.',
        'Sign below and hand the form to your reporting manager, or to Accounts if you have none.',
        'Accounts enters the claim in TicketManager, where you can follow it like any other claim.',
      ],
      left,
      doc.y + 4,
      { width, bulletRadius: 1.5, textIndent: 8 },
    );
  doc.moveDown(0.6);
  doc
    .font('Helvetica-Oblique')
    .fontSize(8)
    .fillColor(INK)
    .text(
      'I declare that these expenses were incurred for company work and are not claimed elsewhere.',
      left,
      doc.y,
      { width },
    );

  signatures(doc, left, width, Math.max(doc.y + 6, bottom() - 50), [
    'Employee',
    'Reporting manager',
    'Accounts',
  ]);
  footer(doc, left, width, `Printed ${stamp()} from TicketManager · paper claim form`);
  doc.end();
  return done;
}

const KIND_LABELS = { disbursement: 'Paid out', return: 'Returned', top_up: 'Top-up' } as const;

/** An advance on paper: who, why, how much, every payment, and where the settlement stands. */
export function renderAdvancePdf(a: AdvanceDetail): Promise<Buffer> {
  const { doc, done, left, width, bottom } = start(
    `Advance ${a.number ?? '(draft)'}`,
    a.employee.name,
  );
  const ensure = (h: number) => {
    if (doc.y + h > bottom()) doc.addPage();
  };
  header(
    doc,
    left,
    width,
    'Advance Request',
    a.number ?? 'DRAFT',
    `${ADVANCE_STATUS_LABELS[a.status]}${a.overdue ? ' · Overdue' : ''}`,
  );

  facts(doc, left, width, [
    ['Employee', a.employee.name],
    ['Employee code', a.employee.employeeCode ?? '-'],
    ['Department', a.department?.name ?? '-'],
    ['Reporting manager', a.manager?.name ?? '-'],
    ['Requested on', day(a.submittedAt)],
    ['Needed by', day(a.expectedDate)],
    ['Paid out on', day(a.disbursedAt)],
    ['Settle by', day(a.settleBy)],
  ]);
  doc.fillColor(MUTED).font('Helvetica').fontSize(8).text('Purpose', left);
  doc
    .fillColor(INK)
    .fontSize(10)
    .text(a.purpose, left, doc.y + 2, { width });
  if (a.notes) {
    doc
      .fillColor(MUTED)
      .fontSize(8)
      .text(a.notes, left, doc.y + 2, { width });
  }
  doc.moveDown(0.8);

  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(INK)
    .text(`Requested: ${rs(a.requestedPaise)}`, left, doc.y, { width, align: 'right' });
  doc
    .font('Helvetica-Oblique')
    .fontSize(8)
    .fillColor(MUTED)
    .text(rupeesInWords(a.requestedPaise), left, doc.y + 2, { width, align: 'right' });
  if (a.approvedPaise !== null) {
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(GREEN)
      .text(`Approved: ${rs(a.approvedPaise)}`, left, doc.y + 4, { width, align: 'right' });
  }
  doc.moveDown(1);

  // Payments both ways.
  const live = a.transactions.filter((t) => !t.reversedAt);
  ensure(60);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Payments', left);
  doc.moveDown(0.3);
  if (live.length === 0) {
    doc.font('Helvetica').fontSize(8).text('None yet', left);
  } else {
    for (const t of live) {
      ensure(16);
      const y = doc.y;
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(INK)
        .text(
          `${day(t.paidOn)}   ${KIND_LABELS[t.kind]} by ${PAYMENT_MODE_LABELS[t.mode]}${t.reference ? ` (${t.reference})` : ''}`,
          left,
          y,
          { width: width - 100 },
        )
        .text(rs(t.amountPaise), left, y, { width, align: 'right' });
      doc.y = Math.max(doc.y, y + 12);
    }
  }
  doc.moveDown(0.8);

  // Claims tagged to it and the settlement.
  if (a.vouchers.length) {
    ensure(40);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Claims against this advance', left);
    doc.moveDown(0.3);
    for (const v of a.vouchers) {
      ensure(16);
      const y = doc.y;
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(INK)
        .text(`${v.number ?? 'Draft'}   ${v.purpose ?? ''}`, left, y, { width: width - 100 })
        .text(rs(v.approvedTotalPaise ?? v.totalPaise), left, y, { width, align: 'right' });
      doc.y = Math.max(doc.y, y + 12);
    }
    doc.moveDown(0.8);
  }

  const s = a.settlement;
  if (s.disbursedPaise > 0) {
    ensure(70);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Settlement', left);
    const rows: [string, number][] = [
      ['Paid out', s.disbursedPaise + s.topUpPaise],
      ['Approved expenses', s.approvedExpensesPaise],
      ['Returned', s.returnedPaise],
    ];
    if (s.dueBackPaise > 0) rows.push(['Still to return', s.dueBackPaise]);
    if (s.payablePaise > 0) rows.push(['Still owed to the employee', s.payablePaise]);
    for (const [label, value] of rows) {
      const y = doc.y + 2;
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(INK)
        .text(label, left, y)
        .text(rs(value), left, y, { width, align: 'right' });
    }
    doc.moveDown(0.8);
  }

  ensure(70);
  signatures(doc, left, width, Math.max(doc.y + 10, bottom() - 50), [
    'Employee',
    'Reporting manager',
    'Accounts',
  ]);
  footer(doc, left, width, `Generated ${stamp()} by TicketManager`);
  doc.end();
  return done;
}
