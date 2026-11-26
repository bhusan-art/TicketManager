/**
 * Money is always an integer number of paise (1 rupee = 100 paise), so sums never drift.
 * Convert only at the edges: parse what a person types, format what they read.
 */

/** ₹1 crore. Large enough for any single claim, small enough to catch typos. */
export const MAX_AMOUNT_PAISE = 1_00_00_000 * 100;

const groupFormat = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 123450 → "1,234.50" (Indian digit grouping). */
export function formatAmount(paise: number): string {
  return groupFormat.format(paise / 100);
}

/** 123450 → "₹1,234.50". */
export function formatRupees(paise: number): string {
  return `₹${formatAmount(paise)}`;
}

/** "1,234.5" → 123450. Returns null for anything that is not a non-negative amount with ≤ 2 decimals. */
export function parseRupees(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** 123450 → "1234.50", for filling an input box. */
export function paiseToInput(paise: number): string {
  return (paise / 100).toFixed(2);
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n]!;
  return [TENS[Math.floor(n / 10)], ONES[n % 10]].filter(Boolean).join(' ');
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? belowHundred(rest) : '']
    .filter(Boolean)
    .join(' ');
}

/** Whole number in the Indian system: 1,25,000 → "One Lakh Twenty Five Thousand". */
function integerInWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 1_00_00_000);
  const lakh = Math.floor((n % 1_00_00_000) / 1_00_000);
  const thousand = Math.floor((n % 1_00_000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(`${integerInWords(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(' ');
}

/** 123450 → "Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only". */
export function rupeesInWords(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  const words = `Rupees ${integerInWords(rupees)}`;
  return p ? `${words} and ${belowHundred(p)} Paise Only` : `${words} Only`;
}
