import { APP_TIME_ZONE } from '@ticketmanager/shared';
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { documentCounters } from '../db/schema.js';

export type DocumentKind = 'EXP' | 'ADV' | 'PAY';

export function currentYear(now = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en', { timeZone: APP_TIME_ZONE, year: 'numeric' }).format(now),
  );
}

/**
 * The next number for a document, e.g. EXP-2026-00042. Numbers restart at 1 each calendar year
 * (Indian time). Call it inside the transaction that saves the document: the counter row stays
 * locked until that transaction ends, so numbers are unique and have no gaps.
 */
export async function nextDocumentNumber(tx: DbOrTx, kind: DocumentKind, now = new Date()) {
  const year = currentYear(now);
  const [row] = await tx
    .insert(documentCounters)
    .values({ kind, year, lastValue: 1 })
    .onConflictDoUpdate({
      target: [documentCounters.kind, documentCounters.year],
      set: { lastValue: sql`${documentCounters.lastValue} + 1` },
    })
    .returning({ value: documentCounters.lastValue });
  return `${kind}-${year}-${String(row!.value).padStart(5, '0')}`;
}
