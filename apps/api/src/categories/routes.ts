import { categorySchema, updateCategorySchema, type Category } from '@ticketmanager/shared';
import { asc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { categories } from '../db/schema.js';
import { conflict, notFound } from '../http/errors.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import type { Services } from '../services.js';

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({ all: z.enum(['true', 'false']).optional() });

const toCategory = (row: typeof categories.$inferSelect): Category => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
});

/** Expense categories. Everyone reads the active ones; admins manage them. */
export function categoriesRouter({ db }: Services) {
  const router = Router();
  router.use(requireAuth);

  /** Active categories, or all of them with ?all=true (admin only). */
  router.get('/', async (req, res) => {
    const { all } = parseQuery(listQuery, req);
    const everything = all === 'true' && req.auth!.activeRole === 'admin';
    const rows = await db
      .select()
      .from(categories)
      .where(everything ? undefined : eq(categories.status, 'active'))
      .orderBy(asc(categories.name));
    res.json({ data: rows.map(toCategory) });
  });

  async function assertNameFree(name: string, exceptId?: string) {
    const [taken] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.name, name));
    if (taken && taken.id !== exceptId) throw conflict('A category with this name already exists');
  }

  router.post('/', requireRole('admin'), async (req, res) => {
    const input = parseBody(categorySchema, req);
    await assertNameFree(input.name);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(categories)
        .values({
          name: input.name,
          description: input.description ?? null,
          status: input.status ?? 'active',
        })
        .returning();
      await recordAudit(tx, {
        action: 'category.created',
        entityType: 'category',
        entityId: created!.id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        after: input,
        req,
      });
      return created!;
    });
    res.status(201).json(toCategory(row));
  });

  router.patch('/:id', requireRole('admin'), async (req, res) => {
    const { id } = parseParams(idParams, req);
    const input = parseBody(updateCategorySchema, req);
    if (input.name) await assertNameFree(input.name, id);
    const row = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(categories).where(eq(categories.id, id));
      if (!before) throw notFound('Category');
      const [updated] = await tx
        .update(categories)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.status !== undefined && { status: input.status }),
        })
        .where(eq(categories.id, id))
        .returning();
      await recordAudit(tx, {
        action: 'category.updated',
        entityType: 'category',
        entityId: id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        before,
        after: input,
        req,
      });
      return updated!;
    });
    res.json(toCategory(row));
  });

  return router;
}
