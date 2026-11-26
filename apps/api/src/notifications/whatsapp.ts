import {
  formatRupees,
  isReviewStage,
  whatsAppLink,
  type WhatsAppSuggestions,
} from '@ticketmanager/shared';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import type { Db } from '../db/client.js';
import { advanceEvents, advances, users, voucherEvents, vouchers } from '../db/schema.js';
import { canViewAdvance } from '../advances/workflow.js';
import { notFound } from '../http/errors.js';
import { parseParams } from '../http/validate.js';
import type { Services } from '../services.js';
import { canView } from '../vouchers/workflow.js';
import { advanceHolder, voucherHolder } from './holders.js';
import type { Recipient } from './notify.js';
import { voucherLink } from './voucherNotices.js';

const idParams = z.object({ id: z.uuid() });

interface Person {
  id: string;
  name: string;
  whatsappNumber: string | null;
}

async function people(db: Db, ids: string[]): Promise<Map<string, Person>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name, whatsappNumber: users.whatsappNumber })
    .from(users)
    .where(and(inArray(users.id, ids), eq(users.status, 'active')));
  return new Map(rows.map((r) => [r.id, r]));
}

interface Draft {
  to: Recipient;
  reason: string;
  /** Message without the greeting; the link is added at the end. */
  text: string;
  link: string;
}

async function finish(db: Db, publicUrl: string, drafts: Draft[]): Promise<WhatsAppSuggestions> {
  const found = await people(
    db,
    drafts.map((d) => d.to.userId),
  );
  const out: WhatsAppSuggestions = { suggestions: [], missing: [] };
  const base = publicUrl.replace(/\/$/, '');
  for (const d of drafts) {
    const p = found.get(d.to.userId);
    if (!p) continue;
    if (!p.whatsappNumber) {
      out.missing.push({ id: p.id, name: p.name });
      continue;
    }
    const text = `Hi ${p.name.split(' ')[0]}, ${d.text}\n\n${base}${d.link}`;
    out.suggestions.push({
      to: { id: p.id, name: p.name },
      reason: d.reason,
      number: p.whatsappNumber,
      text,
      url: whatsAppLink(p.whatsappNumber, text),
    });
  }
  return out;
}

const quote = (m: string | null) => (m ? `\n\n“${m}”` : '');
const name = async (db: Db, id: string | null) =>
  id
    ? ((await db.select({ name: users.name }).from(users).where(eq(users.id, id)))[0]?.name ??
      'Someone')
    : 'Someone';

async function voucherDrafts(db: Db, req: Request, id: string): Promise<Draft[]> {
  const [v] = await db.select().from(vouchers).where(eq(vouchers.id, id));
  if (!v || !canView(req.auth!, v)) throw notFound('Voucher');
  const me = req.auth!.userId;
  const num = v.number ?? 'my draft claim';
  const what = `${num}${v.purpose ? ` (${v.purpose}, ${formatRupees(v.totalPaise)})` : ` (${formatRupees(v.totalPaise)})`}`;

  if (v.employeeId === me) {
    const managerName = (await people(db, v.managerId ? [v.managerId] : [])).get(
      v.managerId ?? '',
    )?.name;
    const holder = await voucherHolder(db, v, managerName ?? null);
    if (!holder) return [];
    return holder.recipients.map((r) => ({
      to: r,
      reason: holder.label === 'Accounts' ? 'Accounts' : 'Waiting on them',
      text: `a gentle reminder: my expense claim ${what} is waiting for your ${holder.step}.`,
      link: voucherLink(v.id, r.role, holder.step === 'payment'),
    }));
  }

  // To the employee, about the latest step.
  const [e] = await db
    .select()
    .from(voucherEvents)
    .where(and(eq(voucherEvents.voucherId, v.id), isNotNull(voucherEvents.actorId)))
    .orderBy(desc(voucherEvents.id))
    .limit(1);
  const actor = e && e.actorId !== v.employeeId ? await name(db, e.actorId) : null;
  let text = `about your expense claim ${what}.`;
  if (e && actor) {
    switch (e.type) {
      case 'queried':
        text = `${actor} has a question about your expense claim ${what}:${quote(e.message)}\n\nPlease answer it in TicketManager.`;
        break;
      case 'returned':
        text = `${actor} returned your expense claim ${what} for changes:${quote(e.message)}\n\nPlease update and resubmit it.`;
        break;
      case 'rejected':
        text = `${actor} rejected your expense claim ${what}.${quote(e.message)}`;
        break;
      case 'approved':
        text = isReviewStage(v.approvalStatus)
          ? `${actor} approved your expense claim ${what}. It has gone on for verification.`
          : `your expense claim ${what} is approved for ${formatRupees(v.approvedTotalPaise ?? 0)}. ${v.advanceId ? 'It is settled against your advance.' : 'Accounts will pay it.'}`;
        break;
      case 'payment_recorded':
        text = `${formatRupees(Number((e.meta as { amountPaise?: number } | null)?.amountPaise ?? 0))} has been paid for your expense claim ${what}.`;
        break;
    }
  }
  return [
    {
      to: { userId: v.employeeId, role: 'employee' },
      reason: 'Employee',
      text,
      link: voucherLink(v.id, 'employee'),
    },
  ];
}

