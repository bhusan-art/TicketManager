import { projectSchema, updateProjectSchema, type Project } from '@ticketmanager/shared';
import { asc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { projects } from '../db/schema.js';
import { conflict, notFound } from '../http/errors.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import type { Services } from '../services.js';

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({ all: z.enum(['true', 'false']).optional() });

export const toProject = (row: typeof projects.$inferSelect): Project => ({
  id: row.id,
  name: row.name,
  code: row.code,
  description: row.description,
  status: row.status,
});

/** Company projects. Everyone reads the active ones (to book a voucher); admins manage them. */
export function projectsRouter({ db }: Services) {
  const router = Router();
  router.use(requireAuth);

  /** Active projects, or all of them with ?all=true (admin, accounts and director: for filters). */
  router.get('/', async (req, res) => {
    const { all } = parseQuery(listQuery, req);
    const everything =
      all === 'true' && ['admin', 'accounts', 'director'].includes(req.auth!.activeRole);
    const rows = await db
      .select()
      .from(projects)
      .where(everything ? undefined : eq(projects.status, 'active'))
      .orderBy(asc(projects.name));
    res.json({ data: rows.map(toProject) });
  });

  async function assertFree(input: { name?: string; code?: string | null }, exceptId?: string) {
    if (input.name) {
      const [taken] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.name, input.name));
      if (taken && taken.id !== exceptId) throw conflict('A project with this name already exists');
    }
    if (input.code) {
      const [taken] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, input.code));
      if (taken && taken.id !== exceptId) throw conflict('A project with this code already exists');
    }
  }

  router.post('/', requireRole('admin'), async (req, res) => {
    const input = parseBody(projectSchema, req);
    await assertFree(input);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(projects)
        .values({
          name: input.name,
          code: input.code ?? null,
          description: input.description ?? null,
          status: input.status ?? 'active',
        })
        .returning();
      await recordAudit(tx, {
        action: 'project.created',
        entityType: 'project',
        entityId: created!.id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        after: input,
        req,
      });
      return created!;
    });
    res.status(201).json(toProject(row));
  });

  router.patch('/:id', requireRole('admin'), async (req, res) => {
    const { id } = parseParams(idParams, req);
    const input = parseBody(updateProjectSchema, req);
    await assertFree(input, id);
    const row = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(projects).where(eq(projects.id, id));
      if (!before) throw notFound('Project');
      const [updated] = await tx
        .update(projects)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.code !== undefined && { code: input.code }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.status !== undefined && { status: input.status }),
        })
        .where(eq(projects.id, id))
        .returning();
      await recordAudit(tx, {
        action: 'project.updated',
        entityType: 'project',
        entityId: id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        before,
        after: input,
        req,
      });
      return updated!;
    });
    res.json(toProject(row));
  });

  return router;
}
