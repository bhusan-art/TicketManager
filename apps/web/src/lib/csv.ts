/** Turns rows into CSV text. Quotes every field that needs it; guards against formula injection. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v);
    // A cell starting with = + - @ would run as a formula in Excel.
    if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Paise as a plain rupee number for spreadsheets: 123456 → "1234.56". */
export const csvRupees = (paise: number) => (paise / 100).toFixed(2);

export function downloadCsv(filename: string, text: string) {
  // The BOM makes Excel read the file as UTF-8 (₹ and Indian names).
  const blob = new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
