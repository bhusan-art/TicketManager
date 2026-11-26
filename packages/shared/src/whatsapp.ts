import { z } from 'zod';

/**
 * WhatsApp without the Business API: the app opens WhatsApp ("click to chat") with the person's
 * number and a ready message, and the sender taps Send. Numbers are stored as international
 * digits without "+", e.g. 919876543210.
 */

/** "98765 43210", "+91 98765-43210", "0098765…" → "919876543210". Null when it isn't a number. */
export function normalizeWhatsApp(input: string): string | null {
  const raw = input.trim();
  if (!/^[+\d][\d\s().-]*$/.test(raw)) return null;
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) {
    // Already international.
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (/^[6-9]\d{9}$/.test(digits)) {
    // A 10-digit Indian mobile number.
    digits = `91${digits}`;
  } else if (/^0[6-9]\d{9}$/.test(digits)) {
    digits = `91${digits.slice(1)}`;
  }
  return /^[1-9]\d{10,14}$/.test(digits) ? digits : null;
}

/** "+91 98765 43210" for Indian numbers, "+447700900123" otherwise. */
export function formatWhatsApp(digits: string): string {
  const m = /^91(\d{5})(\d{5})$/.exec(digits);
  return m ? `+91 ${m[1]} ${m[2]}` : `+${digits}`;
}

/** Opens a chat with the number and the message filled in, on phone or computer. */
export function whatsAppLink(digits: string, text: string): string {
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** Optional form field: empty clears it. */
export const whatsappNumberField = z
  .string()
  .trim()
  .max(30)
  .transform((v, ctx) => {
    if (v === '') return null;
    const n = normalizeWhatsApp(v);
    if (!n) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Enter a mobile number like 98765 43210, or with the country code like +44 7700 900123',
      });
      return z.NEVER;
    }
    return n;
  })
  .nullable()
  .optional();

export const updateWhatsAppSchema = z.object({ whatsappNumber: whatsappNumberField });

/** A ready WhatsApp message to someone about a claim or advance. */
export interface WhatsAppSuggestion {
  to: { id: string; name: string };
  /** Why this person, e.g. "Employee", "Reporting manager", "Accounts". */
  reason: string;
  /** International digits. */
  number: string;
  text: string;
  /** wa.me link with the text filled in. */
  url: string;
}

export interface WhatsAppSuggestions {
  suggestions: WhatsAppSuggestion[];
  /** People who should get it but have no WhatsApp number saved. */
  missing: { id: string; name: string }[];
}