async function advanceDrafts(db: Db, req: Request, id: string): Promise<Draft[]> {
  const [a] = await db.select().from(advances).where(eq(advances.id, id));
  if (!a || !canViewAdvance(req.auth!, a)) throw notFound('Advance');
  const me = req.auth!.userId;
  const link = `/advances/${a.id}`;
  const what = `${a.number ?? 'my advance request'} (${a.purpose}, ${formatRupees(a.approvedPaise ?? a.requestedPaise)})`;

  if (a.employeeId === me) {
    const managerName = (await people(db, a.managerId ? [a.managerId] : [])).get(
      a.managerId ?? '',
    )?.name;
    const holder = await advanceHolder(db, a, managerName ?? null);
    if (!holder) return [];
    return holder.recipients.map((r) => ({
      to: r,
      reason: holder.label === 'Accounts' ? 'Accounts' : 'Waiting on them',
      text: `a gentle reminder: my advance ${what} is waiting for your ${holder.step}.`,
      link,
    }));
  }

  const [e] = await db
    .select()
    .from(advanceEvents)
    .where(and(eq(advanceEvents.advanceId, a.id), isNotNull(advanceEvents.actorId)))
    .orderBy(desc(advanceEvents.id))
    .limit(1);
  const actor = e && e.actorId !== a.employeeId ? await name(db, e.actorId) : null;
  const amount = formatRupees(
    Number((e?.meta as { amountPaise?: number } | null)?.amountPaise ?? 0),
  );
  let text = `about your advance ${what}.`;
  if (e && actor) {
    switch (e.type) {
      case 'approved':
        text =
          a.status === 'approved'
            ? `your advance ${what} is approved. Accounts will pay it out.`
            : `${actor} approved your advance ${what}. It has gone on for approval.`;
        break;
      case 'returned':
        text = `${actor} returned your advance request ${what} for changes:${quote(e.message)}`;
        break;
      case 'rejected':
        text = `${actor} rejected your advance request ${what}.${quote(e.message)}`;
        break;
      case 'disbursed':
        text = `${amount} has been paid out for your advance ${what}. Please tag your expense claims to it and settle it on time.`;
        break;
      case 'closed':
        text = `your advance ${what} is settled and closed.`;
        break;
    }
  }
  return [{ to: { userId: a.employeeId, role: 'employee' }, reason: 'Employee', text, link }];
}

/** GET /vouchers/:id/whatsapp and /advances/:id/whatsapp: ready-to-send WhatsApp messages. */
export function whatsAppRouter(kind: 'voucher' | 'advance', { db, config }: Services) {
  const router = Router();
  router.get('/:id/whatsapp', requireAuth, async (req, res) => {
    const { id } = parseParams(idParams, req);
    const drafts =
      kind === 'voucher' ? await voucherDrafts(db, req, id) : await advanceDrafts(db, req, id);
    res.json(await finish(db, config.PUBLIC_URL, drafts));
  });
  return router;
}
