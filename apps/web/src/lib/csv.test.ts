import { describe, expect, it } from 'vitest';
import { csvRupees, toCsv } from './csv';

describe('toCsv', () => {
  it('quotes commas and quotes, and defuses formulas', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x, y', 'say "hi"'],
          ['=SUM(A1)', null],
        ],
      ),
    ).toBe('a,b\r\n"x, y","say ""hi"""\r\n\'=SUM(A1),\r\n');
  });
  it('writes rupees with two decimals', () => {
    expect(csvRupees(123456)).toBe('1234.56');
    expect(csvRupees(0)).toBe('0.00');
  });
});
