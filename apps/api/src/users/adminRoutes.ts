import {
  createUserSchema,
  departmentSchema,
  listUsersQuerySchema,
  paginationQuerySchema,
  updateDepartmentSchema,
  updateUserSchema,
  type DepartmentSummary,
} from '@ticketmanager/shared';
import { and, arrayContains, asc, count, eq, ilike, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { createPasswordToken, passwordLink } from '../auth/passwordTokens.js';
import { requireRole } from '../auth/middleware.js';
import { revokeAllForUser } from '../auth/sessions.js';
import { departments, users } from '../db/schema.js';
import { AppError, conflict, notFound } from '../http/errors.js';
import { paginate } from '../http/pagination.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import { inviteEmail } from '../mail/templates.js';
import type { Services } from '../services.js';
import { getUserSummary, managers, toUserSummary, userWithRefs } from './queries.js';
import {
  assertDepartmentUsable,
  assertManagerUsable,
  assertNotLastAdmin,
  countActiveReports,
} from './rules.js';

const idParams = z.object({ id: z.uuid() });

/** Admin screens: users, roles, departments and reporting managers. Admin role only. */
export function adminRouter(services: Services) {
  const { db, mailer, config } = services;
  const router = Router();
  router.use(requireRole('admin'));

  async function sendInvite(userId: string, email: string, name: string) {
    const token = await createPasswordToken(db, userId, 'invite');
    await mailer.send(inviteEmail(email, name, passwordLink(config.PUBLIC_URL, token, 'invite')));
  }

  // ---- Users ----

  router.get('/users', async (req, res) => {
    const page = parseQuery(paginationQuerySchema, req);
    const filters = parseQuery(listUsersQuerySchema, req);
    const where: SQL[] = [];
    if (filters.search) {
      const term = `%${filters.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        or(ilike(users.name, term), ilike(users.email, term), ilike(users.employeeCode, term))!,
      );
    }
    if (filters.role) where.push(arrayContains(users.roles, [filters.role]));
    if (filters.departmentId) where.push(eq(users.departmentId, filters.departmentId));
    if (filters.status) where.push(eq(users.status, filters.status));
    const condition = where.length ? and(...where) : undefined;

    const result = await paginate({
      query: page,
      sortable: {
        name: users.name,
        email: users.email,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      },
      defaultSort: 'name',
      tiebreaker: users.id,
      fetch: ({ orderBy, limit, offset }) =>
        userWithRefs(db)
          .where(condition)
          .orderBy(...orderBy)
          .limit(limit)
          .offset(offset),
      count: () => db.$count(users, condition),
    });
    res.json({ data: result.data.map(toUserSummary), meta: result.meta });
  });

  router.get('/users/:id', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const user = await getUserSummary(db, id);
    if (!user) throw notFound('User');
    res.json(user);
  });

  router.post('/users', async (req, res) => {
    const input = parseBody(createUserSchema, req);
    const created = await db.transaction(async (tx) => {
      if (input.departmentId) await assertDepartmentUsable(tx, input.departmentId);
      if (input.managerId) await assertManagerUsable(tx, null, input.managerId);
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, input.email));
      if (existing) throw conflict('A user with this email already exists');

      const [row] = await tx
        .insert(users)
        .values({
          email: input.email,
          name: input.name,
          employeeCode: input.employeeCode ?? null,
          designation: input.designation ?? null,
          whatsappNumber: input.whatsappNumber ?? null,
          departmentId: input.departmentId ?? null,
          managerId: input.managerId ?? null,
          roles: [...new Set(input.roles)],
        })
        .returning({ id: users.id });
      await recordAudit(tx, {
        action: 'user.created',
        entityType: 'user',
        entityId: row!.id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        after: { ...input, sendInvite: undefined },
        req,
      });
      return row!;
    });
    if (input.sendInvite) await sendInvite(created.id, input.email, input.name);
    res.status(201).json(await getUserSummary(db, created.id));
  });

  router.patch('/users/:id', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const input = parseBody(updateUserSchema, req);
    await db.transaction(async (tx) => {
      const [before] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (!before) throw notFound('User');

      const roles = input.roles ? [...new Set(input.roles)] : before.roles;
      const status = input.status ?? before.status;

      if (input.email && input.email !== before.email) {
        const [taken] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, input.email));
        if (taken) throw conflict('A user with this email already exists');
      }
      if (input.departmentId && input.departmentId !== before.departmentId) {
        await assertDepartmentUsable(tx, input.departmentId);
      }
      if (input.managerId && input.managerId !== before.managerId) {
        await assertManagerUsable(tx, id, input.managerId);
      }
      const losesManager =
        before.roles.includes('manager') && (!roles.includes('manager') || status !== 'active');
      if (losesManager) {
        const reports = await countActiveReports(tx, id);
        if (reports > 0) {
          throw conflict(
            `${reports} active ${reports === 1 ? 'person reports' : 'people report'} to this user. Assign them another manager first.`,
            { activeReports: reports },
          );
        }
      }
      const losesAdmin =
        before.roles.includes('admin') &&
        before.status === 'active' &&
        (!roles.includes('admin') || status !== 'active');
      if (losesAdmin) await assertNotLastAdmin(tx, id);

      const changes = {
        ...(input.email !== undefined && { email: input.email }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.employeeCode !== undefined && { employeeCode: input.employeeCode }),
        ...(input.designation !== undefined && { designation: input.designation }),
        ...(input.whatsappNumber !== undefined && { whatsappNumber: input.whatsappNumber }),
        ...(input.departmentId !== undefined && { departmentId: input.departmentId }),
        ...(input.managerId !== undefined && { managerId: input.managerId }),
        ...(input.roles !== undefined && { roles }),
        ...(input.status !== undefined && { status }),
      };
      await tx.update(users).set(changes).where(eq(users.id, id));
      if (status !== 'active' && before.status === 'active') await revokeAllForUser(tx, id);

      const { passwordHash: _p, googleSub: _g, ...beforeSafe } = before;
      await recordAudit(tx, {
        action: 'user.updated',
        entityType: 'user',
        entityId: id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        before: beforeSafe,
        after: changes,
        req,
      });
    });
    res.json(await getUserSummary(db, id));
  });

  /** Emails the user a fresh link to set their password (also works as an admin-sent reset). */
  router.post('/users/:id/invite', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const [user] = await db.select().from(users).where(eq(users.id, id));
    if (!user) throw notFound('User');
    if (user.status !== 'active') throw conflict('This user is inactive');
    await sendInvite(user.id, user.email, user.name);
    await recordAudit(db, {
      action: 'user.invite_sent',
      entityType: 'user',
      entityId: id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.activeRole,
      req,
    });
    res.status(204).end();
  });

  // ---- Departments ----

  async function listDepartments(id?: string): Promise<DepartmentSummary[]> {
    const members = alias(users, 'member');
    const rows = await db
      .select({
        id: departments.id,
        name: departments.name,
        code: departments.code,
        status: departments.status,
        headId: managers.id,
        headName: managers.name,
        activeMembers: count(members.id),
      })
      .from(departments)
      .leftJoin(managers, eq(managers.id, departments.headId))
      .leftJoin(
        members,
        and(eq(members.departmentId, departments.id), eq(members.status, 'active')),
      )
      .where(id ? eq(departments.id, id) : undefined)
      .groupBy(departments.id, managers.id)
      .orderBy(asc(departments.name));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      status: r.status,
      head: r.headId && r.headName ? { id: r.headId, name: r.headName } : null,
      activeMembers: r.activeMembers,
    }));
  }

  router.get('/departments', async (_req, res) => {
    res.json({ data: await listDepartments() });
  });

  async function assertHeadUsable(tx: Pick<typeof db, 'select'>, headId: string) {
    const [head] = await tx
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, headId));
    if (!head || head.status !== 'active') {
      throw new AppError('VALIDATION_FAILED', 'The department head must be an active user', [
        { path: 'headId', message: 'The department head must be an active user' },
      ]);
    }
  }

  router.post('/departments', async (req, res) => {
    const input = parseBody(departmentSchema, req);
    const id = await db.transaction(async (tx) => {
      if (input.headId) await assertHeadUsable(tx, input.headId);
      const [row] = await tx
        .insert(departments)
        .values({
          name: input.name,
          code: input.code ?? null,
          headId: input.headId ?? null,
          status: input.status ?? 'active',
        })
        .returning({ id: departments.id });
      await recordAudit(tx, {
        action: 'department.created',
        entityType: 'department',
        entityId: row!.id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        after: input,
        req,
      });
      return row!.id;
    });
    res.status(201).json((await listDepartments(id))[0]);
  });

  router.patch('/departments/:id', async (req, res) => {
    const { id } = parseParams(idParams, req);
    const input = parseBody(updateDepartmentSchema, req);
    await db.transaction(async (tx) => {
      const [before] = await tx.select().from(departments).where(eq(departments.id, id));
      if (!before) throw notFound('Department');
      if (input.headId) await assertHeadUsable(tx, input.headId);
      await tx
        .update(departments)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.code !== undefined && { code: input.code }),
          ...(input.headId !== undefined && { headId: input.headId }),
          ...(input.status !== undefined && { status: input.status }),
        })
        .where(eq(departments.id, id));
      await recordAudit(tx, {
        action: 'department.updated',
        entityType: 'department',
        entityId: id,
        actorId: req.auth!.userId,
        actorRole: req.auth!.activeRole,
        before,
        after: input,
        req,
      });
    });
    res.json((await listDepartments(id))[0]);
  });

  return router;
}
