import {
  formatRupees,
  parseRupees,
  rupeesInWords,
  voucherSubmitIssues,
  type SubmittableLine,
} from '@ticketmanager/shared';
import { describe, expect, it } from 'vitest';

describe('money helpers', () => {
  it('formats paise with Indian grouping', () => {
    expect(formatRupees(12_345_678_90)).toBe('₹1,23,45,678.90');
    expect(formatRupees(5)).toBe('₹0.05');
  });

  it('parses what people type', () => {
    expect(parseRupees('1,234.5')).toBe(123_450);
    expect(parseRupees('₹ 72')).toBe(7_200);
    expect(parseRupees('0.05')).toBe(5);
    expect(parseRupees('1.234')).toBeNull();
    expect(parseRupees('-5')).toBeNull();
    expect(parseRupees('abc')).toBeNull();
  });

  it('writes amounts in words, Indian style', () => {
    expect(rupeesInWords(0)).toBe('Rupees Zero Only');
    expect(rupeesInWords(720_000)).toBe('Rupees Seven Thousand Two Hundred Only');
    expect(rupeesInWords(12_500_050)).toBe(
      'Rupees One Lakh Twenty Five Thousand and Fifty Paise Only',
    );
    expect(rupeesInWords(2_00_00_000_00 + 1_100)).toBe('Rupees Two Crore Eleven Only');
  });
});

describe('voucherSubmitIssues', () => {
  const line = (over: Partial<SubmittableLine> = {}): SubmittableLine => ({
    categoryId: 'c',
    expenseDate: '2026-11-18',
    description: 'Cab',
    amountPaise: 10_000,
    isGst: false,
    gstin: null,
    invoiceNumber: null,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: 0,
    missingProofReason: null,
    attachmentCount: 1,
    ...over,
  });
  const issues = (l: SubmittableLine) =>
    voucherSubmitIssues({ purpose: 'Trip', lines: [l] }, '2026-11-26').map((i) => i.path);

  it('passes a complete line', () => {
    expect(issues(line())).toEqual([]);
  });

  it('checks GST lines', () => {
    const gst = { isGst: true, gstin: '29ABCDE1234F1Z5', invoiceNumber: 'I-1' };
    expect(issues(line({ ...gst, cgstPaise: 900, sgstPaise: 900 }))).toEqual([]);
    expect(issues(line({ ...gst, igstPaise: 1800 }))).toEqual([]);
    expect(issues(line({ ...gst }))).toEqual(['lines.0.cgstPaise']);
    expect(issues(line({ ...gst, cgstPaise: 900, sgstPaise: 900, igstPaise: 1 }))).toEqual([
      'lines.0.igstPaise',
    ]);
    expect(issues(line({ ...gst, igstPaise: 10_000 }))).toEqual(['lines.0.cgstPaise']);
    expect(issues(line({ ...gst, gstin: '29ABCDE1234F1Y5', igstPaise: 5 }))).toEqual([
      'lines.0.gstin',
    ]);
  });

  it('needs proof or a reason', () => {
    expect(issues(line({ attachmentCount: 0 }))).toEqual(['lines.0.proof']);
    expect(issues(line({ attachmentCount: 0, missingProofReason: 'Lost' }))).toEqual([]);
  });
});
