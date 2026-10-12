/**
 * Authentication Middleware
 *
 * JWT verification using the same JWT_SECRET as QuoxCORE auth service.
 * Also supports service-to-service tokens via INTERNAL_SERVICE_KEY.
 */

import { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';
import { AuthUser } from '../types.js';

// Environment configuration — read lazily to allow runtime configuration
// and to make testing easier. No hardcoded fallback (the previous
// 'dev-secret-change-in-production' default was a security risk).
function getJwtSecret(): string {
  return process.env.JWT_SECRET || '';
}
function getInternalServiceKey(): string {
  return process.env.INTERNAL_SERVICE_KEY || '';
}

// Paths exempt from authentication
const PUBLIC_PATHS = ['/health', '/webhooks'];

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * Extract access_token from Cookie header (httpOnly cookie set by auth service)
 */
function extractCookieToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /(?:^|;\s*)access_token=([^\s;]+)/.exec(header);
  return match ? match[1] : null;
}

/**
 * Check if request is a service-to-service call using internal key
 */
function checkServiceKey(header: string | undefined): AuthUser | null {
  const serviceKey = getInternalServiceKey();
  if (!serviceKey || !header) return null;

  const token = extractBearerToken(header) || header;

  // Constant-time comparison to prevent timing attacks
  if (token.length !== serviceKey.length) return null;

  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ serviceKey.charCodeAt(i);
  }

  if (mismatch !== 0) return null;

  return {
    user_id: 'service:internal',
    type: 'service',
    role: 'admin',
  };
}

/**
 * Verify a JWT token using the shared secret
 */
function verifyJwt(token: string): AuthUser | null {
  const secret = getJwtSecret();
  if (!secret) {
    console.error('[Auth] JWT_SECRET not configured — refusing to verify tokens');
    return null;
  }

  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as Record<string, unknown>;

    if (!payload || typeof payload !== 'object') return null;

    return {
      user_id: (payload.user_id as string) || (payload.sub as string) || 'unknown',
      email: payload.email as string | undefined,
      org_id: payload.org_id as string | undefined,
      role: payload.role as string | undefined,
      type: 'access',
    };
  } catch {
    return null;
  }
}

/**
 * Authentication middleware for Hono.
 * Checks JWT token or internal service key.
 * Exempts public paths (e.g., /health).
 */
export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  // Allow public paths
  const path = c.req.path;
  if (PUBLIC_PATHS.some(p => path === p || path.startsWith(p + '/'))) {
    await next();
    return;
  }

  const authHeader = c.req.header('Authorization');
  const serviceKeyHeader = c.req.header('X-Service-Key');

  // Try service-to-service key first (from X-Service-Key header)
  const serviceUser = checkServiceKey(serviceKeyHeader);
  if (serviceUser) {
    c.set('user', serviceUser);
    await next();
    return;
  }

  // Try JWT from Authorization header or access_token cookie
  const token = extractBearerToken(authHeader) || extractCookieToken(c.req.header('Cookie'));
  if (!token) {
    return c.json(
      {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required. Provide a valid JWT token or service key.',
        },
      },
      401
    );
  }

  const user = verifyJwt(token);
  if (!user) {
    return c.json(
      {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired token.',
        },
      },
      401
    );
  }

  c.set('user', user);
  await next();
}
