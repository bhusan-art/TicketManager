import { describe, expect, it } from 'vitest';
import { formatWhatsApp, normalizeWhatsApp, whatsAppLink } from './whatsapp.js';

describe('WhatsApp numbers', () => {
  it.each([
    ['98765 43210', '919876543210'],
    ['098765-43210', '919876543210'],
    ['+91 98765 43210', '919876543210'],
    ['0091 9876543210', '919876543210'],
    ['+44 7700 900123', '447700900123'],
    ['+1 (415) 555-0132', '14155550132'],
  ])('reads %s as %s', (input, digits) => {
    expect(normalizeWhatsApp(input)).toBe(digits);
  });

  it.each(['12345', 'call me', '+91 98765', '55555 55555', '+0 1234567890'])(
    'refuses %s',
    (input) => {
      expect(normalizeWhatsApp(input)).toBeNull();
    },
  );

  it('formats and links', () => {
    expect(formatWhatsApp('919876543210')).toBe('+91 98765 43210');
    expect(formatWhatsApp('447700900123')).toBe('+447700900123');
    expect(whatsAppLink('919876543210', 'Hi Rahul, ₹500 & more')).toBe(
      'https://wa.me/919876543210?text=Hi%20Rahul%2C%20%E2%82%B9500%20%26%20more',
    );
  });
});
