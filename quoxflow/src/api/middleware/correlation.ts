/**
 * Correlation ID Middleware
 *
 * Handles X-Correlation-ID header for request tracing.
 */

import { Context, Next } from 'hono';
import { ulid } from 'ulid';

export const CORRELATION_HEADER = 'X-Correlation-ID';

export async function correlationMiddleware(c: Context, next: Next): Promise<void> {
  // Use provided correlation ID or generate new one
  const correlationId =
    c.req.header(CORRELATION_HEADER) ||
    `api-${ulid().toLowerCase()}`;

  // Store in context for use in handlers
  c.set('correlationId', correlationId);

  // Include in response headers
  c.header(CORRELATION_HEADER, correlationId);

  await next();
}
