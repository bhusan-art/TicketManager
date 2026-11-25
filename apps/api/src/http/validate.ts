import type { Request } from 'express';
import type { z } from 'zod';

/** Parse and type a part of the request. Throws ZodError, which the error handler turns into a 400. */
export function parseBody<S extends z.ZodType>(schema: S, req: Request): z.infer<S> {
  return schema.parse(req.body);
}

export function parseQuery<S extends z.ZodType>(schema: S, req: Request): z.infer<S> {
  return schema.parse(req.query);
}

export function parseParams<S extends z.ZodType>(schema: S, req: Request): z.infer<S> {
  return schema.parse(req.params);
}
