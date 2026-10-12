/**
 * Error Handler Middleware
 *
 * Global error handling with standardized error responses.
 */

import { Context, Next } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';

export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  WORKFLOW_NOT_FOUND: 'WORKFLOW_NOT_FOUND',
  EXECUTION_NOT_FOUND: 'EXECUTION_NOT_FOUND',
  ENVELOPE_NOT_FOUND: 'ENVELOPE_NOT_FOUND',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  INVALID_WORKFLOW: 'INVALID_WORKFLOW',
  IMPORT_ERROR: 'IMPORT_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // QF-MT WP4: flat-namespace webhook path owned by a different org.
  WEBHOOK_PATH_CONFLICT: 'WEBHOOK_PATH_CONFLICT',
  // STABILITY-AUDITS Fix 1: per-workflow admission control rejected a run —
  // WorkflowSettings.maxConcurrency already has this many runs in flight.
  MAX_CONCURRENCY_EXCEEDED: 'MAX_CONCURRENCY_EXCEEDED',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number = 500,
    public details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NotFoundError extends ApiError {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 404);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(ErrorCodes.VALIDATION_ERROR, message, 400, details);
    this.name = 'ValidationError';
  }
}

export function createErrorHandler() {
  return async (c: Context, next: Next): Promise<Response | void> => {
    try {
      await next();
    } catch (error) {
      return handleError(c, error);
    }
  };
}

export function handleError(c: Context, error: unknown): Response {
  const requestId = (c.get('correlationId') as string) || 'unknown';

  if (error instanceof ZodError) {
    // Zod v4 uses .issues, v3 uses .errors
    const issues = error.issues || (error as unknown as { errors: typeof error.issues }).errors || [];
    return c.json(
      {
        success: false,
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Validation failed',
          details: issues.map(e => ({
            path: e.path.join('.'),
            message: e.message,
          })),
          requestId,
        },
      },
      400
    );
  }

  if (error instanceof ApiError) {
    return c.json(
      {
        success: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId,
        },
      },
      error.status as ContentfulStatusCode
    );
  }

  // Generic error
  console.error('Unhandled error:', error);
  return c.json(
    {
      success: false,
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: process.env.NODE_ENV === 'production' ? 'An internal error occurred' : (error instanceof Error ? error.message : 'An internal error occurred'),
        requestId,
      },
    },
    500
  );
}

// Keep the old name for backward compatibility
export const errorHandler = createErrorHandler();
