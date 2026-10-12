/**
 * Validation Middleware
 *
 * Zod-based request validation for body, query, and params.
 */

import { Context, Next } from 'hono';
import { z, ZodSchema } from 'zod';

export function validateBody<T extends ZodSchema>(schema: T) {
  return async (c: Context, next: Next): Promise<void> => {
    const body = await c.req.json();
    const result = schema.safeParse(body);

    if (!result.success) {
      throw result.error;
    }

    c.set('validatedBody', result.data);
    await next();
  };
}

export function validateQuery<T extends ZodSchema>(schema: T) {
  return async (c: Context, next: Next): Promise<void> => {
    const query = c.req.query();
    const result = schema.safeParse(query);

    if (!result.success) {
      throw result.error;
    }

    c.set('validatedQuery', result.data);
    await next();
  };
}

export function validateParams<T extends ZodSchema>(schema: T) {
  return async (c: Context, next: Next): Promise<void> => {
    const params = c.req.param();
    const result = schema.safeParse(params);

    if (!result.success) {
      throw result.error;
    }

    c.set('validatedParams', result.data);
    await next();
  };
}

// Common schemas
export const IdParamSchema = z.object({
  id: z.string().min(1),
});

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});
