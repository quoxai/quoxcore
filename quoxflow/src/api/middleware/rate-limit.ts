/**
 * Rate Limiting Middleware
 *
 * In-memory sliding window rate limiter for Hono.
 * Supports different limits per path prefix.
 */

import { Context, Next } from 'hono';

interface RateLimitConfig {
  /** Max requests per window */
  maxRequests: number;
  /** Window size in milliseconds */
  windowMs: number;
}

interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter(t => now - t < 60_000);
    if (entry.timestamps.length === 0) {
      store.delete(key);
    }
  }
}, 60_000).unref();

/**
 * Create rate limiting middleware with the given config
 */
export function rateLimiter(config: RateLimitConfig) {
  return async function rateLimitMiddleware(c: Context, next: Next): Promise<Response | void> {
    // Bypass for authenticated internal service-to-service calls. The shared
    // X-Service-Key already gates these; subjecting them to a per-IP request
    // budget designed for untrusted clients causes false 429s on legitimate
    // fanout (e.g. collector's per-agent profile sweep).
    const serviceKey = process.env.INTERNAL_SERVICE_KEY;
    if (serviceKey && c.req.header('X-Service-Key') === serviceKey) {
      await next();
      return;
    }

    // Key by remote IP. Only trust X-Forwarded-For if TRUST_PROXY is set,
    // since the header is trivially spoofed by direct clients.
    const trustProxy = process.env.TRUST_PROXY === 'true';
    const forwardedIp = trustProxy
      ? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
      : undefined;
    const ip = forwardedIp || c.req.header('X-Real-IP') || 'unknown';
    const key = `${ip}:${c.req.path}`;
    const now = Date.now();

    let entry = store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      store.set(key, entry);
    }

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter(t => now - t < config.windowMs);

    if (entry.timestamps.length >= config.maxRequests) {
      const retryAfter = Math.ceil((entry.timestamps[0] + config.windowMs - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json(
        {
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message: `Too many requests. Try again in ${retryAfter}s.`,
          },
        },
        429
      );
    }

    entry.timestamps.push(now);
    await next();
  };
}
