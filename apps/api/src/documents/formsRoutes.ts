import { asc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { categories } from '../db/schema.js';
import { contentDisposition } from '../http/upload.js';
import type { Services } from '../services.js';
import { getAuthUser } from '../users/queries.js';
import { renderBlankClaimForm } from './printables.js';

/** Printable forms for when a claim has to be made on paper. */
export function formsRouter({ db }: Services) {
  const router = Router();
  router.use(requireAuth);

  /** A claim form with the caller's details filled in and empty lines to write on. */
  router.get('/claim.pdf', async (req, res) => {
    const user = await getAuthUser(db, req.auth!.userId, req.auth!.activeRole);
    const cats = await db
      .select({ name: categories.name })
      .from(categories)
      .where(eq(categories.status, 'active'))
      .orderBy(asc(categories.name));
    const pdf = await renderBlankClaimForm(
      user,
      cats.map((c) => c.name),
    );
    res
      .status(200)
      .type('application/pdf')
      .set({
        'Content-Disposition': contentDisposition('attachment', 'paper-claim-form.pdf'),
        'Cache-Control': 'private, no-store',
      })
      .end(pdf);
  });

  return router;
}
