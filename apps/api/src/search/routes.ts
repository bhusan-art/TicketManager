import { SEARCH_LIMIT, searchQuerySchema, type SearchResponse } from '@ticketmanager/shared';
import { and, desc, eq, ilike, isNotNull, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { advances, users, vouchers } from '../db/schema.js';
import { parseQuery } from '../http/validate.js';
import type { Services } from '../services.js';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The top-bar search. Finds only what the caller may open, by the same rules as opening a claim
 * or an advance: their own, the ones sent to them as manager, and every submitted one for
 * Accounts and the Director. Admins also find people.
 */
export function searchRouter({ db }: Services) {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const { q } = parseQuery(searchQuerySchema, req);
    const { userId, activeRole } = req.auth!;
    const term = like(q);
    const seesAll = activeRole === 'accounts' || activeRole === 'director';
    const employee = alias(users, 'employee');

    const visible = (t: typeof vouchers | typeof advances): SQL =>
      or(
        eq(t.employeeId, userId),
        and(eq(t.managerId, userId), isNotNull(t.submittedAt)),
        ...(seesAll ? [isNotNull(t.submittedAt)] : []),
      )!;
    // Someone else's claim opens from the queue page that fits the role.
    const reviewBase = activeRole === 'accounts' ? '/verification' : '/approvals';

    const [claims, advanceRows, people] = await Promise.all([
      db
        .select({
          id: vouchers.id,
          number: vouchers.number,
          purpose: vouchers.purpose,
          status: vouchers.approvalStatus,
          totalPaise: vouchers.totalPaise,
          employeeId: vouchers.employeeId,
          employee: employee.name,
        })
        .from(vouchers)
        .innerJoin(employee, eq(employee.id, vouchers.employeeId))
        .where(
          and(
            visible(vouchers),
            or(
              ilike(vouchers.number, term),
              ilike(vouchers.purpose, term),
              ilike(employee.name, term),
              ilike(employee.employeeCode, term),
            ),
          ),
        )
        .orderBy(desc(vouchers.updatedAt))
        .limit(SEARCH_LIMIT),
      db
        .select({
          id: advances.id,
          number: advances.number,
          purpose: advances.purpose,
          status: advances.status,
          requestedPaise: advances.requestedPaise,
          approvedPaise: advances.approvedPaise,
          employee: employee.name,
        })
        .from(advances)
        .innerJoin(employee, eq(employee.id, advances.employeeId))
        .where(
          and(
            visible(advances),
            or(
              ilike(advances.number, term),
              ilike(advances.purpose, term),
              ilike(employee.name, term),
              ilike(employee.employeeCode, term),
            ),
          ),
        )
        .orderBy(desc(advances.updatedAt))
        .limit(SEARCH_LIMIT),
      activeRole === 'admin'
        ? db
            .select({
              id: users.id,
              name: users.name,
              email: users.email,
              employeeCode: users.employeeCode,
            })
            .from(users)
            .where(
              or(
                ilike(users.name, term),
                ilike(users.email, term),
                ilike(users.employeeCode, term),
              ),
            )
            .orderBy(users.name)
            .limit(SEARCH_LIMIT)
        : Promise.resolve([]),
    ]);

    const body: SearchResponse = {
      claims: claims.map((v) => ({
        id: v.id,
        title: v.purpose || 'Untitled claim',
        subtitle: [v.number ?? 'Draft', v.employeeId === userId ? null : v.employee]
          .filter(Boolean)
          .join(' · '),
        path: v.employeeId === userId ? `/expenses/${v.id}` : `${reviewBase}/${v.id}`,
        amountPaise: v.totalPaise,
        status: v.status,
      })),
      advances: advanceRows.map((a) => ({
        id: a.id,
        title: a.purpose,
        subtitle: [a.number ?? 'Draft', a.employee].join(' · '),
        path: `/advances/${a.id}`,
        amountPaise: a.approvedPaise ?? a.requestedPaise,
        status: a.status,
      })),
      people: people.map((p) => ({
        id: p.id,
        title: p.name,
        subtitle: [p.employeeCode, p.email].filter(Boolean).join(' · '),
        path: `/admin/users/${p.id}`,
      })),
    };
    res.json(body);
  });

  return router;
}
