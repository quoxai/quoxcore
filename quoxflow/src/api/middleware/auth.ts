/**
 * Authentication Middleware
 *
 * JWT verification using the same JWT_SECRET as QuoxCORE auth service.
 * Also supports service-to-service tokens via INTERNAL_SERVICE_KEY.
 */

import { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';
import { AuthUser } from '../types.js';
import type { ApproverPrincipal } from '../../approval/approval-engine.js';

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
 * quoxflow#14: the same agent markers QuoxCORE's shared principal classifier uses
 * (services/shared/principal.cjs). Fail closed: any marker makes the token an agent, so a
 * resident identity token carrying an org role still never reads as a human.
 */
function isAgentClaims(payload: Record<string, unknown>): boolean {
  return !!(payload.agent_id || payload.actor_type === 'agent' || payload.actor_type === 'plugin'
    || payload.agent_ops || payload.attach_lease_id);
}

/**
 * quoxflow#14: the verified approver principal for org role groups. Only a JWT caller has one;
 * a service-key caller has no verified org role, so it can never satisfy org:admins / org:members.
 */
export function approverPrincipal(user: AuthUser | undefined): ApproverPrincipal | undefined {
  if (!user || user.type !== 'access') return undefined;
  return { userId: user.user_id, orgId: user.org_id, role: user.role, isAgent: user.isAgent !== false };
}

/**
 * Verify a JWT token using the shared secret
 */
/**
 * Audiences quoxflow accepts (RunActor slice 3, FND_01M597EWP89CFEGA3T0B9CFEGA part 2): EMPTY, default deny. A token
 * that names any audience (e.g. a collector per-turn tool credential, aud 'quox:tools-execute') was minted for another
 * service and is refused here; a future quoxflow audience is one reviewed entry.
 */
export const ACCEPTED_AUDIENCES: ReadonlySet<string> = new Set<string>();

function verifyJwt(token: string): AuthUser | null {
  const secret = getJwtSecret();
  if (!secret) {
    console.error('[Auth] JWT_SECRET not configured — refusing to verify tokens');
    return null;
  }

  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as Record<string, unknown>;

    if (!payload || typeof payload !== 'object') return null;
    // FND_01M597EWP89CFEGA3T0B9CFEGA: only an ACCESS token is a login. A refresh token (type 'refresh', same secret,
    // 7-day default) or any other typed token is refused, as the memory service does. No type claim = legacy access.
    if (payload.type !== undefined && payload.type !== 'access') return null;
    if (payload.aud !== undefined) {
      const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!auds.every((a) => typeof a === 'string' && ACCEPTED_AUDIENCES.has(a))) return null;
    }

    return {
      user_id: (payload.user_id as string) || (payload.sub as string) || 'unknown',
      email: payload.email as string | undefined,
      org_id: payload.org_id as string | undefined,
      role: payload.role as string | undefined,
      type: 'access',
      isAgent: isAgentClaims(payload),
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
